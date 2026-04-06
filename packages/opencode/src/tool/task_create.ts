/**
 * Swarm tool: task-create
 * v2: Supports artifact-based completion contracts.
 */

import z from "zod"
import path from "path"
import { Tool } from "./tool"

const parameters = z.object({
  team_name: z.string().describe("Team name"),
  subject: z.string().describe("Short title for the task"),
  description: z.string().describe("Detailed description of what needs to be done"),
  owner: z.string().describe("Teammate name to assign this task to").optional(),
  blocked_by: z
    .array(z.string())
    .describe(
      "Tasks that must complete before this one. Can be task IDs, task subjects, or owner names — resolved automatically.",
    )
    .optional(),
  outputs: z
    .array(z.string())
    .describe(
      "Expected output file paths. Can be relative (resolved to cwd) or absolute. Task will FAIL verification if these don't exist when the agent finishes.",
    )
    .optional(),
  timeout: z
    .number()
    .int()
    .positive()
    .describe("Per-task timeout in seconds. If agent takes longer with no progress, watchdog intervenes. Default: 60.")
    .optional(),
})

export const TaskCreateTool = Tool.define("task_create", {
  description:
    "Create a new task on the team's shared task board. " +
    "Tasks can be assigned to teammates and have dependency relationships. " +
    "For blocked_by, you can use task IDs, subject names, or owner names — they are resolved automatically. " +
    "Declare expected outputs for artifact-based completion verification.",
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
            (t) =>
              t.subject.toLowerCase() === ref.toLowerCase() ||
              t.subject.toLowerCase().includes(ref.toLowerCase()),
          )
          if (bySubject) return bySubject.id

          // Owner match — find most recent task owned by this name
          const byOwner = allTasks
            .filter((t) => t.owner?.toLowerCase() === ref.toLowerCase())
            .sort((a, b) => b.createdAt - a.createdAt)
          if (byOwner.length > 0) return byOwner[0].id

          // Fall through — use raw ref
          return ref
        })
        .filter(Boolean)
    }

    // Resolve output paths to absolute
    const cwd = process.cwd()
    const resolvedOutputs = params.outputs?.map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)))

    // Build success criteria from outputs
    const successCriteria = resolvedOutputs?.map((p) => `file_exists:${p}`)

    const hasBlockers = resolvedBlockers.length > 0
    const task = await swarm.createTask(params.team_name, {
      subject: params.subject,
      description: params.description,
      status: hasBlockers ? "blocked" : params.owner ? "in_progress" : "pending",
      owner: params.owner,
      blocks: [],
      blockedBy: resolvedBlockers,
      outputs: resolvedOutputs,
      successCriteria,
      timeout: params.timeout,
    })

    // If assigned, notify the teammate
    if (params.owner) {
      const outputInfo = resolvedOutputs?.length
        ? `\n\nExpected outputs:\n${resolvedOutputs.map((p) => `- ${p}`).join("\n")}`
        : ""

      await swarm.writeToMailbox(
        params.owner,
        {
          from: "team-lead",
          text: JSON.stringify({
            type: "task_assignment",
            taskId: task.id,
            subject: params.subject,
            description: params.description + outputInfo,
            assignedBy: "team-lead",
          }),
          summary: `New task: ${params.subject}`,
          timestamp: Date.now(),
        },
        params.team_name,
      )
    }

    const blockerInfo = resolvedBlockers.length > 0 ? ` Blocked by: [${resolvedBlockers.join(", ")}].` : ""
    const outputInfo = resolvedOutputs?.length ? ` Expected outputs: [${resolvedOutputs.join(", ")}].` : ""

    return {
      title: `Task created: ${task.id}`,
      output: `Task "${params.subject}" created (ID: ${task.id}, status: ${task.status}${params.owner ? `, assigned to: ${params.owner}` : ""}).${blockerInfo}${outputInfo}`,
      metadata: { taskId: task.id, teamName: params.team_name, resolvedBlockers, resolvedOutputs },
    }
  },
})
