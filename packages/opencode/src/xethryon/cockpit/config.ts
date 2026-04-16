/**
 * Cockpit — Config persistence.
 *
 * Stores pool configuration (keys, strategy, limits) in
 * ~/.xethryon/cockpit.json with restricted file permissions.
 */

import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { Log } from "@/util/log"
import type { CockpitConfig, PoolConfig, PoolKeyConfig } from "./types.js"

const log = Log.create({ service: "xethryon.cockpit.config" })

const CONFIG_DIR = join(homedir(), ".xethryon")
const CONFIG_PATH = join(CONFIG_DIR, "cockpit.json")

function defaultConfig(): CockpitConfig {
  return { pools: {} }
}

export async function loadConfig(): Promise<CockpitConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultConfig()
    const raw = await readFile(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    return { pools: parsed.pools ?? {} }
  } catch (e) {
    log.warn("failed to load cockpit config, using defaults", { error: e })
    return defaultConfig()
  }
}

export async function saveConfig(config: CockpitConfig): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    })
  } catch (e) {
    log.error("failed to save cockpit config", { error: e })
    throw e
  }
}

export async function getPool(provider: string): Promise<PoolConfig | undefined> {
  const config = await loadConfig()
  return config.pools[provider]
}

export async function setPool(provider: string, pool: PoolConfig): Promise<void> {
  const config = await loadConfig()
  config.pools[provider] = pool
  await saveConfig(config)
}

export async function addKey(provider: string, key: PoolKeyConfig): Promise<void> {
  const config = await loadConfig()
  if (!config.pools[provider]) {
    config.pools[provider] = {
      provider,
      keys: [],
      strategy: "failover",
      switchAtPercent: 85,
    }
  }
  // Deduplicate by id
  const existing = config.pools[provider].keys.findIndex((k) => k.id === key.id)
  if (existing >= 0) {
    config.pools[provider].keys[existing] = key
  } else {
    config.pools[provider].keys.push(key)
  }
  await saveConfig(config)
  log.info("added key to pool", { provider, keyId: key.id })
}

export async function removeKey(provider: string, keyId: string): Promise<void> {
  const config = await loadConfig()
  const pool = config.pools[provider]
  if (!pool) return
  pool.keys = pool.keys.filter((k) => k.id !== keyId)
  if (pool.keys.length === 0) {
    delete config.pools[provider]
  }
  await saveConfig(config)
  log.info("removed key from pool", { provider, keyId })
}

export async function listPools(): Promise<Record<string, PoolConfig>> {
  const config = await loadConfig()
  return config.pools
}
