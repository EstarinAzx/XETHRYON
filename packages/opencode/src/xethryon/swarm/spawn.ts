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
import { emitTaskDone } from "./events.js"
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
    // ─── Worktree Isolation ──────────────────────────────────────────
    // Each teammate gets its own git worktree (separate branch + directory)
    // so parallel agents never conflict on file writes.
    // Falls back to shared directory for non-git projects.
    let worktreeDir: string | undefined
    let worktreeBranch: string | undefined
    let workspaceId: string | undefined

    try {
      const { Instance } = await import("../../project/instance.js")
      // Use directory (not worktree which is "/" for non-git projects)
      const cwd = Instance.directory

      // Check git directly (not cached vcs) so auto-init from team_create is picked up
      const gitCheck = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd })
      if (gitCheck.exitCode === 0) {
        const path = await import("path")
        const os = await import("os")
        const fsp = await import("fs/promises")
        const worktreeName = `swarm-${sanitizeName(config.teamName)}-${sanitizeName(config.name)}`
        const worktreeRoot = path.join(os.tmpdir(), "opencode-worktrees", Instance.project.id)
        await fsp.mkdir(worktreeRoot, { recursive: true })
        const wtDir = path.join(worktreeRoot, worktreeName)
        const wtBranch = `opencode/${worktreeName}`

        // Create the worktree + branch directly
        const result = Bun.spawnSync(
          ["git", "worktree", "add", "--no-checkout", "-b", wtBranch, wtDir],
          { cwd },
        )
        if (result.exitCode === 0) {
          // Populate the worktree with current HEAD content
          Bun.spawnSync(["git", "reset", "--hard"], { cwd: wtDir })
          worktreeDir = wtDir
          worktreeBranch = wtBranch

          // Create workspace to bind the session to the worktree directory
          try {
            const { Workspace } = await import("../../control-plane/workspace.js")
            const ws = await Workspace.create({
              type: "worktree",
              branch: worktreeBranch,
              projectID: Instance.project.id,
              extra: null,
            })
            workspaceId = ws.id
          } catch {
            // workspace binding failed — agent will use prompt-based CWD
          }
        }
      }
    } catch {
      // worktree creation failed — agent runs in shared directory
    }

    // Store worktree info in runtime state
    const teammate = getTeammate(agentId)
    if (teammate) {
      teammate.worktreeDir = worktreeDir
      teammate.worktreeBranch = worktreeBranch
      teammate.workspaceId = workspaceId
    }

    // Create a new sub-session with permissive ruleset.
    // Swarm agents run headless — no TUI to approve permissions.
    // Without this, agents hang forever on "allow once / whitelist / deny" prompts.
    const session = await Session.create({
      title: `[Swarm] ${config.name} — ${config.description ?? config.teamName}`,
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
      ],
      ...(workspaceId ? { workspaceID: workspaceId as any } : {}),
    })

    if (signal.aborted) {
      updateTeammateStatus(agentId, "stopped")
      return
    }

    const messageID = MessageID.ascending()
    const promptParts = await SessionPrompt.resolvePromptParts(buildTeammatePrompt(config, worktreeDir, worktreeBranch))

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

      // ─── v2: Post-task verification pipeline ─────────────────────────
      // 1. Extract structured result from agent output
      // 2. Transition to verifying → run artifact checks → completed or failed
      try {
        const { listTasks, updateTask, verifyTask } = await import("./tasks-board.js")
        const { readTeamFileAsync } = await import("./team.js")
        const teamFile = await readTeamFileAsync(config.teamName)
        const coordinatorSessionId = teamFile?.leadSessionId
        const allTasks = await listTasks(config.teamName)
        const ownedTasks = allTasks.filter(
          (t) => t.owner === config.name && ["pending", "blocked", "in_progress"].includes(t.status),
        )

        // Extract structured result from tool parts
        const toolParts = result.parts.filter((p: { type: string }) => p.type === "tool") as {
          type: string
          tool?: string
          state?: { status?: string; output?: string }
        }[]
        const writeTools = ["write", "edit", "bash", "apply_patch", "multi_edit", "patch"]
        const wroteFiles = toolParts
          .filter((p) => writeTools.includes(p.tool ?? "") && p.state?.status === "completed")
          .map((p) => p.tool ?? "unknown")
        const readFiles = toolParts
          .filter((p) => (p.tool === "read" || p.tool === "glob" || p.tool === "grep") && p.state?.status === "completed")
          .map((p) => p.tool ?? "unknown")

        const taskResult = {
          status: wroteFiles.length > 0 ? "success" as const : "failure" as const,
          wrote: wroteFiles,
          read: readFiles,
          notes: [] as string[],
        }

        for (const task of ownedTasks) {
          // Check if all blockedBy dependencies are completed
          if (task.blockedBy.length > 0) {
            const freshTasks = await listTasks(config.teamName)
            const allDepsCompleted = task.blockedBy.every((depRef) => {
              const dep = freshTasks.find((t) => t.id === depRef || t.subject === depRef)
              return dep?.status === "completed"
            })
            if (!allDepsCompleted) {
              // Deps not met → blocked (not pending)
              await updateTask(config.teamName, task.id, {
                status: "blocked",
                result: { ...taskResult, status: "failure", notes: ["blocked: dependencies not completed"] },
              })
              continue
            }
          }

          // Transition to verifying
          await updateTask(config.teamName, task.id, { status: "verifying", result: taskResult })

          // Run artifact verification
          const verification = verifyTask(task)

          if (!verification.passed) {
            // Missing outputs = hard fail (deterministic)
            await updateTask(config.teamName, task.id, {
              status: "failed",
              result: {
                ...taskResult,
                status: "failure",
                notes: verification.failures,
                failureKind: "deterministic",
              },
            })
            const snap = await listTasks(config.teamName)
            emitTaskDone({
              teamName: config.teamName,
              taskId: task.id,
              taskSubject: task.subject,
              owner: config.name,
              status: "failed",
              wrote: wroteFiles,
              notes: verification.failures,
              coordinatorSessionId,
              progress: {
                done: snap.filter((t) => ["completed", "deleted"].includes(t.status)).length,
                total: snap.filter((t) => t.status !== "deleted").length,
              },
            })
            continue
          }

          // If agent didn't write any files and no outputs declared → failed (transient)
          if (wroteFiles.length === 0 && (!task.outputs || task.outputs.length === 0)) {
            await updateTask(config.teamName, task.id, {
              status: "failed",
              result: {
                ...taskResult,
                status: "failure",
                notes: ["agent finished without writing files"],
                failureKind: "transient",
              },
            })
            const snap = await listTasks(config.teamName)
            emitTaskDone({
              teamName: config.teamName,
              taskId: task.id,
              taskSubject: task.subject,
              owner: config.name,
              status: "failed",
              wrote: [],
              notes: ["agent finished without writing files"],
              coordinatorSessionId,
              progress: {
                done: snap.filter((t) => ["completed", "deleted"].includes(t.status)).length,
                total: snap.filter((t) => t.status !== "deleted").length,
              },
            })
            continue
          }

          // All checks passed → completed
          await updateTask(config.teamName, task.id, {
            status: "completed",
            result: { ...taskResult, status: "success" },
          })
          const snap = await listTasks(config.teamName)
          emitTaskDone({
            teamName: config.teamName,
            taskId: task.id,
            taskSubject: task.subject,
            owner: config.name,
            status: "completed",
            wrote: wroteFiles,
            notes: [],
            coordinatorSessionId,
            progress: {
              done: snap.filter((t) => ["completed", "deleted"].includes(t.status)).length,
              total: snap.filter((t) => t.status !== "deleted").length,
            },
          })
        }

        // ─── Cascade: auto-unblock + auto-spawn dependent tasks ──────
        // Track which tasks just completed so we can unblock dependents.
        // We check the ORIGINAL allTasks (not a re-read) to avoid JSON flush timing issues.
        const completedTaskIds = new Set(
          ownedTasks
            .filter((t) => allTasks.find((at) => at.id === t.id)?.status !== "completed") // was not already completed
            .map((t) => t.id),
        )

        // Now re-read to get the actual current state after our updates
        try {
          const freshTasks = await listTasks(config.teamName)
          const teamFile2 = await readTeamFileAsync(config.teamName)

          for (const task of freshTasks) {
            if (task.status !== "blocked" || task.blockedBy.length === 0) continue

            // blockedBy can contain task IDs OR subject names — match both
            const allDepsCompleted = task.blockedBy.every((depRef) => {
              const dep = freshTasks.find((t) => t.id === depRef || t.subject === depRef)
              return dep?.status === "completed"
            })

            if (!allDepsCompleted) continue

            // Unblock the task
            await updateTask(config.teamName, task.id, {
              blockedBy: [] as any,
              status: task.owner ? "in_progress" : "pending",
            })

            // Auto-spawn agent if task has an owner
            if (task.owner && teamFile2) {
              const member = teamFile2.members.find((m) => m.name === task.owner)
              if (member && !isTeammateRunning(member.agentId)) {
                spawnTeammate({
                  name: member.name,
                  teamName: config.teamName,
                  prompt: task.description,
                  agentType: member.agentType,
                  model: member.model,
                  description: task.description,
                  color: member.color,
                }).catch(() => {})
              }
            }
          }
        } catch (err) {

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
    // ─── Worktree Merge + Cleanup ─────────────────────────────────
    // 1. Merge the agent's branch back into the current branch
    // 2. Send merge telemetry to coordinator
    // 3. Remove the workspace binding
    // 4. Remove the git worktree + branch
    const mate = getTeammate(agentId)
    let mergeStatus: "merged" | "conflict" | "empty" | "error" | "skipped" = "skipped"

    if (mate?.worktreeDir || mate?.workspaceId) {
      // Step 1: Auto-merge the agent's branch back into the parent branch
      if (mate.worktreeBranch && mate.worktreeDir) {
        try {
          const { Instance } = await import("../../project/instance.js")
          const mainCwd = Instance.directory
          const branch = mate.worktreeBranch

          // Use Bun.spawnSync to avoid cmd.exe hanging on Windows
          const mergeEnv = {
            ...process.env,
            GIT_EDITOR: "true",
            GIT_MERGE_AUTOEDIT: "no",
            GIT_TERMINAL_PROMPT: "0",
            GIT_PAGER: "cat",
          }

          // First: dry-run — check if merge would conflict
          const dryRun = Bun.spawnSync(["git", "merge", "--no-commit", "--no-ff", branch], {
            cwd: mainCwd,
            env: mergeEnv,
          })

          if (dryRun.exitCode !== 0) {
            // Conflict detected — abort and preserve branch
            Bun.spawnSync(["git", "merge", "--abort"], { cwd: mainCwd })
            mergeStatus = "conflict"
          } else {
            // No conflict — commit the merge
            const commitResult = Bun.spawnSync(["git", "commit", "--no-edit", "-m", `swarm: merge ${config.name} (${branch})`], {
              cwd: mainCwd,
              env: mergeEnv,
            })
            mergeStatus = commitResult.exitCode === 0 ? "merged" : "empty"
          }
        } catch (mergeErr: any) {
          // Unexpected error — try to abort any in-progress merge
          try {
            const { Instance } = await import("../../project/instance.js")
            Bun.spawnSync(["git", "merge", "--abort"], { cwd: Instance.directory })
          } catch { /* already clean */ }
          mergeStatus = "error"
        }
      }

      // Step 2: Send merge telemetry to coordinator via mailbox
      try {
        const { readTeamFileAsync } = await import("./team.js")
        const teamFile = await readTeamFileAsync(config.teamName)
        if (teamFile?.leadSessionId) {
          const statusMessages: Record<string, string> = {
            merged: `✓ ${config.name}: merged cleanly into main branch`,
            conflict: `⚠ ${config.name}: merge conflict — branch "${mate.worktreeBranch}" preserved for manual merge`,
            empty: `○ ${config.name}: no changes to merge (branch was empty)`,
            error: `✗ ${config.name}: merge failed — branch "${mate.worktreeBranch}" preserved`,
            skipped: `- ${config.name}: no worktree (git isolation was not active)`,
          }
          await writeToMailbox(
            TEAM_LEAD_NAME,
            {
              from: "swarm-system",
              text: JSON.stringify({
                type: "merge_telemetry",
                agent: config.name,
                branch: mate.worktreeBranch ?? null,
                status: mergeStatus,
              }),
              summary: statusMessages[mergeStatus] ?? `${config.name}: merge status unknown`,
              timestamp: Date.now(),
            },
            config.teamName,
          )
        }
      } catch {
        // telemetry delivery failed — non-fatal
      }

      // Step 3: Remove workspace binding
      try {
        if (mate.workspaceId) {
          const { Workspace } = await import("../../control-plane/workspace.js")
          await Workspace.remove(mate.workspaceId as any)
        }
      } catch {
        // workspace cleanup failed — non-fatal
      }

      // Step 4: Remove worktree directory (branch stays if merge failed)
      try {
        if (mate.worktreeDir) {
          const { Instance } = await import("../../project/instance.js")
          // Remove worktree via git directly (bypasses cached VCS check)
          Bun.spawnSync(["git", "worktree", "remove", "--force", mate.worktreeDir], { cwd: Instance.directory })
          // Clean up the directory if git didn't remove it
          const fsp = await import("fs/promises")
          await fsp.rm(mate.worktreeDir, { recursive: true, force: true }).catch(() => {})
        }
      } catch {
        // cleanup failed — non-fatal
      }
    }
    unregisterTeammate(agentId)
  }
}

/**
 * Build the system prompt injected into a teammate's session.
 */
function buildTeammatePrompt(config: TeammateSpawnConfig, worktreeDir?: string, worktreeBranch?: string): string {
  const lines = [
    `You are a teammate named "${config.name}" on team "${config.teamName}".`,
    "",
    "## Your Assignment",
    config.prompt,
    "",
    "## Rules",
    "- Focus only on your assigned task",
    "- When finished, summarize what you did clearly",
    "- If you encounter a blocker, describe it in your output",
  ]

  if (worktreeBranch && worktreeDir) {
    lines.push(
      "",
      "## Git Worktree Isolation",
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      "Your changes are isolated from other teammates — no merge conflicts possible.",
      "When you finish your task, commit your changes:",
      `  git add -A && git commit -m "your summary"`,
    )
  } else {
    lines.push("- Do not modify files outside your scope unless necessary")
  }

  if (config.description) {
    lines.push("", "## Context", config.description)
  }

  return lines.join("\n")
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
