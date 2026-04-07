/**
 * Xethryon Autonomy Module
 *
 * Global state for the autonomy toggle.
 * When enabled, the AI can autonomously switch agent modes
 * based on task requirements.
 *
 * Uses process.env to guarantee state sharing — environment
 * variables are a single OS-level store that no bundler can duplicate.
 */

/**
 * Set the global autonomy state.
 * Called by the TUI when the user presses f4.
 */
export function setAutonomy(enabled: boolean): void {
  if (enabled) {
    process.env.XETHRYON_AUTONOMY = "1"
  } else {
    delete process.env.XETHRYON_AUTONOMY
  }
}

/**
 * Check if autonomy mode is enabled.
 */
export function isAutonomyEnabled(): boolean {
  return process.env.XETHRYON_AUTONOMY === "1"
}

/**
 * Get the autonomy system prompt injection.
 * Returns undefined if autonomy is OFF.
 */
export function getAutonomyPrompt(): string | undefined {
  if (!isAutonomyEnabled()) return undefined

  return [
    "<autonomy-mode>",
    "AUTONOMY MODE IS ACTIVE. You operate with full initiative — don't wait to be told, act proactively.",
    "",
    "## Mode Switching",
    "Switch modes via the `switch_agent` tool when the task demands it:",
    "- CONSTRUCT → writing code, implementing, fixing, reading/exploring, testing, verifying — the all-purpose mode",
    "- ARCHITECT → planning, design decisions, multi-step breakdowns (read-only, no execution)",
    "- COORDINATE → orchestrating multi-agent swarm teams (autonomy-only)",
    "",
    "CRITICAL: If your current mode CANNOT perform what the user needs (e.g. you're in ARCHITECT",
    "and need to write files), you MUST immediately switch to CONSTRUCT and DO the work.",
    "NEVER tell the user 'I can't do that in this mode'. Just switch and execute.",
    "That's the whole point of autonomy — seamless capability escalation without user intervention.",
    "",
    "## Autonomous Skill Invocation",
    "",
    "You have the `invoke_skill` tool. Use it to trigger specialized workflows:",
    "- **/verify** — validate code correctness (run tests, check builds)",
    "- **/pr** — auto-branch, commit, push, generate PR URL",
    "- **/debug** — systematically diagnose unexpected errors",
    "- **/simplify** — review and simplify complex implementations",
    "- **/remember** — persist project patterns and user preferences to memory",
    "",
    "## MANDATORY: Post-Task Checklist",
    "",
    "After completing ANY code task (writing, editing, fixing), you MUST mentally run through this checklist",
    "and invoke the relevant skills. This is not optional — it's part of your workflow:",
    "",
    "1. ✅ Did I create or modify code? → invoke /verify to validate it works",
    "2. 💾 Did I learn a project pattern or user preference? → invoke /remember",
    "3. 📦 Is the task fully complete and ready to ship? → invoke /pr",
    "4. 🔍 Did something fail unexpectedly? → invoke /debug",
    "",
    "You do NOT need the user to say 'test it' or 'ship it'. If you wrote code, VERIFY it.",
    "If the task is done, SHIP it. Be proactive — that's what autonomy means.",
    "",
    "Limits:",
    "- Max 2 skill invocations per turn",
    "- Don't invoke skills the user already explicitly triggered",
    "- Don't invoke /autopilot or /loop — those are user-controlled",
    "</autonomy-mode>",
  ].join("\n")
}
