/**
 * Xethryon Memory System — public API.
 *
 * Re-exports the memory subsystem for use by the session and system prompt modules.
 */

// --- Core types & constants ---
export { type MemoryType, parseMemoryType } from "./memoryTypes.js"
export { memoryAgeDays, memoryFreshnessText } from "./memoryAge.js"
export { parseFrontmatter, type FrontmatterResult } from "./frontmatter.js"

// --- Reliability layer ---
export {
  type ConfidenceLevel,
  CONFIDENCE_LEVELS,
  DEFAULT_EXPIRY_DAYS,
  parseConfidence,
  calculateExpiry,
} from "./frontmatter.js"
export {
  detectContradictions,
  formatConflictWarnings,
  type ConflictResult,
} from "./contradictions.js"

// --- Path resolution ---
export {
  isAutoMemoryEnabled,
  getAutoMemPath,
  getAutoMemEntrypoint,
  getAutoMemDailyLogPath,
  isAutoMemPath,
  validateMemoryPath,
} from "./paths.js"

// --- Memory scanning ---
export {
  scanMemoryFiles,
  formatMemoryManifest,
  type MemoryHeader,
} from "./memoryScan.js"

// --- Memory prompt builder ---
export {
  loadMemoryPrompt,
  buildMemoryPrompt,
  buildMemoryLines,
  ensureMemoryDirExists,
  truncateEntrypointContent,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from "./memdir.js"

// --- Memory relevance ---
export {
  findRelevantMemories,
  loadRelevantMemoryContent,
  type RelevantMemory,
} from "./findRelevantMemories.js"

// --- Session Memory ---
export {
  initSessionMemory,
  shouldExtractMemory,
  executeSessionMemoryExtraction,
} from "./sessionMemory.js"
export {
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from "./sessionMemoryUtils.js"
export { isSessionMemoryEmpty } from "./sessionMemoryPrompts.js"
export {
  truncateSessionMemoryForCompact,
  buildSessionMemoryUpdatePrompt,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
} from "./sessionMemoryPrompts.js"

// --- Extract Memories ---
export {
  executeExtractMemories,
  initExtractMemories,
  type ExtractContext,
} from "./extractMemories.js"

// --- AutoDream ---
export {
  executeAutoDream,
  initAutoDream,
  setAutoDreamConfig,
  isDreamPending,
  clearDreamPending,
} from "./autoDream.js"
export {
  readLastConsolidatedAt,
  recordConsolidation,
} from "./consolidationLock.js"
export { buildConsolidationPrompt } from "./consolidationPrompt.js"

// --- Memory Hook (prompt.ts integration) ---
export {
  initMemoryServices,
  runMemoryPostTurnHook,
  type MemoryHookContext,
} from "./memoryHook.js"

// --- Memory Retrieval (prompt-time query-based recall) ---
export {
  retrieveRelevantMemories,
} from "./retrieveMemories.js"
