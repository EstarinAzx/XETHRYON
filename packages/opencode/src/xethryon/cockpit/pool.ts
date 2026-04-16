/**
 * Cockpit — Pool Manager.
 *
 * In-memory pool state with periodic disk persistence.
 * Manages key rotation, exhaustion tracking, and usage recording.
 */

import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { Log } from "@/util/log"
import { loadConfig } from "./config.js"
import type {
  CockpitState,
  PoolState,
  PoolKeyState,
  PoolStatus,
  KeyStatus,
  PoolKeyConfig,
} from "./types.js"

const log = Log.create({ service: "xethryon.cockpit.pool" })

const STATE_DIR = join(homedir(), ".xethryon")
const STATE_PATH = join(STATE_DIR, "cockpit-state.json")

// ─── In-memory state ───────────────────────────────────────

let _state: CockpitState | undefined
let _flushTimer: ReturnType<typeof setInterval> | undefined

function defaultKeyState(id: string): PoolKeyState {
  return {
    id,
    status: "active",
    sessionTokens: 0,
    weeklyTokens: 0,
    totalRequests: 0,
    totalFailures: 0,
  }
}

function defaultPoolState(provider: string, keyCount: number): PoolState {
  return {
    provider,
    activeIndex: 0,
    keys: [],
    lastFlushed: Date.now(),
  }
}

// ─── State I/O ─────────────────────────────────────────────

async function loadState(): Promise<CockpitState> {
  try {
    if (!existsSync(STATE_PATH)) return { pools: {} }
    const raw = await readFile(STATE_PATH, "utf-8")
    return JSON.parse(raw) as CockpitState
  } catch {
    return { pools: {} }
  }
}

async function flushState(): Promise<void> {
  if (!_state) return
  try {
    _state.pools = Object.fromEntries(
      Object.entries(_state.pools).map(([k, v]) => [k, { ...v, lastFlushed: Date.now() }]),
    )
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(STATE_PATH, JSON.stringify(_state, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    })
  } catch (e) {
    log.warn("failed to flush cockpit state", { error: e })
  }
}

// ─── Initialization ────────────────────────────────────────

let _initialized = false
let _initPromise: Promise<void> | undefined

async function ensureInit(): Promise<void> {
  if (_initialized) return
  if (_initPromise) return _initPromise
  _initPromise = initPool().then(() => {
    _initialized = true
    _initPromise = undefined
  })
  return _initPromise
}

export async function initPool(): Promise<void> {
  const config = await loadConfig()
  const savedState = await loadState()
  _state = { pools: {} }

  for (const [provider, poolConfig] of Object.entries(config.pools)) {
    const saved = savedState.pools[provider]
    const keyStates: PoolKeyState[] = poolConfig.keys.map((k) => {
      const existing = saved?.keys.find((s) => s.id === k.id)
      if (existing) return existing
      return defaultKeyState(k.id)
    })

    _state.pools[provider] = {
      provider,
      activeIndex: saved?.activeIndex ?? 0,
      keys: keyStates,
      lastFlushed: Date.now(),
    }

    // Clamp active index
    if (_state.pools[provider].activeIndex >= poolConfig.keys.length) {
      _state.pools[provider].activeIndex = 0
    }
  }

  // Auto-flush every 30s
  if (_flushTimer) clearInterval(_flushTimer)
  _flushTimer = setInterval(() => flushState(), 30_000)

  const poolCount = Object.keys(_state.pools).length
  const keyCount = Object.values(_state.pools).reduce((sum, p) => sum + p.keys.length, 0)
  if (poolCount > 0) {
    log.info("cockpit initialized", { pools: poolCount, totalKeys: keyCount })
  }
  _initialized = true
}

// ─── Pool Queries ──────────────────────────────────────────

function getState(): CockpitState {
  if (!_state) throw new Error("Cockpit not initialized — call initPool() first")
  return _state
}

export function hasCockpitPool(provider: string): boolean {
  // Fast path: already initialized
  if (_initialized && _state) {
    const pool = _state.pools[provider]
    return pool !== undefined && pool.keys.length > 0
  }

  // First-time synchronous check: does the config file even exist?
  // This avoids the async race where first request bypasses cockpit
  if (!_initialized) {
    try {
      const fs = require("fs")
      const configPath = require("path").join(require("os").homedir(), ".xethryon", "cockpit.json")
      if (!fs.existsSync(configPath)) {
        _initialized = true // No config = no cockpit, skip future checks
        _state = { pools: {} }
        return false
      }
      // Config exists — do synchronous init
      const raw = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(raw)
      if (!config.pools || Object.keys(config.pools).length === 0) {
        _initialized = true
        _state = { pools: {} }
        return false
      }
      // We have pools — trigger full async init for state loading
      ensureInit().catch(() => {})

      // Meanwhile, check if this provider has keys in the raw config
      const pool = config.pools[provider]
      return pool !== undefined && Array.isArray(pool.keys) && pool.keys.length > 0
    } catch {
      _initialized = true
      _state = { pools: {} }
      return false
    }
  }

  return false
}

