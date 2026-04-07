/**
 * Swarm system prompt transform.
 *
 * Builds a dynamic system prompt block injected into the coordinator's
 * session on every turn. This ensures the coordinator always knows:
 * - It's leading a team
 * - Who the teammates are and their status
 * - Current task board state
 * - Whether there are unread messages
 *
 * Inspired by opencode-ensemble's system-prompt.ts, but reads from
 * our existing JSON files (will swap to SQLite when Phase 1 lands).
 *
 * Returns null for non-coordinator sessions → zero overhead.
 */

import { getCoordinatorSessionId, getActiveTeam, getTeammatesForTeam } from "./state.js"
import { readTeamFileAsync } from "./team.js"
import { listTasks } from "./tasks-board.js"
import { readUnreadMessages } from "./mailbox.js"
import { TEAM_LEAD_NAME } from "./constants.js"
import type { Task, TaskStatus } from "./types.js"

// ---------------------------------------------------------------------------
// Status display mapping
// ---------------------------------------------------------------------------

const STATUS_DISPLAY: Record<string, string> = {
  running: "working",
  idle: "idle",
  stopped: "stopped",
}

const TASK_STATUS_EMOJI: Record<TaskStatus, string> = {
  pending: "○",
  blocked: "⊘",
  in_progress: "◐",
  verifying: "◑",
  completed: "●",
  failed: "✗",
  deleted: "—",
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the swarm system prompt block for a coordinator session.
 * Returns null if the session is NOT a coordinator.
 */
export async function getSwarmPromptBlock(sessionId: string): Promise<string | null> {
  // Quick exit: is this session the coordinator?
  const coordinatorId = getCoordinatorSessionId()
  if (!coordinatorId || coordinatorId !== sessionId) return null

  // Find the active team
  const teamName = getActiveTeam()
  if (!teamName) return null

  try {
    return await buildPromptBlock(teamName)
  } catch {
    // Swarm files may not exist yet — non-fatal
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function buildPromptBlock(teamName: string): Promise<string | null> {
  // Read team config
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) return null

  // Read runtime teammate state (in-memory, fast)
  const runtimeTeammates = getTeammatesForTeam(teamName)

  // Build member list — merge config members with runtime status
  const memberLines: string[] = []
  for (const member of teamFile.members) {
    const runtime = runtimeTeammates.find((t) => t.name === member.name)
    const status = runtime ? (STATUS_DISPLAY[runtime.status] ?? runtime.status) : "unknown"
    const agentType = member.agentType ?? "build"
    memberLines.push(`- **${member.name}** (${agentType}): ${status}`)
  }

  // Read task board
  const tasks = await listTasks(teamName)
  const activeTasks = tasks.filter((t) => t.status !== "deleted")
  const taskLines = activeTasks.map((t) => formatTaskLine(t))

  // Task summary counts
  const counts = countTaskStatuses(activeTasks)

  // Read unread message count for the lead
  const unread = await readUnreadMessages(TEAM_LEAD_NAME, teamName)
  const senderNames = [...new Set(unread.map((m) => m.from))]
  const messageLine = unread.length > 0
    ? `${unread.length} unread message${unread.length > 1 ? "s" : ""} from ${senderNames.join(", ")}`
    : "No new messages."

  // Assemble
  const lines = [
    `## Active Swarm Team: ${teamName}`,
    "",
    "### Teammates",
    memberLines.length > 0 ? memberLines.join("\n") : "No teammates spawned yet.",
    "",
    "### Task Board",
    `${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.blocked} blocked, ${counts.failed} failed`,
    ...(taskLines.length > 0 ? ["", ...taskLines] : []),
    "",
    `### Messages: ${messageLine}`,
    "",
    "### Your Role",
    "You are the team COORDINATOR. Use team_await to check progress and read messages, task_create to assign new work, and send_message to communicate with teammates.",
    "Teammates work asynchronously and notify you when done. Do NOT poll repeatedly — wait for notifications.",
  ]

  return lines.join("\n")
}

function formatTaskLine(task: Task): string {
  const emoji = TASK_STATUS_EMOJI[task.status] ?? "?"
  const owner = task.owner ?? "unassigned"
  const blocked = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(", ")})` : ""
  return `- ${emoji} [${task.status}] ${task.subject} → ${owner}${blocked}`
}

function countTaskStatuses(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {
    pending: 0,
    blocked: 0,
    in_progress: 0,
    verifying: 0,
    completed: 0,
    failed: 0,
  }
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1
  }
  return counts
}
