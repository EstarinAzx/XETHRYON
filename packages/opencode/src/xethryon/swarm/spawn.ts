/**
 * In-process teammate spawn backend.
 * Ported from cc-leak's swarm spawn concept.
 *
 * Uses OpenCode's Session.create + SessionPrompt.prompt to run
 * teammate agents as sub-sessions within the same process.
 * This avoids tmux/iTerm2 dependencies (Windows-first design).
 *
 * NOTE: We use lazy static imports (top-level await-free) that get
 * resolved at first use. This avoids the dynamic import() problem
 * where @/ path aliases don't resolve in compiled Bun binaries.
 */

import crypto from "crypto"
import type { TeammateSpawnConfig, SpawnResult, ActiveTeammate } from "./types.js"
import { formatAgentId, sanitizeName } from "./identity.js"
import { addMemberToTeam, setMemberActive } from "./team.js"
import { writeToMailbox } from "./mailbox.js"
import {
  registerTeammate,
  unregisterTeammate,
  updateTeammateStatus,
  abortTeammate,
  getTeammate,
} from "./state.js"
import { TEAM_LEAD_NAME } from "./constants.js"

// Lazy-loaded session modules — first call caches the result.
// These use dynamic import because Session/SessionPrompt have heavy
// top-level await chains that block if imported statically here.
let _sessionMod: typeof import("../../session/index.js") | null = null
let _promptMod: typeof import("../../session/prompt.js") | null = null
let _schemaMod: typeof import("../../session/schema.js") | null = null

async function getSessionModule() {
  if (!_sessionMod) _sessionMod = await import("../../session/index.js")
  return _sessionMod
}
async function getPromptModule() {
  if (!_promptMod) _promptMod = await import("../../session/prompt.js")
  return _promptMod
}
async function getSchemaModule() {
  if (!_schemaMod) _schemaMod = await import("../../session/schema.js")
  return _schemaMod
}

/**
 * Map LLM-friendly agent type names to valid internal agent IDs.
 * Falls back to "build" for unknown types.
 */
const AGENT_ALIASES: Record<string, string> = {
  coder: "build",
  code: "build",
  writer: "build",
  builder: "build",
  construct: "build",
  planner: "plan",
  architect: "plan",
  planning: "plan",
  explorer: "explore",
  recon: "explore",
  reader: "explore",
  researcher: "explore",
  verifier: "verification",
  validator: "verification",
  tester: "verification",
  review: "verification",
  coord: "coordinator",
  coordinate: "coordinator",
  orchestrator: "coordinator",
}

function resolveAgentType(agentType?: string): string {
  if (!agentType) return "build"
  const lower = agentType.toLowerCase().trim()
  return AGENT_ALIASES[lower] ?? lower
}

/**
 * Spawn a teammate as an in-process sub-session.
 *
 * Flow:
 * 1. Generate agentId and sessionId
 * 2. Register in team config + state
 * 3. Create a new Session
 * 4. Run SessionPrompt.prompt in background (non-blocking)
 * 5. When done → mark idle, notify team lead via mailbox
 */
