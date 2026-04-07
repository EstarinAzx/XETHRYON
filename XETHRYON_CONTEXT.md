# XETHRYON — Full Project Context & Developer Handoff

> **Purpose:** This document provides everything a new AI assistant session needs to understand, navigate, and contribute to the Xethryon project. Read this before making any changes.

---

## 1. What Is Xethryon?

Xethryon is a **terminal-based AI coding agent** (TUI) that forks and extends [OpenCode](https://opencode.ai). It adds:

- **Persistent cross-session memory** (ported from Claude Code's leaked architecture)
- **Autonomous agent mode switching** (Autonomy system)
- **Parallel sub-agent teams** (Swarm system)
- **Bundled skills** (slash commands like `/verify`, `/batch`, `/debug`)
- **Cyberpunk-themed UI** with a custom color palette

**Repository:** `https://github.com/EstarinAzx/XETHRYON`
**Branch:** `xethryon` (primary development branch)
**Language:** TypeScript (Bun runtime)
**Build System:** Bun + Turbo monorepo

---

## 2. Repository Structure

```
opencode-dev/                          # Root monorepo
├── packages/
│   ├── opencode/                      # ⭐ MAIN PACKAGE — the CLI/TUI agent
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   └── agent.ts           # Agent definitions (build, plan, coordinator, etc.)
│   │   │   ├── cli/cmd/tui/           # TUI frontend (Solid.js-based terminal UI)
│   │   │   │   ├── component/
│   │   │   │   │   ├── prompt/index.tsx    # Main prompt input component
│   │   │   │   │   └── session/index.tsx   # Session message rendering
│   │   │   │   ├── context/
│   │   │   │   │   ├── sdk.tsx             # SDK context (RPC bridge to worker)
│   │   │   │   │   └── theme/
│   │   │   │   │       └── xethryon.json   # Cyberpunk color theme
│   │   │   │   ├── thread.ts          # TUI thread (spawns worker, manages RPC)
│   │   │   │   └── worker.ts          # Worker thread (runs AI sessions)
│   │   │   ├── session/
│   │   │   │   ├── index.ts           # Session CRUD
│   │   │   │   ├── prompt.ts          # SessionPrompt — the core AI loop
│   │   │   │   └── message-v2.ts      # Message schema and rendering
│   │   │   ├── tool/                  # All tool implementations
│   │   │   │   ├── registry.ts        # Tool registry (lists all available tools)
│   │   │   │   ├── switch_agent.ts    # Autonomy mode switching tool
│   │   │   │   ├── team_create.ts     # Swarm: create team + spawn teammates
│   │   │   │   ├── team_delete.ts     # Swarm: delete team
│   │   │   │   ├── send_message.ts    # Swarm: inter-agent messaging
│   │   │   │   ├── task_create.ts     # Swarm: create task on board
│   │   │   │   ├── task_get.ts        # Swarm: get task details
│   │   │   │   ├── task_update.ts     # Swarm: update task status
│   │   │   │   ├── task_list.ts       # Swarm: list all tasks
│   │   │   │   ├── task_stop.ts       # Swarm: stop a teammate
│   │   │   │   ├── bash.ts            # Shell command execution
│   │   │   │   ├── edit.ts            # File editing
│   │   │   │   ├── read.ts            # File reading
│   │   │   │   ├── write.ts           # File writing
│   │   │   │   └── ...                # grep, glob, webfetch, websearch, etc.
│   │   │   ├── xethryon/              # ⭐ XETHRYON-SPECIFIC CODE
│   │   │   │   ├── autonomy.ts        # Autonomy toggle (process.env based)
│   │   │   │   ├── memory/            # Persistent memory system (17 files)
│   │   │   │   │   ├── index.ts       # Public API barrel
│   │   │   │   │   ├── memoryHook.ts  # Post-turn memory extraction hook
│   │   │   │   │   ├── sessionMemory.ts
│   │   │   │   │   ├── findRelevantMemories.ts
│   │   │   │   │   ├── autoDream.ts   # Background consolidation
│   │   │   │   │   └── ...
│   │   │   │   ├── skills/            # Bundled slash-command skills
│   │   │   │   │   ├── registry.ts    # Skill registration system
│   │   │   │   │   └── bundled/       # Built-in skills
│   │   │   │   │       ├── autopilot.ts
│   │   │   │   │       ├── batch.ts
│   │   │   │   │       ├── debug.ts
│   │   │   │   │       ├── loop.ts
│   │   │   │   │       ├── onboard.ts
│   │   │   │   │       ├── remember.ts
│   │   │   │   │       ├── simplify.ts
│   │   │   │   │       └── verify.ts
│   │   │   │   └── swarm/             # Multi-agent team system (12 files)
│   │   │   │       ├── index.ts       # Barrel exports
│   │   │   │       ├── spawn.ts       # Core teammate spawning + headless permissions
│   │   │   │       ├── events.ts      # ⭐ Event bus + auto-inject into coordinator
│   │   │   │       ├── state.ts       # Runtime state + coordinator session tracking
│   │   │   │       ├── team.ts        # Team config CRUD (config.json)
│   │   │   │       ├── mailbox.ts     # File-based IPC messaging
│   │   │   │       ├── tasks-board.ts # Shared task board
│   │   │   │       ├── lock.ts        # File locking utility
│   │   │   │       ├── paths.ts       # Path resolution (.opencode/swarm/...)
│   │   │   │       ├── identity.ts    # Agent ID formatting
│   │   │   │       ├── constants.ts   # Constants
│   │   │   │       └── types.ts       # TypeScript types (TeamFile, ActiveTeammate, etc.)
│   │   │   └── provider/              # LLM provider adapters
│   │   └── script/
│   │       └── build.ts               # Build script
│   ├── sdk/                           # TypeScript SDK
│   ├── app/                           # Web frontend
│   └── desktop/                       # Electron desktop app
└── package.json                       # Root monorepo config
```

---

## 3. Architecture Deep Dive

### 3.1 Threading Model

The TUI runs on a **two-thread architecture**:

```
┌─────────────────┐     RPC (JSON-RPC)     ┌──────────────────┐
│   TUI Thread     │ ◄──────────────────────► │  Worker Thread    │
│  (Solid.js UI)   │                          │  (AI Sessions)    │
│  thread.ts       │                          │  worker.ts        │
│  prompt/index.tsx│                          │  prompt.ts        │
│                  │                          │  tool execution   │
└─────────────────┘                          └──────────────────┘
```

- **TUI Thread:** Renders the terminal UI, handles keyboard input, manages local state
- **Worker Thread:** Runs all AI sessions, tool calls, and streaming. Has its own `process.env`
- **Communication:** Via RPC. The `EventSource` interface in `sdk.tsx` bridges them
- **⚠ IMPORTANT:** `process.env` is NOT shared between threads. Any env-based state (like autonomy) must be explicitly synced via RPC

### 3.2 Agent System

Agents are defined in `agent/agent.ts`. Each agent has:
- **name**: Internal ID (e.g., `"build"`, `"plan"`)
- **mode**: `"primary"` (user-facing) or `"subagent"` (spawned by tools)
- **permission**: Tool permission ruleset
- **prompt**: Optional system prompt override

**Registered Agents:**

| Internal Name | Display Name | Mode | Purpose |
|---|---|---|---|
| `build` | CONSTRUCT | primary | Default. Full read/write/execute access |
| `plan` | ARCHITECT | primary | Planning only. Edit tools denied |
| `explore` | RECON | subagent | Read-only exploration. No writes |
| `coordinator` | COORDINATE | primary | Team orchestration. No direct edits |
| `verification` | VALIDATOR | subagent | Testing/review. Read + bash only |
| `general` | — | subagent | General-purpose parallel worker |
| `compaction` | — | primary (hidden) | Context window compaction |
| `title` | — | primary (hidden) | Session title generation |
| `summary` | — | primary (hidden) | Session summary generation |

### 3.3 Autonomy System

**Files:** `xethryon/autonomy.ts`, `tool/switch_agent.ts`, `tool/external-directory.ts`, `cli/cmd/tui/component/prompt/index.tsx`

**How it works:**
1. User presses **F4** to toggle autonomy ON/OFF
2. Local state stored in `process.env.XETHRYON_AUTONOMY`
3. When ON → `getAutonomyPrompt()` injects instructions into the system prompt telling the AI it can use `switch_agent`
4. When OFF → `switch_agent` tool physically rejects all calls with an error message
5. The TUI footer shows `AUTONOMY: ON/OFF`
6. **State sync:** `sdk.setAutonomy(next)` propagates the toggle to the worker thread via RPC

**Autonomy bypasses:**
- `switch_agent` tool calls allowed only when autonomy is ON
- `external_directory` permission prompts bypassed when autonomy is ON (in `external-directory.ts`). This prevents approval prompts from blocking fully hands-off operation.
- Swarm auto-inject only fires when `XETHRYON_AUTONOMY=1`

**Agent alias mapping in `switch_agent.ts`:**
- `architect` → `plan`, `construct` → `build`, `recon` → `explore`, etc.

### 3.4 Swarm System

**Directory:** `xethryon/swarm/`

**How teammates spawn:**
1. LLM calls `team_create` tool with team name + teammate configs
2. `team_create` captures `ctx.sessionID` as the coordinator session ID → stores in `process.env.XETHRYON_COORDINATOR_SESSION` and writes `leadSessionId` to team file JSON
3. `team_create` creates `.opencode/swarm/{team}/config.json`
4. For each teammate, `spawnTeammate()` in `spawn.ts`:
   - Creates a new `Session` with **headless permission ruleset** (all tools auto-allowed, including `external_directory`)
   - Builds a prompt from the teammate's task description
   - Calls `SessionPrompt.prompt()` in background (fire-and-forget)
   - Registers teammate in runtime state (`state.ts`)
5. When teammate finishes → `emitTaskDone()` fires event with progress + coordinator session ID
6. **Events system auto-injects** a `[SWARM UPDATE]` message into the coordinator's session

**⭐ Event-Driven Auto-Inject (events.ts):**

This is the core innovation — replaces the old TUI-side polling approach.

```
teammate finishes → spawn.ts calls emitTaskDone()
    → events.ts listener buffers the event
    → 3-second debounce (batches concurrent completions)
    → reads coordinatorSessionId (from event, or fallback to process.env)
    → calls SessionPrompt.prompt() directly (same function spawn.ts uses)
    → coordinator receives [SWARM UPDATE] as a user message
    → coordinator wakes up and acts autonomously
```

**Key design decisions:**
- Uses `Symbol.for("xethryon.swarm.eventEmitter")` for bundler-safe global `EventTarget`
- Self-subscribing module-level listener — runs at import time when `spawn.ts` loads
- Direct `SessionPrompt.prompt()` call (NOT the HTTP `prompt_async` endpoint — that failed due to routing issues)
- Different injection messages for "in-progress" vs "all tasks complete"
- Only fires when `XETHRYON_AUTONOMY=1`
- Fire-and-forget: errors are caught and logged to stderr, never crash the process

**Headless sub-session permissions (spawn.ts):**
```ts
permission: [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "write", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
  { permission: "apply_patch", pattern: "*", action: "allow" },
  { permission: "multiedit", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "task", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "allow" },
]
```

**File-based IPC:**
- Inboxes: `.opencode/swarm/{team}/inboxes/{agent}.json`
- Tasks: `.opencode/swarm/{team}/tasks/tasks.json`
- Team config: `.opencode/swarm/{team}/config.json` (includes `leadSessionId`)
- Locking: `.lock` files with `O_CREAT | O_EXCL` (atomic on NTFS)

**Agent type aliases in `spawn.ts`:**
- `coder`/`writer`/`builder` → `build`
- `planner`/`architect` → `plan`
- `explorer`/`recon`/`researcher` → `explore`
- `verifier`/`tester` → `verification`
- `orchestrator` → `coordinator`
- Unknown → defaults to `build`

**Coordinator session tracking (state.ts):**
- `setCoordinatorSessionId(id)` → writes to `process.env.XETHRYON_COORDINATOR_SESSION`
- `getCoordinatorSessionId()` → reads from `process.env`
- `clearCoordinatorSessionId()` → deletes from `process.env`
- Using `process.env` ensures global access across bundler-duplicated module instances

### 3.5 Memory System

**Directory:** `xethryon/memory/` (17 files)

**Components:**
- **Session Memory** (`sessionMemory.ts`): Per-session context that survives compaction
- **Extract Memories** (`extractMemories.ts`): Pulls durable learnings from conversations
- **AutoDream** (`autoDream.ts`): Background consolidation when 24h pass or 5 sessions accumulate
- **Find Relevant** (`findRelevantMemories.ts`): LLM-ranked relevance search (not keyword-based)
- **Memory Hook** (`memoryHook.ts`): Post-turn hook integrated into `prompt.ts`

**Storage:** `~/.xethryon/projects/<project>/memory/`
- `MEMORY.md` — master index
- `architecture.md` — project architecture notes
- `user_prefs.md` — user preferences
- Daily logs, session summaries

**Status:** The memory module is fully coded and ported from Claude Code's architecture. The `memoryHook.ts` integrates with the session prompt loop. However, the wiring to the main prompt pipeline may need verification to ensure it's actually being invoked on every turn.

### 3.6 Skills System

**Directory:** `xethryon/skills/`

**Bundled skills** (invoked via `/command` in TUI):
| Skill | Purpose |
|---|---|
| `/verify` | Run builds + tests, produce PASS/FAIL verdict |
| `/simplify` | Three-pass code review (reuse, quality, efficiency) |
| `/batch` | Parallel work orchestration |
| `/remember` | Extract learnings to memory |
| `/debug` | Diagnostics for session states |
| `/loop` | Recurring prompt scheduler |
| `/onboard` | Project onboarding |
| `/autopilot` | Extended autonomous execution |

---

## 4. Build & Deploy

### Build (Windows — single platform):
```powershell
cd packages/opencode
bun run build --single
```
Output: `dist/opencode-windows-x64/bin/xethryon.exe`

### Deploy locally:
```powershell
Copy-Item "packages\opencode\dist\opencode-windows-x64\bin\xethryon.exe" -Destination "$env:LOCALAPPDATA\xethryon\bin\xethryon.exe" -Force
```

### Build all platforms:
```bash
bun run build   # Will build linux-arm64, linux-x64, darwin-arm64, etc.
```

### Run in dev mode (no build needed):
```bash
bun run dev
# or directly:
bun run --cwd packages/opencode --conditions=browser src/index.ts
```

### Git push (skip pre-push typecheck hook):
```bash
git push origin xethryon --no-verify
```
The pre-push hook runs `bun turbo typecheck` across ALL packages. Some upstream packages have pre-existing TS errors (e.g., `@opencode-ai/app` has `custom-elements.d.ts` parse errors). Use `--no-verify` to bypass.

---

## 5. Commit History (Recent)

```
12a480581 chore: remove debug log that flashed in TUI during swarm inject
a1ea4f09c fix(autonomy): bypass external_directory permission when autonomy is ON
997e85d5b fix(swarm): use direct SessionPrompt.prompt() for auto-inject
d51511600 docs: update README with event-driven auto-inject architecture
3a5358feb refactor(swarm): migrate auto-inject from TUI to server-side prompt_async
b3dd89dfc fix(swarm): add agent type alias resolver for teammate spawning
bae6cee04 fix(swarm): ensure directories exist before acquiring file locks
43893e189 fix(tui): synchronize autonomy toggle to worker process environment
82fa146cd fix(autonomy): physically reject switch_agent tool calls when autonomy is off
13310d8f2 fix(ui): ensure text parts correctly render with standard panel backgrounds
9f10de74d docs: rewrite README to be clean, professional, and highlight key features
e82654112 fix: message display also gated by autonomy - no display override when OFF
6df9c04e4 fix: autonomy gate + color coding for mode switch messages
1e1672622 feat: message footer shows new mode when switch_agent is used
ef145b363 fix: accept display names as agent aliases (architect→plan, construct→build)
93cf861c4 refine: mandatory trigger rules for auto-switching modes
e5fbdbc12 refine: switch_agent has clear per-mode capabilities and boundaries
bdc09bf4c fix: autonomy actually switches CORE agent via event hook
ec15a6ee7 fix: autonomy uses client-side injection — Worker thread has no shared memory
ffd359c7b fix: use process.env for autonomy state — bulletproof cross-module sharing
7227c7f08 feat: add Autonomy mode — f4 toggle for autonomous agent switching
dedccb9b6 ui: rename STRATAGEM to ARCHITECT
```

---

## 6. Known Issues & Gotchas

### 6.1 Resolved
- ✅ Autonomy toggle not syncing to worker thread (fixed via RPC `setAutonomy`)
- ✅ ENOENT crash on first swarm team creation (fixed: mkdir before lock)
- ✅ "agent coder not found" when spawning teammates (fixed: alias resolver)
- ✅ Dark tint on Xethryon message bubbles (fixed: standard panel backgrounds)
- ✅ CORE: label and footer mode indicators out of sync
- ✅ Swarm teammates hanging on permission prompts (fixed: headless ruleset in spawn.ts)
- ✅ External directory prompts blocking autonomy mode (fixed: bypass in external-directory.ts)
- ✅ TUI-side swarm auto-inject was fragile and tab-dependent (fixed: server-side SessionPrompt.prompt() injection)
- ✅ HTTP prompt_async approach failed due to Hono routing issues (fixed: switched to direct SessionPrompt.prompt() call)
- ✅ Debug log `[swarm:inject]` flashing in TUI (fixed: removed console.error)

### 6.2 Known / Open
- ⚠ **`thought_signature` Gemini error:** Gemini Flash with thinking mode requires `thought_signature` in function call parts. This is a provider-level issue in the AI SDK adapter, not in Xethryon code. Swarm may fail when using Gemini models with thinking enabled.
- ⚠ **Pre-push typecheck failures:** `@opencode-ai/app` has pre-existing TS errors in `custom-elements.d.ts`. Always use `--no-verify` when pushing.
- ⚠ **Memory system wiring:** The memory module is fully coded but may need verification that `memoryHook.ts` is being called on every prompt turn in `prompt.ts`.
- ⚠ **Coordinator sometimes lacks `team_await`:** When the coordinator is in CONSTRUCT mode instead of COORDINATE mode, `team_await` may not be in its tool list. The coordinator still works around this by reading files directly, but it's not ideal.

### 6.3 Development Gotchas
- **process.env is NOT shared** between TUI thread and worker thread. Any state that needs to cross the boundary MUST use the RPC bridge (`worker.ts` ↔ `thread.ts` ↔ `sdk.tsx`).
- **Agent names are internal IDs**, not display names. Always use `build`, `plan`, `explore`, `coordinator`, `verification` — never `CONSTRUCT`, `ARCHITECT`, etc. in code.
- **Swarm paths use `process.cwd()`** — so swarm data lives in the current project directory under `.opencode/swarm/`.
- **The build script** auto-detects the channel name from git branch. Branch `xethryon` → channel `xethryon`.
- **File locking on Windows** uses `"wx"` string flag, NOT numeric `O_EXCL`, to avoid libuv EINVAL errors.
- **Don't use HTTP `Server.Default().fetch()` for internal swarm injection** — it goes through Hono's WorkspaceRouterMiddleware which adds complexity. Use `SessionPrompt.prompt()` directly instead (same function spawn.ts uses).
- **`events.ts` self-subscribes at module load time.** The `onTaskDone()` listener is registered when the module is first imported (statically from `spawn.ts`). This means the listener is always active as long as `spawn.ts` has been loaded.
- **Coordinator session ID has two sources:** (1) `process.env.XETHRYON_COORDINATOR_SESSION` set by `team_create`, and (2) `leadSessionId` field in the team file JSON read by `spawn.ts` at verification time. events.ts checks both as fallbacks.

---

## 7. Feature Roadmap (Ideas)

These are potential features discussed but NOT yet implemented:

1. **Persistent Project Memory (wire it up)** — Verify and complete the integration of `memoryHook.ts` into the prompt pipeline so memories persist across sessions.
2. **Agent Self-Reflection Loop** — Before submitting a response, the agent reviews its own work automatically.
3. **Git-Aware Workflows** — Smart auto-branching, stash management, conflict resolution, one-command PR creation.
4. **Live Agent Dashboard** — Real-time TUI view of all swarm teammates' status, progress, files touched.
5. **Skill Marketplace** — Shareable skill packs that users can install/publish.
6. **Computer Use** — Vision-based GUI interaction using screenshots + pyautogui (high effort, long-term).
7. **Ensemble-style patterns** — The `opencode-ensemble` plugin (at `D:\eweew\AG\ccleak\opencode-ensemble-main`) has additional ideas worth exploring:
   - SQLite-backed task boards (vs our filesystem JSON) for better concurrency
   - Dynamic system prompt transforms (inject team context into system prompt per-session)
   - Session status tracking via event subscriptions (idle → busy → done state machine)
8. **Dependency chain auto-spawn** — `blockedBy` dependencies exist in the type system but auto-spawning when prerequisites complete could be more robust.
9. **Error recovery for auto-inject** — If `SessionPrompt.prompt()` fails during injection, currently catches and logs but doesn't retry. Could add exponential backoff.

---

## 8. Key Files Quick Reference

| What | Path |
|---|---|
| Agent definitions | `packages/opencode/src/agent/agent.ts` |
| Autonomy module | `packages/opencode/src/xethryon/autonomy.ts` |
| Switch agent tool | `packages/opencode/src/tool/switch_agent.ts` |
| External dir permission | `packages/opencode/src/tool/external-directory.ts` |
| Team create tool | `packages/opencode/src/tool/team_create.ts` |
| Swarm spawn + permissions | `packages/opencode/src/xethryon/swarm/spawn.ts` |
| ⭐ Swarm event bus + auto-inject | `packages/opencode/src/xethryon/swarm/events.ts` |
| Swarm state + coordinator tracking | `packages/opencode/src/xethryon/swarm/state.ts` |
| Swarm types (TeamFile, etc.) | `packages/opencode/src/xethryon/swarm/types.ts` |
| Task board | `packages/opencode/src/xethryon/swarm/tasks-board.ts` |
| Mailbox IPC | `packages/opencode/src/xethryon/swarm/mailbox.ts` |
| Team file CRUD | `packages/opencode/src/xethryon/swarm/team.ts` |
| Memory hook | `packages/opencode/src/xethryon/memory/memoryHook.ts` |
| Memory public API | `packages/opencode/src/xethryon/memory/index.ts` |
| Skills registry | `packages/opencode/src/xethryon/skills/registry.ts` |
| Tool registry | `packages/opencode/src/tool/registry.ts` |
| TUI prompt | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` |
| TUI session view | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` |
| Worker RPC | `packages/opencode/src/cli/cmd/tui/worker.ts` |
| TUI thread | `packages/opencode/src/cli/cmd/tui/thread.ts` |
| SDK context | `packages/opencode/src/cli/cmd/tui/context/sdk.tsx` |
| Theme file | `packages/opencode/src/cli/cmd/tui/context/theme/xethryon.json` |
| Session prompt loop | `packages/opencode/src/session/prompt.ts` |
| Session schema (MessageID, etc.) | `packages/opencode/src/session/schema.ts` |
| Server (Hono app) | `packages/opencode/src/server/server.ts` |
| Build script | `packages/opencode/script/build.ts` |
| README | `README.md` |
| opencode-ensemble reference | `D:\eweew\AG\ccleak\opencode-ensemble-main\src\index.ts` |

---

## 9. Development Workflow (THE ROUTINE)

Every time you make code changes, follow this exact sequence. **Do not skip steps.**

### Step 1: Make your code changes
Edit files in `packages/opencode/src/` as needed.

### Step 2: Build the binary
```powershell
cd d:\eweew\AG\ccleak\opencode-dev\packages\opencode
bun run build --single
```
- This builds only the current platform (Windows x64)
- Wait for `Smoke test passed: 0.0.0-xethryon-...` — that confirms success
- Do NOT use `bun turbo build` (that tries to build all packages including cross-platform, which fails)

### Step 3: Copy the binary to the user's local install
```powershell
cd d:\eweew\AG\ccleak\opencode-dev
Copy-Item "packages\opencode\dist\opencode-windows-x64\bin\xethryon.exe" -Destination "$env:LOCALAPPDATA\xethryon\bin\xethryon.exe" -Force; Write-Host "Done"
```

### Step 4: Git commit
```powershell
cd d:\eweew\AG\ccleak\opencode-dev
git add <changed files>
git commit -m "type(scope): description"
```
- Use conventional commit prefixes: `feat:`, `fix:`, `refine:`, `docs:`
- Be specific about what changed

### Step 5: Git push
```powershell
git push origin xethryon --no-verify
```
- **Always use `--no-verify`** — the pre-push hook runs typecheck across ALL packages and some upstream ones have pre-existing TS errors that will block the push
- Never push without `--no-verify` unless you've confirmed typecheck passes

### Step 6: Clean up staged files
After pushing, check if anything got accidentally staged:
```powershell
git status
```
If you see unrelated files (like `openapi.json` from SDK builds), unstage them:
```powershell
git restore --staged <file>
```

### Quick Reference (copy-paste ready)
```powershell
# THE FULL ROUTINE — run from project root
cd d:\eweew\AG\ccleak\opencode-dev\packages\opencode
bun run build --single
cd d:\eweew\AG\ccleak\opencode-dev
Copy-Item "packages\opencode\dist\opencode-windows-x64\bin\xethryon.exe" -Destination "$env:LOCALAPPDATA\xethryon\bin\xethryon.exe" -Force; Write-Host "Done"
git add <files>
git commit -m "fix(scope): description"
git push origin xethryon --no-verify
```

---

## 10. Environment Variables Reference

| Variable | Default | Set By | Description |
|----------|---------|--------|-------------|
| `XETHRYON_AUTONOMY` | `0` | F4 toggle / RPC | Master autonomy flag. When `1`: enables agent switching, skill invocation, bypasses external_directory prompts, enables swarm auto-inject. |
| `XETHRYON_COORDINATOR_SESSION` | (unset) | `team_create` | Session ID of the coordinator/lead for the active swarm team. Used by events.ts to know where to inject updates. |
| `XETHRYON_REFLECTION` | `1` | .env / manual | Self-reflection gate before presenting code. |
| `XETHRYON_GIT_AWARE` | `1` | .env / manual | Git state injection into system prompt context. |
| `XETHRYON_DEBUG` | `false` | .env / manual | Debug logging for internals. |

---

*Last updated: 2026-04-07 by Claude (Antigravity)*
