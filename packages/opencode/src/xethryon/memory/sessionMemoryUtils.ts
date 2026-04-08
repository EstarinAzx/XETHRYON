/**
 * Session memory state utilities for Xethryon.
 * Ported from cc-leak/src/services/SessionMemory/sessionMemoryUtils.ts.
 *
 * Adapted: Replaced getFsImplementation with fs/promises,
 * replaced logEvent with no-ops, simplified fs error checks.
 */

import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"

const EXTRACTION_WAIT_TIMEOUT_MS = 15000
const EXTRACTION_STALE_THRESHOLD_MS = 60000

/**
 * Configuration for session memory extraction thresholds.
 */
export type SessionMemoryConfig = {
  minimumMessageTokensToInit: number
  minimumTokensBetweenUpdate: number
  toolCallsBetweenUpdates: number
}

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 2000,
  minimumTokensBetweenUpdate: 1000,
  toolCallsBetweenUpdates: 1,
}

// --- Module state ---
let sessionMemoryConfig: SessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
let lastSummarizedMessageId: string | undefined
let extractionStartedAt: number | undefined
let tokensAtLastExtraction = 0
let sessionMemoryInitialized = false

// --- Session memory file path ---
let _sessionMemoryPath: string | undefined

export function setSessionMemoryPath(path: string): void {
  _sessionMemoryPath = path
}

export function getSessionMemoryPath(): string {
  if (_sessionMemoryPath) return _sessionMemoryPath
  // Default: ~/.xethryon/session-memory/current.md
  return join(homedir(), ".xethryon", "session-memory", "current.md")
}

// --- State accessors ---

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

export function setLastSummarizedMessageId(messageId: string | undefined): void {
  lastSummarizedMessageId = messageId
}

export function markExtractionStarted(): void {
  extractionStartedAt = Date.now()
}

export function markExtractionCompleted(): void {
  extractionStartedAt = undefined
}

/**
 * Wait for any in-progress session memory extraction to complete (15s timeout).
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now()
  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) return
    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) return
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/**
 * Get the current session memory content.
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const memoryPath = getSessionMemoryPath()
  try {
    return await readFile(memoryPath, { encoding: "utf-8" })
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return null
    throw e
  }
}

export function setSessionMemoryConfig(config: Partial<SessionMemoryConfig>): void {
  sessionMemoryConfig = { ...sessionMemoryConfig, ...config }
}

export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig }
}

export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount
}

export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized
}

export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true
}

export function hasMetInitializationThreshold(currentTokenCount: number): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit
}

export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction
  return tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
}

export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates
}

/**
 * Reset session memory state (for testing).
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  tokensAtLastExtraction = 0
  sessionMemoryInitialized = false
  lastSummarizedMessageId = undefined
  extractionStartedAt = undefined
  _sessionMemoryPath = undefined
}