export async function spawnTeammate(config: TeammateSpawnConfig): Promise<SpawnResult> {
  const agentId = formatAgentId(config.name, config.teamName)
  const sessionId = `swarm-${sanitizeName(config.name)}-${crypto.randomUUID().slice(0, 8)}`

  try {
    // Register member in team config
    await addMemberToTeam(config.teamName, {
      agentId,
      name: config.name,
      agentType: config.agentType,
      model: config.model,
      prompt: config.prompt,
      color: config.color,
      joinedAt: Date.now(),
      cwd: process.cwd(),
      sessionId,
      isActive: true,
      backendType: "in-process",
    })

    // Create abort controller for this teammate
    const ac = new AbortController()

    // Register in runtime state
    const teammate: ActiveTeammate = {
      agentId,
      name: config.name,
      teamName: config.teamName,
      sessionId,
      abortController: ac,
      status: "running",
    }
    registerTeammate(teammate)

    // Spawn the sub-session in the background (non-blocking)
    runTeammateSession(config, agentId, sessionId, ac.signal).catch((err) => {
      console.error(`[xethryon:swarm] teammate ${agentId} session error:`, err?.message ?? err)
      updateTeammateStatus(agentId, "stopped")
    })

    return { success: true, agentId, sessionId }
  } catch (err: unknown) {
    return {
      success: false,
      agentId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Run a teammate's session. This is the core execution loop.
 * Runs in the background — awaited by nobody.
 */
async function runTeammateSession(
  config: TeammateSpawnConfig,
  agentId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const { Session } = await getSessionModule()
  const { SessionPrompt } = await getPromptModule()
  const { MessageID } = await getSchemaModule()

  try {
    // Create a new sub-session
    const session = await Session.create({
      title: `[Swarm] ${config.name} — ${config.description ?? config.teamName}`,
    })

    if (signal.aborted) {
      updateTeammateStatus(agentId, "stopped")
      return
    }

    const messageID = MessageID.ascending()
    const promptParts = await SessionPrompt.resolvePromptParts(buildTeammatePrompt(config))

    // Listen for abort
    const cancelFn = () => SessionPrompt.cancel(session.id)
    signal.addEventListener("abort", cancelFn)

    try {
      // Run the prompt
      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        parts: promptParts,
        agent: resolveAgentType(config.agentType),
      })

      // Prompt completed — teammate is idle
      updateTeammateStatus(agentId, "idle")
      await setMemberActive(config.teamName, config.name, false)

      // Auto-mark owned tasks as completed on the task board
      // (teammates can't call task_update since swarm tools are COORDINATE-only)
      try {
        const { listTasks, updateTask } = await import("./tasks-board.js")
        const allTasks = await listTasks(config.teamName)
        const ownedTasks = allTasks.filter(
          (t) => t.owner === config.name && (t.status === "pending" || t.status === "in_progress"),
        )
        for (const task of ownedTasks) {
          // Check if all blockedBy dependencies are completed
          if (task.blockedBy.length > 0) {
            const allDepsCompleted = task.blockedBy.every((depId) => {
              const dep = allTasks.find((t) => t.id === depId)
              return dep?.status === "completed"
            })
            if (!allDepsCompleted) {
              // Dependencies not met — agent finished without doing work.
              // Reset to pending so team_await keeps polling.
              await updateTask(config.teamName, task.id, { status: "pending" })
              continue
            }
          }
          await updateTask(config.teamName, task.id, { status: "completed" })
        }
      } catch {
        // task board may not exist — non-fatal
      }

      // Notify team lead that this teammate finished
      const resultText = result.parts.findLast((x: { type: string }) => x.type === "text") as { text?: string } | undefined
      await writeToMailbox(
        TEAM_LEAD_NAME,
        {
          from: config.name,
          text: JSON.stringify({
            type: "idle_notification",
            from: config.name,
            idleReason: "Task completed",
          }),
          summary: `${config.name} finished: ${resultText?.text?.slice(0, 200) ?? "(no output)"}`,
          timestamp: Date.now(),
        },
        config.teamName,
      )
    } finally {
      signal.removeEventListener("abort", cancelFn)
    }
  } catch (err: unknown) {
    if (signal.aborted) {
      updateTeammateStatus(agentId, "stopped")
      return
    }

    updateTeammateStatus(agentId, "stopped")
    await setMemberActive(config.teamName, config.name, false)

    // Notify lead about the failure
    await writeToMailbox(
      TEAM_LEAD_NAME,
      {
        from: config.name,
        text: JSON.stringify({
          type: "idle_notification",
          from: config.name,
          idleReason: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }),
        summary: `${config.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      },
      config.teamName,
    ).catch(() => {})
  } finally {
    unregisterTeammate(agentId)
  }
}

/**
 * Build the system prompt injected into a teammate's session.
 */
function buildTeammatePrompt(config: TeammateSpawnConfig): string {
  return [
    `You are a teammate named "${config.name}" on team "${config.teamName}".`,
    "",
    "## Your Assignment",
    config.prompt,
    "",
    "## Rules",
    "- Focus only on your assigned task",
    "- Do not modify files outside your scope unless necessary",
    "- When finished, summarize what you did clearly",
    "- If you encounter a blocker, describe it in your output",
    config.description ? `\n## Context\n${config.description}` : "",
  ].join("\n")
}

/**
 * Stop a teammate (abort its session).
 */
export function stopTeammate(agentId: string): boolean {
  return abortTeammate(agentId)
}

/**
 * Check if a teammate is currently running.
 */
export function isTeammateRunning(agentId: string): boolean {
  const t = getTeammate(agentId)
  return t !== undefined && t.status === "running"
}
