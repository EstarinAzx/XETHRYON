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

    // ─── Git Auto-Init ──────────────────────────────────────────────
    // Worktree isolation requires git. If no VCS is detected, auto-init
    // so parallel agents always get their own branch + directory.
    // spawn.ts checks git directly via rev-parse, not cached Instance.
    try {
      const { Instance } = await import("../project/instance.js")
      if (Instance.project.vcs !== "git") {
        // Instance.worktree is "/" for non-git projects, use Instance.directory instead
        const cwd = Instance.directory
        const check = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd })
        if (check.exitCode !== 0) {
          Bun.spawnSync(["git", "init"], { cwd })
          Bun.spawnSync(["git", "add", "-A"], { cwd })
          Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "xethryon: initial commit"], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
        }
      }
    } catch { /* non-fatal — worktree isolation will fall back to shared dir */ }

    // ─── Worktree Prune ──────────────────────────────────────────────
    // Clean up stale worktrees from previous runs to prevent disk bloat
    // and avoid branch-name collisions on repeated team creation.
    // Safe policy: only prune git-reported stale refs + dirs older than 24h.
    try {
      const { Instance } = await import("../project/instance.js")
      const cwd = Instance.directory
      // Let git clean its own stale worktree references
      Bun.spawnSync(["git", "worktree", "prune"], { cwd })

      // Clean orphaned worktree dirs from tmpdir (older than 24h)
      const os = await import("os")
      const path = await import("path")
      const fsp = await import("fs/promises")
      const worktreeRoot = path.join(os.tmpdir(), "opencode-worktrees", Instance.project.id)
      try {
        const entries = await fsp.readdir(worktreeRoot, { withFileTypes: true })
        const now = Date.now()
        const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const dirPath = path.join(worktreeRoot, entry.name)
          try {
            const stat = await fsp.stat(dirPath)
            if (now - stat.mtimeMs > MAX_AGE_MS) {
              // Force-remove from git first, then delete dir
              Bun.spawnSync(["git", "worktree", "remove", "--force", dirPath], { cwd })
              await fsp.rm(dirPath, { recursive: true, force: true })
            }
          } catch { /* stat/remove failed — skip */ }
        }
      } catch { /* worktreeRoot doesn't exist yet — nothing to prune */ }
    } catch { /* prune failed — non-fatal */ }

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
