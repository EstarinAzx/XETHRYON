/**
 * Swarm tool: task-create
 * Create a new task on the team's shared task board.
 */

import z from "zod"
import { Tool } from "./tool"

const parameters = z.object({
  team_name: z.string().describe("Team name"),
  subject: z.string().describe("Short title for the task"),
  description: z.string().describe("Detailed description of what needs to be done"),
  owner: z.string().describe("Teammate name to assign this task to").optional(),
  blocked_by: z
    .array(z.string())
    .describe(
      "Tasks that must complete before this one. Can be task IDs, task subjects, or owner names — they will be resolved automatically. Example: ['researcher'] or ['scan repo'] or ['ef45ff47'].",
    )
    .optional(),
})

export const TaskCreateTool = Tool.define("task_create", {
  description:
    "Create a new task on the team's shared task board. Tasks can be assigned to teammates and have dependency relationships. " +
    "For blocked_by, you can use task IDs, subject names, or owner names — they are resolved automatically.",
  parameters,
  async execute(params) {
    const swarm = await import("../xethryon/swarm/index.js")

    // Resolve blocked_by references — support IDs, subjects, and owner names
    let resolvedBlockers: string[] = []
    if (params.blocked_by && params.blocked_by.length > 0) {
      const allTasks = await swarm.listTasks(params.team_name)
      resolvedBlockers = params.blocked_by
        .map((ref) => {
          // Direct ID match
          const byId = allTasks.find((t) => t.id === ref)
          if (byId) return byId.id

          // Subject match (case-insensitive, partial)
          const bySubject = allTasks.find(
            (t) => t.subject.toLowerCase() === ref.toLowerCase() || t.subject.toLowerCase().includes(ref.toLowerCase()),
          )
          if (bySubject) return bySubject.id

          // Owner match — find most recent task owned by this name
          const byOwner = allTasks
            .filter((t) => t.owner?.toLowerCase() === ref.toLowerCase())
            .sort((a, b) => b.createdAt - a.createdAt)
          if (byOwner.length > 0) return byOwner[0].id

          // Fall through — use raw ref (could be an ID from a task not yet created)
          return ref
        })
        .filter(Boolean)
    }

    const hasBlockers = resolvedBlockers.length > 0
    const task = await swarm.createTask(params.team_name, {
      subject: params.subject,
      description: params.description,
      status: hasBlockers ? "pending" : params.owner ? "in_progress" : "pending",
      owner: params.owner,
      blocks: [],
      blockedBy: resolvedBlockers,
    })

    // If assigned, notify the teammate
    if (params.owner) {
      await swarm.writeToMailbox(
        params.owner,
        {
          from: "team-lead",
          text: JSON.stringify({
            type: "task_assignment",
            taskId: task.id,
            subject: params.subject,
            description: params.description,
            assignedBy: "team-lead",
          }),
          summary: `New task: ${params.subject}`,
          timestamp: Date.now(),
        },
        params.team_name,
      )
    }

    const blockerInfo = resolvedBlockers.length > 0 ? ` Blocked by: [${resolvedBlockers.join(", ")}].` : ""

    return {
      title: `Task created: ${task.id}`,
      output: `Task "${params.subject}" created (ID: ${task.id}, status: ${task.status}${params.owner ? `, assigned to: ${params.owner}` : ""}).${blockerInfo}`,
      metadata: { taskId: task.id, teamName: params.team_name, resolvedBlockers },
    }
  },
})
