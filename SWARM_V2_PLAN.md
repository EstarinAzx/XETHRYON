# Swarm v2: SQLite Task Board + System Prompt Transforms

> **Goal:** Adopt the two features that `opencode-ensemble` does better than Xethryon — SQLite-backed state and dynamic system prompt injection — while keeping our native integration advantages (direct `SessionPrompt.prompt()`, autonomy bypass, dependency chains, any-to-any messaging).

---

## Phase 1: SQLite Task Board

### Why
The current JSON file + file lock approach (`tasks-board.ts`, `mailbox.ts`, `team.ts`) works for 2-3 agents but has real concurrency risks at scale:
- File locks can deadlock under heavy concurrent writes
- No atomic multi-row updates (e.g., "mark task done AND send message" isn't transactional)
- No query capability — to find "all pending tasks for agent X" you read the entire file

### What Changes

#### [NEW] `packages/opencode/src/xethryon/swarm/db.ts`
SQLite database manager for swarm state. One DB per team at `.opencode/swarm/{team}/board.db`.

**Schema:**
```sql
CREATE TABLE team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lead_session_id TEXT,
  status TEXT DEFAULT 'active',  -- active | completed | failed
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE teammate (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  session_id TEXT,
  status TEXT DEFAULT 'spawning',  -- spawning | active | done | failed | stopped
  task_subject TEXT,
  task_description TEXT,
  files_written TEXT,  -- JSON array
  notes TEXT,          -- JSON array
  created_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  subject TEXT NOT NULL,
  description TEXT,
  owner TEXT,           -- teammate name
  status TEXT DEFAULT 'pending',  -- pending | active | completed | failed | blocked
  blocked_by TEXT,      -- JSON array of task IDs
  result TEXT,
  files_written TEXT,   -- JSON array
  created_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES team(id),
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,   -- 'lead' for coordinator, or teammate name
  content TEXT NOT NULL,
  delivered INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);
```

**API (exported functions):**
```ts
// Team
createTeam(name: string, leadSessionId: string): Team
getTeam(name: string): Team | null
updateTeamStatus(name: string, status: string): void

// Teammates
addTeammate(teamName: string, config: TeammateConfig): void
updateTeammateStatus(name: string, status: string, result?: object): void
getTeammates(teamName: string): Teammate[]

// Tasks
createTask(teamName: string, task: TaskInput): Task
updateTask(taskId: string, updates: Partial<Task>): void
listTasks(teamName: string, filter?: { status?: string; owner?: string }): Task[]
getBlockedTasks(teamName: string): Task[]  -- tasks whose blockers are all done
unblockReadyTasks(teamName: string): Task[]  -- auto-transition blocked → pending

// Messages
sendMessage(teamName: string, from: string, to: string, content: string): void
getUndelivered(teamName: string, to: string): Message[]
markDelivered(messageIds: number[]): void
```

#### [MODIFY] `packages/opencode/src/xethryon/swarm/tasks-board.ts`
- Replace JSON file operations with calls to `db.ts`
- Keep the same external API so tools don't need to change
- Delete file lock usage

#### [MODIFY] `packages/opencode/src/xethryon/swarm/mailbox.ts`
- Replace JSON inbox files with `message` table queries
- `writeToMailbox()` → `sendMessage()` in db
- `readMailbox()` → `getUndelivered()` + `markDelivered()`
- Delete file lock usage

#### [MODIFY] `packages/opencode/src/xethryon/swarm/team.ts`
- Replace `config.json` read/write with `team` + `teammate` table queries
- Keep `readTeamFileAsync()` API but back it with SQLite
- `leadSessionId` now lives in the `team` table

#### [DELETE candidates] (after migration)
- `packages/opencode/src/xethryon/swarm/lock.ts` — no longer needed
- JSON file creation logic in `paths.ts` — simplify to just ensure DB directory exists

#### Tools that need NO changes (they call the same API)
- `team_create.ts`, `task_create.ts`, `task_get.ts`, `task_update.ts`, `task_list.ts`, `task_stop.ts`, `send_message.ts`, `team_delete.ts`

> [!IMPORTANT]
> Bun has built-in SQLite (`bun:sqlite`) — no npm dependency needed. The compiled binary already supports it.

---

## Phase 2: System Prompt Transforms

### Why
Currently, swarm updates are injected as **user messages** via `SessionPrompt.prompt()`. This works but:
- Each `[SWARM UPDATE]` eats context window (tokens)
- The coordinator doesn't inherently "know" it's leading a team until a message arrives
- After context compaction, the coordinator may forget it has a team

System prompt transforms inject team state **into the system prompt itself** — zero context cost, always present, survives compaction.

### What Changes

#### [NEW] `packages/opencode/src/xethryon/swarm/prompt-transform.ts`
A function that generates a system prompt appendix based on current team state.

```ts
export function getSwarmSystemPromptBlock(sessionId: string): string | null {
  // Check if this session is a team lead
  const team = findTeamByLeadSession(sessionId)
  if (!team) return null

  const teammates = getTeammates(team.name)
  const tasks = listTasks(team.name)
  const undelivered = getUndelivered(team.name, 'lead')

  return `
## Active Swarm Team: ${team.name}

### Teammates
${teammates.map(t => `- **${t.name}** (${t.agent_type}): ${t.status}`).join('\n')}

### Task Board
${tasks.map(t => `- [${t.status}] ${t.subject} → ${t.owner ?? 'unassigned'}`).join('\n')}

### Pending Messages (${undelivered.length})
${undelivered.length > 0 ? 'Call team_await to read them.' : 'No new messages.'}

### Your Role
You are the team COORDINATOR. Use team_await to check progress, task_create to assign new work, and send_message to communicate with teammates.
`
}
```

#### [MODIFY] `packages/opencode/src/session/prompt.ts`
In the system prompt construction (where memory, git context, and autonomy prompts are assembled), add a call to `getSwarmSystemPromptBlock()`:

```ts
// After existing system prompt assembly...
const swarmBlock = getSwarmSystemPromptBlock(sessionId)
if (swarmBlock) {
  systemPrompt += '\n\n' + swarmBlock
}
```

> [!NOTE]
> This is the same pattern the ensemble plugin uses — they call it "system prompt transform" and register it via the SDK's `systemPromptTransform` hook. Since we're native, we can just call the function directly in `prompt.ts`.

#### [MODIFY] `packages/opencode/src/xethryon/swarm/events.ts`
Keep the auto-inject for **wake-up** purposes (the coordinator needs a message to trigger a new turn), but make it minimal:

```ts
// Instead of a detailed [SWARM UPDATE] message, just nudge:
const text = allDone
  ? "[SWARM] All tasks complete. Check your team status and summarize."
  : "[SWARM] Team activity detected. Check your team status."
```

The detailed state is now in the system prompt — the injection just needs to wake the coordinator up, not carry the full payload.

---

## Phase 3: Session Status Tracking (Optional / Stretch)

### Why
Ensemble subscribes to real-time session status events to know when teammates go idle/busy/rate-limited. We currently infer status from task completion only.

### What Changes

#### [MODIFY] `packages/opencode/src/xethryon/swarm/events.ts`
Subscribe to OpenCode's session status bus (if available) to track teammate session states:

```ts
// Subscribe to session status changes
Bus.subscribe(Session.Event.Status, (evt) => {
  const teammate = findTeammateBySession(evt.sessionID)
  if (!teammate) return
  
  if (evt.status === 'idle') {
    updateTeammateStatus(teammate.name, 'done')
  } else if (evt.status === 'rate_limited') {
    // Show toast or log warning
  }
})
```

This is lower priority — the current task completion events work fine for now.

---

## Implementation Order

```
Phase 1: SQLite Task Board
├── 1.1 Create db.ts with schema + API
├── 1.2 Migrate tasks-board.ts to use db.ts
├── 1.3 Migrate mailbox.ts to use db.ts  
├── 1.4 Migrate team.ts to use db.ts
├── 1.5 Test: run a 2-task swarm, verify DB state
└── 1.6 Clean up: remove lock.ts, simplify paths.ts

Phase 2: System Prompt Transforms
├── 2.1 Create prompt-transform.ts
├── 2.2 Wire into prompt.ts system prompt assembly
├── 2.3 Slim down events.ts injection message
└── 2.4 Test: verify coordinator "knows" it has a team from turn 1

Phase 3: Status Tracking (stretch)
├── 3.1 Subscribe to session status events
├── 3.2 Update teammate status in real-time
└── 3.3 Test: verify rate-limit detection
```

## Estimated Effort
- **Phase 1:** ~2-3 hours (mostly mechanical — swap storage layer, keep same API)
- **Phase 2:** ~1-2 hours (small, surgical change in prompt.ts)
- **Phase 3:** ~1 hour (if the Bus/Event API is accessible)

## Verification Plan

### Automated
- Run a 3-task swarm with dependencies: task A (no deps), task B (blocked by A), task C (blocked by B)
- Verify: SQLite has correct state at each stage
- Verify: system prompt shows team context on every coordinator turn
- Verify: auto-inject still wakes coordinator

### Manual
- Check `.opencode/swarm/{team}/board.db` with `sqlite3` CLI
- Confirm context window usage is lower (system prompt vs user messages)
- Confirm compaction doesn't lose team awareness

## Open Questions

> [!IMPORTANT]
> **Should `board.db` be per-team or per-project?** Per-team is simpler (one DB per swarm run). Per-project means one DB with all historical team data — useful for analytics but more complex schema.

> [!IMPORTANT] 
> **Should we keep JSON file fallback?** During migration, it might be useful to support both backends. Or do a clean cut — SQLite only, no fallback.

> [!NOTE]
> **The `bun:sqlite` import** — verify this works in the compiled binary. Bun bundles SQLite natively, but worth a smoke test before going all-in.