export function getActiveKey(provider: string): (PoolKeyConfig & { _stateIndex: number }) | undefined {
  const state = getState()
  const pool = state.pools[provider]
  if (!pool || pool.keys.length === 0) return undefined

  // Walk from activeIndex, find first non-exhausted key
  for (let i = 0; i < pool.keys.length; i++) {
    const idx = (pool.activeIndex + i) % pool.keys.length
    const keyState = pool.keys[idx]

    // Check if exhaustion has expired — session resets after ~5h
    if (keyState.status === "session_exhausted" && keyState.exhaustedAt) {
      const elapsed = Date.now() - keyState.exhaustedAt
      if (elapsed > 5 * 60 * 60 * 1000) {
        // 5 hour rolling window likely reset
        keyState.status = "active"
        keyState.sessionTokens = 0
        keyState.exhaustedAt = undefined
        log.info("key session cooldown expired, reactivated", { provider, keyId: keyState.id })
      }
    }

    // Check weekly exhaustion — try again after 24h as a conservative check
    if (keyState.status === "weekly_exhausted" && keyState.exhaustedAt) {
      const elapsed = Date.now() - keyState.exhaustedAt
      if (elapsed > 24 * 60 * 60 * 1000) {
        // Try this key again — it might have reset
        keyState.status = "active"
        keyState.weeklyTokens = 0
        keyState.exhaustedAt = undefined
        log.info("key weekly cooldown check — retrying", { provider, keyId: keyState.id })
      }
    }

    if (keyState.status === "active") {
      // Resolve the config key
      // We need to get the actual apiKey from config since state doesn't store it
      pool.activeIndex = idx
      return { ...getConfigKey(provider, keyState.id)!, _stateIndex: idx }
    }
  }

  // All keys exhausted
  log.warn("all cockpit keys exhausted", { provider })
  return undefined
}

function getConfigKey(provider: string, keyId: string): PoolKeyConfig | undefined {
  // Synchronous config read from cached state — we loaded config during init
  // For runtime, we cache the config keys alongside state
  try {
    const configStr = require("fs").readFileSync(
      join(homedir(), ".xethryon", "cockpit.json"),
      "utf-8",
    )
    const config = JSON.parse(configStr)
    return config.pools?.[provider]?.keys?.find((k: any) => k.id === keyId)
  } catch {
    return undefined
  }
}

// ─── Rotation ──────────────────────────────────────────────

export function rotateToNext(provider: string): (PoolKeyConfig & { _stateIndex: number }) | undefined {
  const state = getState()
  const pool = state.pools[provider]
  if (!pool) return undefined

  // Move past current
  pool.activeIndex = (pool.activeIndex + 1) % pool.keys.length
  log.info("rotating to next key", {
    provider,
    newIndex: pool.activeIndex,
    keyId: pool.keys[pool.activeIndex]?.id,
  })

  return getActiveKey(provider)
}

export function markExhausted(
  provider: string,
  keyId: string,
  type: "session_exhausted" | "weekly_exhausted",
): void {
  const state = getState()
  const pool = state.pools[provider]
  if (!pool) return

  const key = pool.keys.find((k) => k.id === keyId)
  if (!key) return

  // If it was already session_exhausted and gets another 429 quickly,
  // escalate to weekly_exhausted
  if (key.status === "session_exhausted" && type === "session_exhausted") {
    const timeSince = key.exhaustedAt ? Date.now() - key.exhaustedAt : Infinity
    if (timeSince < 30_000) {
      // Got 429 again within 30s of being marked session_exhausted → probably weekly
      type = "weekly_exhausted"
    }
  }

  key.status = type
  key.exhaustedAt = Date.now()
  key.totalFailures++

  log.info("key marked exhausted", { provider, keyId, type })

  // Trigger async flush
  flushState().catch(() => {})
}

export function recordUsage(provider: string, keyId: string, tokens: number): void {
  if (!_state) return
  const pool = _state.pools[provider]
  if (!pool) return

  const key = pool.keys.find((k) => k.id === keyId)
  if (!key) return

  key.sessionTokens += tokens
  key.weeklyTokens += tokens
  key.totalRequests++
}

// ─── Pre-emptive Check ─────────────────────────────────────

export function shouldPreemptiveSwitch(provider: string): boolean {
  if (!_state) return false
  const pool = _state.pools[provider]
  if (!pool) return false

  const key = pool.keys[pool.activeIndex]
  if (!key || key.status !== "active") return false

  // Need config for limits
  try {
    const configStr = require("fs").readFileSync(
      join(homedir(), ".xethryon", "cockpit.json"),
      "utf-8",
    )
    const config = JSON.parse(configStr)
    const poolConfig = config.pools?.[provider]
    if (!poolConfig?.weeklyLimit) return false

    const usagePercent = (key.weeklyTokens / poolConfig.weeklyLimit) * 100
    return usagePercent >= (poolConfig.switchAtPercent ?? 85)
  } catch {
    return false
  }
}

// ─── Status ────────────────────────────────────────────────

export function getPoolStatus(provider: string): PoolStatus | undefined {
  if (!_state) return undefined
  const pool = _state.pools[provider]
  if (!pool || pool.keys.length === 0) return undefined

  const configKeys = (() => {
    try {
      const raw = require("fs").readFileSync(
        join(homedir(), ".xethryon", "cockpit.json"),
        "utf-8",
      )
      return JSON.parse(raw).pools?.[provider]?.keys ?? []
    } catch {
      return []
    }
  })() as PoolKeyConfig[]

  const combined = pool.keys.map((s) => {
    const cfg = configKeys.find((c) => c.id === s.id) ?? { id: s.id, apiKey: "" }
    return { ...cfg, ...s }
  })

  const activeKey = combined[pool.activeIndex] ?? combined[0]
  const allExhausted = combined.every((k) => k.status !== "active")

  return {
    provider,
    totalKeys: combined.length,
    activeKey,
    activeIndex: pool.activeIndex,
    keys: combined,
    strategy: "failover", // from config, simplified for now
    allExhausted,
  }
}

// ─── Cleanup ───────────────────────────────────────────────

export async function shutdown(): Promise<void> {
  if (_flushTimer) {
    clearInterval(_flushTimer)
    _flushTimer = undefined
  }
  await flushState()
}
