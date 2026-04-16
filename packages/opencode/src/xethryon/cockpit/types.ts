/**
 * Cockpit — API Key Pool Rotation System
 *
 * Types for key pool management, rotation strategies,
 * and per-key usage tracking.
 */

export type KeyStatus = "active" | "session_exhausted" | "weekly_exhausted"

export type RotationStrategy = "failover" | "round-robin"

export interface PoolKeyConfig {
  /** Human-readable name for this key (e.g. "main", "alt-1") */
  id: string
  /** The actual API key string */
  apiKey: string
}

export interface PoolKeyState {
  /** Matches the config key id */
  id: string
  /** Current status */
  status: KeyStatus
  /** Timestamp when this key was marked exhausted */
  exhaustedAt?: number
  /** Total tokens used in current session window */
  sessionTokens: number
  /** Total tokens used in current weekly window */
  weeklyTokens: number
  /** Timestamp of last weekly reset */
  weeklyResetAt?: number
  /** Total requests made with this key */
  totalRequests: number
  /** Total 429 errors hit on this key */
  totalFailures: number
}

export interface PoolConfig {
  /** Provider ID (e.g. "ollama-cloud") */
  provider: string
  /** List of API keys in this pool */
  keys: PoolKeyConfig[]
  /** Rotation strategy */
  strategy: RotationStrategy
  /** Pre-emptive switch threshold percentage (default 85) */
  switchAtPercent: number
  /** User-set weekly token limit per key (estimated) */
  weeklyLimit?: number
  /** User-set session token limit per key (estimated) */
  sessionLimit?: number
}

export interface PoolState {
  /** Provider ID */
  provider: string
  /** Index of the currently active key */
  activeIndex: number
  /** Per-key runtime state */
  keys: PoolKeyState[]
  /** Timestamp of last state flush to disk */
  lastFlushed: number
}

export interface CockpitConfig {
  pools: Record<string, PoolConfig>
}

export interface CockpitState {
  pools: Record<string, PoolState>
}

export interface PoolStatus {
  provider: string
  totalKeys: number
  activeKey: PoolKeyConfig & PoolKeyState
  activeIndex: number
  keys: Array<PoolKeyConfig & PoolKeyState>
  strategy: RotationStrategy
  allExhausted: boolean
}
