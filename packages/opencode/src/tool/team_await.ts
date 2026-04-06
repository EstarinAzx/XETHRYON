/**
 * Swarm tool: team-await
 * Polls the team's task board until all tasks reach a terminal state
 * (completed or deleted), then returns a summary.
 */

import z from "zod"
import { Tool } from "./tool"

const parameters = z.object({
  team_name: z.string().describe("Team name to await"),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum seconds to wait before returning (default: 300 = 5 min)"),
  poll_interval_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Seconds between status checks (default: 3)"),
})

const TERMINAL_STATES = new Set(["completed", "deleted"])

export const TeamAwaitTool = Tool.define("team_await", {
  description:
    "Wait for all tasks in a team to reach a terminal state (completed/deleted). " +
    "Polls the task board periodically and returns a summary when done or on timeout. " +
    "Use this after spawning tasks to avoid manual status checking.",
  parameters,
  async execute(params) {
    const swarm = await import("../xethryon/swarm/index.js")

    const timeout = (params.timeout_seconds ?? 300) * 1000
    const interval = (params.poll_interval_seconds ?? 3) * 1000
    const startTime = Date.now()

    // Verify team exists
    const team = await swarm.readTeamFileAsync(params.team_name)
    if (!team) {
      return {
        title: "Team not found",
        output: `No team named "${params.team_name}" exists.`,
        metadata: { taskCount: 0, completed: 0, failed: 0, pending: 0, inProgress: 0, timedOut: false, elapsedSeconds: 0 },
      }
    }

    // Initial check — are there any tasks?
    let tasks = await swarm.listTasks(params.team_name)
    if (tasks.length === 0) {
      return {
        title: "No tasks",
        output: `Team "${params.team_name}" has no tasks on the board. Nothing to wait for.`,
        metadata: { taskCount: 0, completed: 0, failed: 0, pending: 0, inProgress: 0, timedOut: false, elapsedSeconds: 0 },
      }
    }

    // Track which tasks we've already re-spawned to avoid duplicates
    const respawned = new Set<string>()

    // Poll loop
    let timedOut = false
    while (true) {
      tasks = await swarm.listTasks(params.team_name)
      const activeTasks = tasks.filter((t) => !TERMINAL_STATES.has(t.status))

      if (activeTasks.length === 0) {
        // All done
        break
      }

      // Check for pending tasks whose dependencies are now met — re-spawn those teammates
      for (const task of activeTasks) {
        if (task.status !== "pending" || !task.owner || respawned.has(task.id)) continue
        if (task.blockedBy.length === 0) continue // no deps, shouldn't be pending unless just created

        const allDepsCompleted = task.blockedBy.every((depId) => {
          const dep = tasks.find((t) => t.id === depId)
          return dep?.status === "completed"
        })

        if (allDepsCompleted) {
          // Dependencies met — re-spawn this teammate
          respawned.add(task.id)
          const teamFile = await swarm.readTeamFileAsync(params.team_name)
          const member = teamFile?.members.find((m) => m.name === task.owner)
          if (member && !swarm.isTeammateRunning(member.agentId)) {
            // Update task to in_progress
            const { updateTask } = await import("../xethryon/swarm/tasks-board.js")
            await updateTask(params.team_name, task.id, { status: "in_progress" })

            // Re-spawn with original prompt + task context
            await swarm.spawnTeammate({
              name: member.name,
              teamName: params.team_name,
              prompt: member.prompt ?? task.description,
              agentType: member.agentType,
              model: member.model,
              description: task.description,
              color: member.color,
            })
          }
        }
      }

      const elapsed = Date.now() - startTime
      if (elapsed >= timeout) {
        timedOut = true
        break
      }

      // Sleep before next poll
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    // Build summary
    const statusIcon: Record<string, string> = {
      pending: "○",
      in_progress: "◉",
      completed: "✓",
      deleted: "✗",
    }

    const lines = tasks.map((t) => {
      const icon = statusIcon[t.status] ?? "?"
      const owner = t.owner ? ` → ${t.owner}` : ""
      return `${icon} ${t.id}: ${t.subject} (${t.status}${owner})`
    })

    const completed = tasks.filter((t) => t.status === "completed").length
    const failed = tasks.filter((t) => t.status === "deleted").length
    const pending = tasks.filter((t) => t.status === "pending").length
    const inProgress = tasks.filter((t) => t.status === "in_progress").length
    const elapsed = Math.round((Date.now() - startTime) / 1000)

    const header = timedOut
      ? `⏱ Timed out after ${elapsed}s — ${pending + inProgress} task(s) still active`
      : `✅ All ${tasks.length} task(s) finished in ${elapsed}s`

    const stats = `Completed: ${completed} | Deleted: ${failed} | Pending: ${pending} | In Progress: ${inProgress}`

    // Also check for unread lead messages (agent reports)
    let reports = ""
    try {
      const unread = await swarm.readUnreadMessages("team-lead", params.team_name)
      if (unread.length > 0) {
        reports = "\n\n📨 Unread reports from agents:\n" +
          unread.map((m) => `  [${m.from}]: ${m.text.slice(0, 200)}`).join("\n")
        await swarm.markMessagesAsRead("team-lead", params.team_name)
      }
    } catch {
      // mailbox might not exist yet
    }

    return {
      title: header,
      output: `${header}\n${stats}\n\n${lines.join("\n")}${reports}`,
      metadata: {
        taskCount: tasks.length,
        completed,
        failed,
        pending,
        inProgress,
        timedOut,
        elapsedSeconds: elapsed,
      },
    }
  },
})
