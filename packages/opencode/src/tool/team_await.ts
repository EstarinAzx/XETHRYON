/**
 * Swarm tool: team-await
 *
 * Blocks internally until all agents are done (or timeout).
 * Returns ONCE with full status + auto-healing.
 * This eliminates the coordinator's polling loop that wastes tokens.
 *
 * Internal pipeline per poll cycle:
 * 1. Auto-reconcile stale in_progress/verifying tasks
 * 2. Auto-retry transient failures (once)
 * 3. Auto-unblock tasks whose deps are completed
 * 4. Auto-spawn agents for ready tasks
 * 5. Watchdog — detect stuck tasks
 * 6. Invariant check — surface contradictions
 */

import z from "zod"
import { Tool } from "./tool"

const DEFAULT_TASK_TIMEOUT = 60
const POLL_INTERVAL_MS = 5_000 // Check every 5s
const MAX_WAIT_MS = 300_000   // 5 minute max

const parameters = z.object({
  team_name: z.string().describe("Team name to wait on"),
  max_wait_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum seconds to wait for all agents (default: 300). Tool blocks internally — do NOT call in a loop."),
})

export const TeamAwaitTool = Tool.define("team_await", {
  description:
    "Block until all agents on a team finish, then return the final status. " +
    "This tool polls internally every 5s — call it ONCE and wait for the result. " +
    "Do NOT call this in a loop. It handles auto-reconciliation, retry, unblocking, and watchdog internally.",
  parameters,
  async execute(params) {
    const swarm = await import("../xethryon/swarm/index.js")
    const { updateTask, verifyTask } = await import("../xethryon/swarm/tasks-board.js")

    // Verify team exists
    const team = await swarm.readTeamFileAsync(params.team_name)
    if (!team) {
      return {
        title: "Team not found",
        output: `No team named "${params.team_name}" exists.`,
        metadata: { taskCount: 0, completed: 0, deleted: 0, pending: 0, blocked: 0, inProgress: 0, failed: 0, verifying: 0, allDone: true },
      }
    }

    const maxWait = (params.max_wait_seconds ?? 300) * 1000
    const deadline = Date.now() + Math.min(maxWait, MAX_WAIT_MS)
    const allActions: string[] = []
    let pollCount = 0

    // ─── Internal Polling Loop ────────────────────────────────────────
    // Keep checking until all agents are idle/stopped OR timeout
    while (Date.now() < deadline) {
      pollCount++

      // Check if any teammates are still running
      const teammates = swarm.getTeammatesForTeam(params.team_name)
      const anyRunning = teammates.some((m: any) => m.status === "running")

      if (!anyRunning && pollCount > 1) {
        // All agents done — break out and run final healing pass
        break
      }

      // Wait before next check (skip first iteration to allow immediate check)
      if (pollCount > 1 || anyRunning) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    }

    // ─── Final Healing Pass ───────────────────────────────────────────
    // Run all 6 phases once after agents are done
    let tasks = await swarm.listTasks(params.team_name)

    if (tasks.length === 0) {
      // No task board — just report agent status
      const teammates = swarm.getTeammatesForTeam(params.team_name)
      const agentLines = teammates.map((m: any) => {
        const icon = m.status === "running" ? "◉" : m.status === "idle" ? "○" : "✗"
        return `  ${icon} ${m.name} (${m.status})`
      })

      // Read mailbox for merge telemetry
      let reports = ""
      try {
        const unread = await swarm.readUnreadMessages("team-lead", params.team_name)
        if (unread.length > 0) {
          reports =
            "\n\nAgent reports:\n" +
            unread.map((m) => `  [${m.from}]: ${m.summary ?? m.text.slice(0, 300)}`).join("\n")
          await swarm.markMessagesAsRead("team-lead", params.team_name)
        }
      } catch { /* mailbox might not exist */ }

      return {
        title: `All agents finished (no task board)`,
        output: `Team "${params.team_name}" — all agents idle.\n\nAgents:\n${agentLines.join("\n")}${reports}\n\nPolled ${pollCount} time(s).`,
        metadata: { taskCount: 0, completed: 0, deleted: 0, pending: 0, blocked: 0, inProgress: 0, failed: 0, verifying: 0, allDone: true },
      }
    }

    // Phase 1: Auto-reconcile stale tasks
    for (const task of tasks) {
      if (!["in_progress", "verifying"].includes(task.status) || !task.owner) continue

      const teamFile = await swarm.readTeamFileAsync(params.team_name)
      const member = teamFile?.members.find((m) => m.name === task.owner)
      if (!member) continue

      if (!swarm.isTeammateRunning(member.agentId)) {
        const verification = verifyTask(task)
        if (verification.passed || (task.outputs && task.outputs.length === 0)) {
          await updateTask(params.team_name, task.id, { status: "completed" })
          allActions.push(`reconciled: ${task.subject} → completed`)
        } else {
          await updateTask(params.team_name, task.id, {
            status: "failed",
            result: {
              status: "failure",
              wrote: [],
              read: [],
              notes: verification.failures.length > 0 ? verification.failures : ["agent finished without producing outputs"],
              failureKind: "transient",
            },
          })
          allActions.push(`reconciled: ${task.subject} → failed (${verification.failures.join(", ") || "no output"})`)
        }
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // Phase 2: Auto-retry transient failures (once)
    for (const task of tasks) {
      if (task.status !== "failed") continue
      const retryCount = task.retryCount ?? 0
      const failureKind = task.result?.failureKind ?? "deterministic"

      if (failureKind !== "transient" || retryCount >= 1) continue
      if (!task.owner) continue

      const teamFile = await swarm.readTeamFileAsync(params.team_name)
      const member = teamFile?.members.find((m) => m.name === task.owner)
      if (!member || swarm.isTeammateRunning(member.agentId)) continue

      await updateTask(params.team_name, task.id, {
        status: "in_progress",
        retryCount: retryCount + 1,
      })
      await swarm.spawnTeammate({
        name: member.name,
        teamName: params.team_name,
        prompt: task.description,
        agentType: member.agentType,
        model: member.model,
        description: task.description,
        color: member.color,
      })
      allActions.push(`retried: ${task.subject} (attempt ${retryCount + 2})`)
    }

    tasks = await swarm.listTasks(params.team_name)

    // Phase 3: Auto-unblock tasks whose deps are met
    for (const task of tasks) {
      if (!["pending", "blocked"].includes(task.status) || task.blockedBy.length === 0) continue

      const allDepsCompleted = task.blockedBy.every((depRef) => {
        const dep = tasks.find((t) => t.id === depRef || t.subject === depRef)
        return dep?.status === "completed"
      })

      if (allDepsCompleted) {
        await updateTask(params.team_name, task.id, {
          blockedBy: [] as any,
          status: task.owner ? "in_progress" : "pending",
        })
        allActions.push(`unblocked: ${task.subject}`)
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // Phase 4: Auto-spawn ready tasks
    for (const task of tasks) {
      if (!["pending", "in_progress"].includes(task.status) || !task.owner) continue
      if (task.blockedBy.length > 0) continue

      const teamFile = await swarm.readTeamFileAsync(params.team_name)
      const member = teamFile?.members.find((m) => m.name === task.owner)
      if (member && !swarm.isTeammateRunning(member.agentId)) {
        await updateTask(params.team_name, task.id, { status: "in_progress" })
        await swarm.spawnTeammate({
          name: member.name,
          teamName: params.team_name,
          prompt: task.description,
          agentType: member.agentType,
          model: member.model,
          description: task.description,
          color: member.color,
        })
        allActions.push(`spawned: ${task.owner} → ${task.subject}`)
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // Phase 5: Watchdog — detect stuck tasks
    const now = Date.now()
    for (const task of tasks) {
      if (task.status !== "in_progress") continue
      const timeout = (task.timeout ?? DEFAULT_TASK_TIMEOUT) * 1000
      const elapsed = now - task.updatedAt

      if (elapsed > timeout) {
        const teamFile = await swarm.readTeamFileAsync(params.team_name)
        const member = teamFile?.members.find((m) => m.name === task.owner)
        const isRunning = member ? swarm.isTeammateRunning(member.agentId) : false

        if (!isRunning) {
          await updateTask(params.team_name, task.id, {
            status: "failed",
            result: {
              status: "failure",
              wrote: [],
              read: [],
              notes: [`watchdog: task stale for ${Math.round(elapsed / 1000)}s with no active agent`],
              failureKind: "transient",
            },
          })
          allActions.push(`watchdog: ${task.subject} → failed (stale ${Math.round(elapsed / 1000)}s)`)
        }
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // Phase 6: Invariant check
    const warnings: string[] = []
    for (const task of tasks) {
      if (task.status === "completed" && task.outputs && task.outputs.length > 0) {
        const { passed, failures } = verifyTask(task)
        if (!passed) {
          warnings.push(`⚠ "${task.subject}" completed but: ${failures.join(", ")}`)
        }
      }
      if (task.status === "blocked" && task.blockedBy.length > 0) {
        const allMet = task.blockedBy.every((id) => tasks.find((t) => t.id === id)?.status === "completed")
        if (allMet) {
          warnings.push(`⚠ "${task.subject}" blocked but all deps are completed`)
        }
      }
      if (task.status === "pending" && task.owner && task.blockedBy.length === 0) {
        warnings.push(`⚠ "${task.subject}" pending with owner but no blockers — should be in_progress`)
      }
    }

    // ─── Build status report ───────────────────────────────────────────
    const statusIcon: Record<string, string> = {
      pending: "○",
      blocked: "◇",
      in_progress: "◉",
      verifying: "◈",
      completed: "✓",
      failed: "✗",
      deleted: "—",
    }

    const teammates = swarm.getTeammatesForTeam(params.team_name)
    const completed = tasks.filter((t) => t.status === "completed").length
    const deleted = tasks.filter((t) => t.status === "deleted").length
    const pending = tasks.filter((t) => t.status === "pending").length
    const blocked = tasks.filter((t) => t.status === "blocked").length
    const inProgress = tasks.filter((t) => t.status === "in_progress").length
    const failed = tasks.filter((t) => t.status === "failed").length
    const verifying = tasks.filter((t) => t.status === "verifying").length
    const allDone = pending === 0 && blocked === 0 && inProgress === 0 && verifying === 0

    const agentLines = teammates.map((m: any) => {
      const icon = m.status === "running" ? "◉" : m.status === "idle" ? "○" : "✗"
      return `  ${icon} ${m.name} (${m.status})`
    })

    const taskLines = tasks.map((t) => {
      const icon = statusIcon[t.status] ?? "?"
      const owner = t.owner ? ` → ${t.owner}` : ""
      const blockedStr = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : ""
      const retryStr = t.retryCount && t.retryCount > 0 ? ` [retry #${t.retryCount}]` : ""
      const failNotes = t.status === "failed" && t.result?.notes.length
        ? ` (${t.result.notes[0]})`
        : ""
      return `  ${icon} ${t.subject} (${t.status}${owner})${blockedStr}${retryStr}${failNotes}`
    })

    // Read mailbox for merge telemetry + agent reports
    let reports = ""
    try {
      const unread = await swarm.readUnreadMessages("team-lead", params.team_name)
      if (unread.length > 0) {
        reports =
          "\n\nAgent reports:\n" +
          unread.map((m) => `  [${m.from}]: ${m.summary ?? m.text.slice(0, 300)}`).join("\n")
        await swarm.markMessagesAsRead("team-lead", params.team_name)
      }
    } catch { /* mailbox might not exist */ }

    const header = allDone
      ? failed > 0
        ? `⚠ Finished with failures (${completed} completed, ${failed} failed, ${deleted} deleted)`
        : `✅ All tasks finished (${completed} completed, ${deleted} deleted)`
      : `⏳ ${pending + blocked + inProgress + verifying} task(s) still active — ${completed}/${tasks.length} done (timed out after ${Math.round(maxWait / 1000)}s)`

    const actionsSection = allActions.length > 0
      ? `\n\nAuto-actions:\n${allActions.map((a) => `  ▸ ${a}`).join("\n")}`
      : ""

    const warningsSection = warnings.length > 0
      ? `\n\nInvariant warnings:\n${warnings.join("\n")}`
      : ""

    const output = [
      header,
      "",
      `Agents:`,
      ...agentLines,
      "",
      `Tasks:`,
      ...taskLines,
      reports,
      actionsSection,
      warningsSection,
      "",
      `(polled ${pollCount} time(s) over ${Math.round((Date.now() - (deadline - Math.min(maxWait, MAX_WAIT_MS))) / 1000)}s)`,
    ].join("\n")

    return {
      title: header,
      output,
      metadata: {
        taskCount: tasks.length,
        completed,
        deleted,
        pending,
        blocked,
        inProgress,
        failed,
        verifying,
        allDone,
      },
    }
  },
})

