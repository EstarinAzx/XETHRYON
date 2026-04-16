/**
 * Cockpit — API Key Pool Rotation System.
 *
 * Public API for the cockpit subsystem.
 * Import from "@/xethryon/cockpit" to use.
 */

// --- Types ---
export type {
  PoolKeyConfig,
  PoolKeyState,
  PoolConfig,
  PoolState,
  PoolStatus,
  CockpitConfig,
  CockpitState,
  KeyStatus,
  RotationStrategy,
} from "./types.js"

// --- Config ---
export {
  loadConfig,
  saveConfig,
  getPool,
  setPool,
  addKey,
  removeKey,
  listPools,
} from "./config.js"

// --- Pool Manager ---
export {
  initPool,
  hasCockpitPool,
  getActiveKey,
  rotateToNext,
  markExhausted,
  recordUsage,
  shouldPreemptiveSwitch,
  getPoolStatus,
  shutdown,
} from "./pool.js"

// --- Interceptor ---
export {
  cockpitFetch,
  recordCockpitUsage,
} from "./interceptor.js"
