/**
 * Compiler state tracking for the knowledge base.
 * Tracks which daily logs have been compiled, their hashes,
 * and compilation metadata.
 */

import { readFile, writeFile, mkdir } from "fs/promises"
import { dirname } from "path"
import { createHash } from "crypto"
import { getCompilerStatePath } from "./paths.js"
import { Log } from "@/util/log"

const log = Log.create({ service: "xethryon.compilerState" })

export interface IngestedEntry {
  hash: string
  compiledAt: string
  articlesCreated: string[]
  articlesUpdated: string[]
}

export interface CompilerState {
  ingested: Record<string, IngestedEntry>
  lastLint: string | null
  articleCount: number
}

const EMPTY_STATE: CompilerState = {
  ingested: {},
  lastLint: null,
  articleCount: 0,
}

/**
 * Load the compiler state from disk.
 */
export async function loadCompilerState(): Promise<CompilerState> {
  const statePath = getCompilerStatePath()
  try {
    const raw = await readFile(statePath, "utf-8")
    return { ...EMPTY_STATE, ...JSON.parse(raw) }
  } catch {
    return { ...EMPTY_STATE }
  }
}

/**
 * Save the compiler state to disk.
 */
export async function saveCompilerState(state: CompilerState): Promise<void> {
  const statePath = getCompilerStatePath()
  try {
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8")
  } catch (e) {
    log.error("failed to save compiler state", { error: e })
  }
}

/**
 * Compute SHA-256 hash of a file's content (first 16 hex chars).
 */
export async function fileHash(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath)
    return createHash("sha256").update(content).digest("hex").slice(0, 16)
  } catch {
    return ""
  }
}

/**
 * Check if a daily log needs compilation (new or changed since last compile).
 */
export async function needsCompilation(
  logPath: string,
  logName: string,
  state: CompilerState,
): Promise<boolean> {
  const prev = state.ingested[logName]
  if (!prev) return true
  const currentHash = await fileHash(logPath)
  return currentHash !== prev.hash
}

/**
 * Record a successful compilation.
 */
export async function recordCompilation(
  state: CompilerState,
  logName: string,
  logPath: string,
  articlesCreated: string[],
  articlesUpdated: string[],
): Promise<void> {
  const hash = await fileHash(logPath)
  state.ingested[logName] = {
    hash,
    compiledAt: new Date().toISOString(),
    articlesCreated,
    articlesUpdated,
  }
  state.articleCount = Object.keys(state.ingested).length
  await saveCompilerState(state)
}
