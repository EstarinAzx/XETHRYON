/**
 * Swarm state singleton.
 * Manages the active swarm runtime (teammates, abort controllers).
 *
 * Uses process.env for the active team name (survives module duplication
 * by bundlers) and a globalThis symbol for the teammates map.
 * This ensures the TUI dialog can read the same state as the server tools.
 */

import type { ActiveTeammate, TeammateStatus } from "./types.js"

// ---------------------------------------------------------------------------
// Global state (bundler-safe — survives module duplication)
// ---------------------------------------------------------------------------

// Use a unique symbol key on globalThis so the teammates map is shared
// across any module instances that might get duplicated by the bundler.
const TEAMMATES_KEY = Symbol.for("xethryon.swarm.activeTeammates")

function getTeammatesMap(): Map<string, ActiveTeammate> {
  if (!(globalThis as any)[TEAMMATES_KEY]) {
    ;(globalThis as any)[TEAMMATES_KEY] = new Map<string, ActiveTeammate>()
  }
  return (globalThis as any)[TEAMMATES_KEY]
}

// ---------------------------------------------------------------------------
// Team state (uses process.env — truly global)
// ---------------------------------------------------------------------------

export function setActiveTeam(teamName: string): void {
  process.env.XETHRYON_ACTIVE_TEAM = teamName
}

export function getActiveTeam(): string | null {
  return process.env.XETHRYON_ACTIVE_TEAM ?? null
}

export function clearActiveTeam(): void {
  delete process.env.XETHRYON_ACTIVE_TEAM
}

// ---------------------------------------------------------------------------
// Teammate tracking
// ---------------------------------------------------------------------------

export function registerTeammate(teammate: ActiveTeammate): void {
  getTeammatesMap().set(teammate.agentId, teammate)
}

export function unregisterTeammate(agentId: string): void {
  getTeammatesMap().delete(agentId)
}

export function getTeammate(agentId: string): ActiveTeammate | undefined {
  return getTeammatesMap().get(agentId)
}

export function getAllTeammates(): ActiveTeammate[] {
  return [...getTeammatesMap().values()]
}

export function getTeammatesForTeam(teamName: string): ActiveTeammate[] {
  return [...getTeammatesMap().values()].filter((t) => t.teamName === teamName)
}

export function updateTeammateStatus(agentId: string, status: TeammateStatus): void {
  const t = getTeammatesMap().get(agentId)
  if (t) t.status = status
}

/**
 * Abort a teammate (signal its abort controller).
 */
export function abortTeammate(agentId: string): boolean {
  const t = getTeammatesMap().get(agentId)
  if (!t) return false
  t.abortController.abort()
  t.status = "stopped"
  return true
}

/**
 * Abort all teammates for a given team.
 */
export function abortAllTeammates(teamName: string): number {
  let count = 0
  for (const t of getTeammatesMap().values()) {
    if (t.teamName === teamName && t.status !== "stopped") {
      t.abortController.abort()
      t.status = "stopped"
      count++
    }
  }
  return count
}

/**
 * Cleanup all active teammates (abort and unregister).
 */
export function cleanupAllTeammates(): void {
  const map = getTeammatesMap()
  for (const t of map.values()) {
    if (t.status !== "stopped") {
      t.abortController.abort()
    }
  }
  map.clear()
  delete process.env.XETHRYON_ACTIVE_TEAM
}
