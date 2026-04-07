/**
 * Swarm tool: team-create
 * Creates a new team and optionally spawns initial teammates.
 */

import z from "zod"
import { Tool } from "./tool"

const parameters = z.object({
  team_name: z.string().describe("Name for the new team"),
  description: z.string().describe("What this team will work on").optional(),
  teammates: z
    .array(
      z.object({
        name: z.string().describe("Unique name for this teammate"),
        prompt: z.string().describe("The task/instructions for this teammate"),
        agent_type: z.string().describe("Agent type to use (e.g. 'coder')").optional(),
        model: z.string().describe("Model override for this teammate").optional(),
      }),
    )
    .describe("Teammates to spawn immediately")
    .optional(),
})

export const TeamCreateTool = Tool.define("team_create", {
  description: [
    "Create a new team of AI teammates that work in parallel on related tasks.",
    "Each teammate runs as an independent sub-session with its own context.",
    "After creating the team, you become the team lead coordinating their work.",
    "Teammates communicate via a file-based mailbox. Check messages with send_message.",
  ].join(" "),
  parameters,
  async execute(params, ctx) {
    const swarm = await import("../xethryon/swarm/index.js")

    // Generate a unique team name
    const teamName = swarm.generateUniqueTeamName(params.team_name)
    const leadAgentId = swarm.formatAgentId("team-lead", teamName)

    // Store coordinator session ID for event-driven auto-inject
    swarm.setCoordinatorSessionId(ctx.sessionID)

    // Create the team file — include leadSessionId so spawn.ts can
    // pass it to event emitters for server-side prompt_async injection.
    await swarm.writeTeamFileAsync(teamName, {
      name: teamName,
      description: params.description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: ctx.sessionID,
      members: [],
    })

    // Set team context
    swarm.setActiveTeam(teamName)
    swarm.setTeamContext({
      teamName,
      leadAgentId,
      teammates: new Map(),
    })

    // Spawn teammates if provided
    const results: Array<{ name: string; agentId: string; success: boolean; error?: string }> = []
    if (params.teammates?.length) {
      for (const t of params.teammates) {
        const result = await swarm.spawnTeammate({
          name: t.name,
          teamName,
          prompt: t.prompt,
          agentType: t.agent_type,
          model: t.model,
          description: params.description,
        })
        results.push({
          name: t.name,
          agentId: result.agentId,
          success: result.success,
          error: result.error,
        })
      }
    }

    const spawnSummary =
      results.length > 0
        ? `\n\nTeammates spawned:\n${results.map((r) => `- ${r.name} (${r.agentId}): ${r.success ? "✓ running" : `✗ ${r.error}`}`).join("\n")}`
        : "\n\nNo teammates spawned yet. Use team_create again or assign tasks."

    return {
      title: `Created team: ${teamName}`,
      output: `Team "${teamName}" created. You are the team lead (${leadAgentId}).${spawnSummary}`,
      metadata: { teamName, leadAgentId, teammates: results },
    }
  },
})
