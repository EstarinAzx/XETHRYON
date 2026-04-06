/**
 * Swarm tool: team-await
 *
 * Simple "coffee break" timer — waits for a specified duration,
 * then returns the current task board state. The coordinator
 * decides what to do with the results (retry, re-spawn, finish, etc).
 *
 * This keeps the coordinator in the loop and maintains its momentum.
 * The model is better at error recovery than hardcoded logic.
 */

import z from "zod"
import { Tool } from "./tool"

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
    "Returns the current status of all tasks and agents. " +
    "Use this in a loop: deploy tasks → team_await → check results → decide next action. " +
    "YOU decide how long to wait and what to do with the results. " +
    "Keep calling team_await until all tasks are done or you need to intervene.",
  parameters,
  async execute(params) {
    const swarm = await import("../xethryon/swarm/index.js")

    // Verify team exists
    const team = await swarm.readTeamFileAsync(params.team_name)
    if (!team) {
      return {
        title: "Team not found",
        output: `No team named "${params.team_name}" exists.`,
        metadata: { taskCount: 0, completed: 0, deleted: 0, pending: 0, inProgress: 0, allDone: true },
      }
    }

    const waitMs = (params.wait_seconds ?? 15) * 1000

    // Coffee break — just wait
    await new Promise((resolve) => setTimeout(resolve, waitMs))

    // Wake up and check the board
    let tasks = await swarm.listTasks(params.team_name)
    const teammates = swarm.getTeammatesForTeam(params.team_name)

    if (tasks.length === 0) {
      return {
        title: "No tasks",
        output: `Team "${params.team_name}" has no tasks on the board.`,
        metadata: { taskCount: 0, completed: 0, deleted: 0, pending: 0, inProgress: 0, allDone: true },
      }
    }

    // Auto-spawn: check for pending tasks whose deps are met and agents aren't running
    // Re-read tasks fresh to catch any completions that landed during the coffee break
    tasks = await swarm.listTasks(params.team_name)
    const spawned: string[] = []
    for (const task of tasks) {
      if (task.status !== "pending" || !task.owner) continue

      // Check deps — re-read from current tasks list (freshly loaded)
      if (task.blockedBy.length > 0) {
        const allDepsCompleted = task.blockedBy.every((depId) => {
          const dep = tasks.find((t) => t.id === depId)
          return dep?.status === "completed"
        })
        if (!allDepsCompleted) continue
      }

      // Deps met (or none) — is the agent already running?
      const teamFile = await swarm.readTeamFileAsync(params.team_name)
      const member = teamFile?.members.find((m) => m.name === task.owner)
      if (member && !swarm.isTeammateRunning(member.agentId)) {
        // Spawn the teammate for this task
        const { updateTask } = await import("../xethryon/swarm/tasks-board.js")
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
        spawned.push(`${task.owner} → ${task.subject}`)
      }
    }

    // Re-read tasks after potential spawns
    if (spawned.length > 0) {
      tasks = await swarm.listTasks(params.team_name)
    }

    // Build status report
    const statusIcon: Record<string, string> = {
      pending: "○",
      in_progress: "◉",
      completed: "✓",
      deleted: "✗",
    }

    const completed = tasks.filter((t) => t.status === "completed").length
    const deleted = tasks.filter((t) => t.status === "deleted").length
    const pending = tasks.filter((t) => t.status === "pending").length
    const inProgress = tasks.filter((t) => t.status === "in_progress").length
    const allDone = pending === 0 && inProgress === 0

    // Agent status
    const agentLines = teammates.map((m: any) => {
      const icon = m.status === "running" ? "◉" : m.status === "idle" ? "○" : "✗"
      return `  ${icon} ${m.name} (${m.status})`
    })

    // Task status
    const taskLines = tasks.map((t) => {
      const icon = statusIcon[t.status] ?? "?"
      const owner = t.owner ? ` → ${t.owner}` : ""
      const blocked = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : ""
      return `  ${icon} ${t.subject} (${t.status}${owner})${blocked}`
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
      ? `✅ All tasks finished (${completed} completed, ${deleted} deleted)`
      : `⏳ ${pending + inProgress} task(s) still active — ${completed}/${tasks.length} done`

    const spawnedSection = spawned.length > 0
      ? `\n\nAuto-spawned this cycle:\n${spawned.map((s) => `  ▸ ${s}`).join("\n")}`
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
      spawnedSection,
    ].join("\n")

    return {
      title: header,
      output,
      metadata: {
        taskCount: tasks.length,
        completed,
        deleted,
        pending,
        inProgress,
        allDone,
      },
    }
  },
})
