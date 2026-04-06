/**
 * Swarm tool: team-await
 *
 * v2: 5-phase orchestration pipeline:
 * 1. Auto-reconcile stale in_progress/verifying tasks
 * 2. Auto-retry transient failures (once)
 * 3. Auto-unblock tasks whose deps are completed
 * 4. Auto-spawn agents for ready tasks
 * 5. Watchdog — detect stuck tasks
 * 6. Invariant check — surface contradictions
 */

import z from "zod"
import { Tool } from "./tool"

const DEFAULT_TIMEOUT = 60

const parameters = z.object({
  team_name: z.string().describe("Team name to check on"),
  wait_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Seconds to wait before checking (default: 15). Set based on expected task complexity."),
})

export const TeamAwaitTool = Tool.define("team_await", {
  description:
    "Take a short break, then check on a team's task board. " +
    "Returns the current status of all tasks and agents with auto-healing. " +
    "Auto-reconciles stale states, retries transient failures, unblocks satisfied deps, and spawns ready agents. " +
    "Use this in a loop: deploy tasks → team_await → check results → decide next action.",
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

    const waitMs = (params.wait_seconds ?? 15) * 1000
    await new Promise((resolve) => setTimeout(resolve, waitMs))

    let tasks = await swarm.listTasks(params.team_name)
    const teammates = swarm.getTeammatesForTeam(params.team_name)

    if (tasks.length === 0) {
      return {
        title: "No tasks",
        output: `Team "${params.team_name}" has no tasks on the board.`,
        metadata: { taskCount: 0, completed: 0, deleted: 0, pending: 0, blocked: 0, inProgress: 0, failed: 0, verifying: 0, allDone: true },
      }
    }

    const actions: string[] = []

    // ─── Phase 1: Auto-reconcile stale tasks ───────────────────────────
    for (const task of tasks) {
      if (!["in_progress", "verifying"].includes(task.status) || !task.owner) continue

      const teamFile = await swarm.readTeamFileAsync(params.team_name)
      const member = teamFile?.members.find((m) => m.name === task.owner)
      if (!member) continue

      if (!swarm.isTeammateRunning(member.agentId)) {
        // Agent finished but task stuck — run verification
        const verification = verifyTask(task)
        if (verification.passed || (task.outputs && task.outputs.length === 0)) {
          await updateTask(params.team_name, task.id, { status: "completed" })
          actions.push(`reconciled: ${task.subject} → completed`)
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
          actions.push(`reconciled: ${task.subject} → failed (${verification.failures.join(", ") || "no output"})`)
        }
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // ─── Phase 2: Auto-retry transient failures (once) ─────────────────
    for (const task of tasks) {
      if (task.status !== "failed") continue
      const retryCount = task.retryCount ?? 0
      const failureKind = task.result?.failureKind ?? "deterministic"

      // Only retry transient failures, and only once
      if (failureKind !== "transient" || retryCount >= 1) continue
      if (!task.owner) continue

      const teamFile = await swarm.readTeamFileAsync(params.team_name)
      const member = teamFile?.members.find((m) => m.name === task.owner)
      if (!member || swarm.isTeammateRunning(member.agentId)) continue

      // Retry: reset to in_progress and re-spawn
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
      actions.push(`retried: ${task.subject} (attempt ${retryCount + 2})`)
    }

    tasks = await swarm.listTasks(params.team_name)

    // ─── Phase 3: Auto-unblock tasks whose deps are met ────────────────
    for (const task of tasks) {
      if (!["pending", "blocked"].includes(task.status) || task.blockedBy.length === 0) continue

      const allDepsCompleted = task.blockedBy.every((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return dep?.status === "completed"
      })

      if (allDepsCompleted) {
        await updateTask(params.team_name, task.id, {
          blockedBy: [] as any,
          status: task.owner ? "in_progress" : "pending",
        })
        actions.push(`unblocked: ${task.subject}`)
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // ─── Phase 4: Auto-spawn ready tasks ───────────────────────────────
    for (const task of tasks) {
      if (!["pending", "in_progress"].includes(task.status) || !task.owner) continue
      if (task.blockedBy.length > 0) continue // Still blocked

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
        actions.push(`spawned: ${task.owner} → ${task.subject}`)
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // ─── Phase 5: Watchdog — detect stuck tasks ────────────────────────
    const now = Date.now()
    for (const task of tasks) {
      if (task.status !== "in_progress") continue
      const timeout = (task.timeout ?? DEFAULT_TIMEOUT) * 1000
      const elapsed = now - task.updatedAt

      if (elapsed > timeout) {
        // Check if agent is actually running
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
          actions.push(`watchdog: ${task.subject} → failed (stale ${Math.round(elapsed / 1000)}s)`)
        }
      }
    }

    tasks = await swarm.listTasks(params.team_name)

    // ─── Phase 6: Invariant check ──────────────────────────────────────
    const warnings: string[] = []
    for (const task of tasks) {
      // Completed task with missing outputs
      if (task.status === "completed" && task.outputs && task.outputs.length > 0) {
        const { passed, failures } = verifyTask(task)
        if (!passed) {
          warnings.push(`⚠ "${task.subject}" completed but: ${failures.join(", ")}`)
        }
      }
      // Blocked task with all deps met
      if (task.status === "blocked" && task.blockedBy.length > 0) {
        const allMet = task.blockedBy.every((id) => tasks.find((t) => t.id === id)?.status === "completed")
        if (allMet) {
          warnings.push(`⚠ "${task.subject}" blocked but all deps are completed`)
        }
      }
      // Pending task with owner + no blockers
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

    // Unread reports
    let reports = ""
    try {
      const unread = await swarm.readUnreadMessages("team-lead", params.team_name)
      if (unread.length > 0) {
        reports =
          "\n\nAgent reports:\n" +
          unread.map((m) => `  [${m.from}]: ${m.text.slice(0, 300)}`).join("\n")
        await swarm.markMessagesAsRead("team-lead", params.team_name)
      }
    } catch {
      // mailbox might not exist
    }

    const header = allDone
      ? failed > 0
        ? `⚠ Finished with failures (${completed} completed, ${failed} failed, ${deleted} deleted)`
        : `✅ All tasks finished (${completed} completed, ${deleted} deleted)`
      : `⏳ ${pending + blocked + inProgress + verifying} task(s) active — ${completed}/${tasks.length} done`

    const actionsSection = actions.length > 0
      ? `\n\nAuto-actions this cycle:\n${actions.map((a) => `  ▸ ${a}`).join("\n")}`
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
