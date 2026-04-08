/**
 * Auto memory extraction service for Xethryon.
 *
 * Extracts knowledge from conversations and appends to daily logs.
 * The daily logs are later compiled into structured wiki articles
 * by the knowledge compiler (compiler.ts).
 *
 * Uses the trailing-run pattern (inProgress guard + pendingContext)
 * to avoid overlapping extractions while ensuring no turns are missed.
 */

import { Log } from "@/util/log"
import { isAutoMemoryEnabled } from "./paths.js"

const log = Log.create({ service: "xethryon.extractMemories" })

// --- Module state ---
let _initialized = false
let _inProgress = false
let _pendingContext: ExtractContext | null = null
let _lastExtractedMessageId: string | undefined

export interface ExtractContext {
  sessionID: string
  messages: Array<{
    id: string
    role: string
    parts?: Array<{ type: string }>
  }>
  /** Optional LLM callback for executing the extraction. When provided,
   *  the service will use it to actually call the model; otherwise it logs only. */
  llmCall?: (prompt: string) => Promise<string>
}

/**
 * Check if any messages since lastExtractedMessageId wrote to the memory directory.
 * If yes, skip extraction (the main agent already handled it).
 */
function hasMemoryWritesSince(
  messages: ExtractContext["messages"],
  sinceId: string | undefined,
): boolean {
  if (!sinceId) return false

  let foundStart = false
  for (const msg of messages) {
    if (!foundStart) {
      if (msg.id === sinceId) foundStart = true
      continue
    }
    if (msg.parts) {
      for (const part of msg.parts) {
        if (part.type === "tool") {
          // Conservative — don't skip. Let the extraction run.
        }
      }
    }
  }
  return false
}

/**
 * Count new messages since last extraction.
 */
function countNewMessages(
  messages: ExtractContext["messages"],
  sinceId: string | undefined,
): number {
  if (!sinceId) return messages.length

  let count = 0
  let foundStart = false
  for (const msg of messages) {
    if (!foundStart) {
      if (msg.id === sinceId) foundStart = true
      continue
    }
    count++
  }
  return count || messages.length
}



/**
 * Execute memory extraction for the given context.
 * Uses the trailing-run pattern to avoid overlapping extractions
 * while ensuring no turns are missed.
 */
export async function executeExtractMemories(
  context: ExtractContext,
): Promise<void> {
  if (!isAutoMemoryEnabled()) return

  if (_inProgress) {
    // Stash the latest context for a trailing run
    _pendingContext = context
    return
  }

  _inProgress = true
  let currentContext: ExtractContext | null = context

  try {
    while (currentContext) {
      await doExtraction(currentContext)
      // Check if a newer context was stashed while we were running
      currentContext = _pendingContext
      _pendingContext = null
    }
  } finally {
    _inProgress = false
  }
}

/**
 * Perform the actual extraction for a given context.
 * Appends to today's daily log using the Karpathy format.
 */
async function doExtraction(context: ExtractContext): Promise<void> {
  const { sessionID, messages, llmCall } = context

  // Skip if main agent already wrote memories
  if (hasMemoryWritesSince(messages, _lastExtractedMessageId)) {
    _lastExtractedMessageId = messages[messages.length - 1]?.id
    return
  }

  const newMessageCount = countNewMessages(messages, _lastExtractedMessageId)
  if (newMessageCount < 2) return // Need at least a user-assistant pair

  try {
    if (llmCall) {
      // Build extraction prompt targeting daily log format
      const extractPrompt = [
        "Review the recent conversation and extract anything worth preserving.",
        "Format your response as a structured daily log entry:",
        "",
        "**Context:** [One line about what the user was working on]",
        "",
        "**Key Exchanges:**",
        "- [Important Q&A or discussions]",
        "",
        "**Decisions Made:**",
        "- [Any decisions with rationale]",
        "",
        "**Lessons Learned:**",
        "- [Gotchas, patterns, or insights discovered]",
        "",
        "**Action Items:**",
        "- [Follow-ups or TODOs mentioned]",
        "",
        "Skip anything that is:",
        "- Routine tool calls or file reads",
        "- Content that's trivial or obvious",
        "",
        "Only include sections that have actual content.",
        "If nothing is worth saving, respond with exactly: FLUSH_OK",
        "",
        `Session ID: ${sessionID}`,
        `New messages since last extraction: ${newMessageCount}`,
      ].join("\n")

      const response = await llmCall(extractPrompt)

      if (response.includes("FLUSH_OK")) {
        log.info("LLM found nothing to extract", { sessionID })
      } else if (response.trim().length > 50) {
        // Append to daily log
        const { appendToDailyLog } = await import("./compiler.js")
        await appendToDailyLog(response.trim(), "Session")
        log.info("daily log entry appended from extraction", {
          sessionID,
          contentLength: response.trim().length,
        })
      }
    } else {
      log.info("memory extraction triggered (no LLM callback)", {
        sessionID,
        newMessageCount,
      })
    }

    // Update last extracted message
    _lastExtractedMessageId = messages[messages.length - 1]?.id
  } catch (e) {
    log.error("memory extraction failed", { error: e, sessionID })
  }
}

/**
 * Initialize the extract memories service.
 */
export function initExtractMemories(): void {
  if (_initialized) return
  _initialized = true
  log.info("extract memories initialized")
}

/**
 * Reset module state (for testing).
 */
export function resetExtractMemories(): void {
  _initialized = false
  _inProgress = false
  _pendingContext = null
  _lastExtractedMessageId = undefined
}
