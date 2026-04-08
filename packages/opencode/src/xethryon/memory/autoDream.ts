/**
 * AutoDream — background memory consolidation for Xethryon.
 * Ported from cc-leak/src/services/autoDream/autoDream.ts.
 *
 * Phase 3: Wired into SessionPrompt.command for actual /dream execution.
 * - When time+session gates pass, schedules a /dream command on the next session
 * - Uses the LLM callback from memoryHook for direct consolidation
 * - Preserved the time + session gatekeeping pattern
 */

import { readdir, stat } from "fs/promises"
import { join } from "path"
import { Log } from "@/util/log"
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths.js"
import { buildConsolidationPrompt } from "./consolidationPrompt.js"
import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  recordConsolidation,
} from "./consolidationLock.js"

const log = Log.create({ service: "xethryon.autoDream" })

// Scan throttle: when time-gate passes but session-gate doesn't
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

type AutoDreamConfig = {
  minHours: number
  minSessions: number
}

const DEFAULTS: AutoDreamConfig = {
  minHours: 0,
  minSessions: 1,
}

// --- Module state ---
let _initialized = false
let _lastSessionScanAt = 0
let _config: AutoDreamConfig = { ...DEFAULTS }
let _dreamPending = false

/**
 * Configure autoDream thresholds.
 */
export function setAutoDreamConfig(config: Partial<AutoDreamConfig>): void {
  _config = { ..._config, ...config }
}

/**
 * Count memory files modified after a given timestamp.
 * This is a proxy for "sessions that generated new memories" —
 * simpler than scanning transcript directories.
 */
async function countRecentMemoryChanges(sinceMs: number): Promise<number> {
  const memDir = getAutoMemPath()
  try {
    const entries = await readdir(memDir)
    let count = 0
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      try {
        const s = await stat(join(memDir, entry))
        if (s.mtimeMs > sinceMs) count++
      } catch {
        // Skip unreadable files
      }
    }
    return count
  } catch {
    return 0
  }
}

/**
 * Check all gates and fire consolidation if warranted.
 * Gate order (cheapest first):
 *   1. Feature enabled
 *   2. Time: hours since lastConsolidatedAt >= minHours
 *   3. Scan throttle
 *   4. Session gate: enough recent activity
 *   5. Lock: no other process mid-consolidation
 */
export async function executeAutoDream(
  sessionID: string,
  llmCall?: (prompt: string) => Promise<string>,
): Promise<void> {
  if (!isAutoMemoryEnabled()) return

  // --- Time gate ---
  let lastAt: number
  try {
    lastAt = await readLastConsolidatedAt()
  } catch (e) {
    log.warn("readLastConsolidatedAt failed", { error: e })
    return
  }
  const hoursSince = (Date.now() - lastAt) / 3_600_000
  if (hoursSince < _config.minHours) return

  // --- Scan throttle ---
  const sinceScanMs = Date.now() - _lastSessionScanAt
  if (sinceScanMs < SESSION_SCAN_INTERVAL_MS) return
  _lastSessionScanAt = Date.now()

  // --- Session/activity gate ---
  const recentChanges = await countRecentMemoryChanges(lastAt)
  if (recentChanges < _config.minSessions) {
    log.info("autoDream skip — not enough activity", {
      recentChanges,
      needed: _config.minSessions,
    })
    return
  }

  // --- Lock ---
  let priorMtime: number | null
  try {
    priorMtime = await tryAcquireConsolidationLock()
  } catch (e) {
    log.warn("lock acquire failed", { error: e })
    return
  }
  if (priorMtime === null) return

  log.info("autoDream firing", {
    hoursSince: hoursSince.toFixed(1),
    recentChanges,
  })

  try {
    const memoryRoot = getAutoMemPath()

    if (llmCall) {
      // ─── Step 1: Compile daily logs → knowledge articles ───
      log.info("autoDream: running knowledge compilation", { sessionID })
      try {
        const { runCompilation } = await import("./compiler.js")
        const compileResult = await runCompilation(llmCall)
        log.info("autoDream: compilation complete", {
          compiled: compileResult.compiled,
          created: compileResult.articlesCreated.length,
          updated: compileResult.articlesUpdated.length,
        })
      } catch (e) {
        log.error("autoDream: compilation failed (continuing)", { error: e })
      }

      // ─── Step 2: Run structural lint (free, no LLM) ───
      try {
        const { runStructuralLint, formatLintReport } = await import("./lint.js")
        const issues = await runStructuralLint()
        if (issues.length > 0) {
          log.info("autoDream: lint report", { report: formatLintReport(issues) })
        }
      } catch (e) {
        log.error("autoDream: lint failed (continuing)", { error: e })
      }

      // ─── Step 3: Memory consolidation (existing behavior) ───
      log.info("autoDream: executing LLM consolidation", {
        sessionID,
        memoryRoot,
      })

      const extra = `
**Tool constraints for this run:** Bash is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar). Anything that writes, redirects to a file, or modifies state will be denied.

Recent memory activity: ${recentChanges} files modified since last consolidation.`

      const prompt = buildConsolidationPrompt(memoryRoot, memoryRoot, extra)
      const response = await llmCall(prompt)

      // Record successful consolidation
      await recordConsolidation()

      log.info("autoDream consolidation complete", {
        sessionID,
        responseLength: response.length,
      })
    } else {
      // No LLM callback — mark as pending for /dream command
      _dreamPending = true
      log.info("autoDream prompt built — pending /dream execution", {
        sessionID,
        memoryRoot,
      })
    }
  } catch (e) {
    log.error("autoDream failed", { error: e })
    await rollbackConsolidationLock(priorMtime)
  }
}

/**
 * Check if autoDream has a pending consolidation.
 */
export function isDreamPending(): boolean {
  return _dreamPending
}

/**
 * Clear the pending dream flag (after /dream executes).
 */
export function clearDreamPending(): void {
  _dreamPending = false
}

/**
 * Initialize autoDream service.
 */
export function initAutoDream(): void {
  if (_initialized) return
  _initialized = true
  log.info("autoDream initialized")
}

/**
 * Reset module state (for testing).
 */
export function resetAutoDream(): void {
  _initialized = false
  _lastSessionScanAt = 0
  _config = { ...DEFAULTS }
  _dreamPending = false
}
