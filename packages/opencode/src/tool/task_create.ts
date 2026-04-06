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
  blocked_by: z.array(z.string()).describe("Task IDs that must complete before this one").optional(),
})

export const TaskCreateTool = Tool.define("task_create", {
  description:
    "Create a new task on the team's shared task board. Tasks can be assigned to teammates and have dependency relationships via blocked_by.",
  parameters,
  async execute(params) {
    const swarm = await import("../xethryon/swarm/index.js")

    const hasBlockers = params.blocked_by && params.blocked_by.length > 0
    const task = await swarm.createTask(params.team_name, {
      subject: params.subject,
      description: params.description,
      status: hasBlockers ? "pending" : params.owner ? "in_progress" : "pending",
      owner: params.owner,
      blocks: [],
      blockedBy: params.blocked_by ?? [],
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

    return {
      title: `Task created: ${task.id}`,
      output: `Task "${params.subject}" created (ID: ${task.id}, status: ${task.status}${params.owner ? `, assigned to: ${params.owner}` : ""}).`,
      metadata: { taskId: task.id, teamName: params.team_name },
    }
  },
})
