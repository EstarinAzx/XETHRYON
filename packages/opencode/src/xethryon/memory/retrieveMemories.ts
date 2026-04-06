/**
 * Memory retrieval bridge for Xethryon.
 *
 * Connects the prompt pipeline to the memory relevance engine.
 * Given the user's latest query, retrieves and formats relevant
 * memories for injection into the system prompt.
 *
 * Includes reliability layer:
 * - Expired memories are excluded (handled by scanMemoryFiles)
 * - Stale memories get a warning tag
 * - Confidence levels are displayed
 */

import { Log } from "@/util/log"
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths.js"
import { loadRelevantMemoryContent } from "./findRelevantMemories.js"
import { getSessionMemoryContent } from "./sessionMemoryUtils.js"
import { scanMemoryFiles } from "./memoryScan.js"

const log = Log.create({ service: "xethryon.retrieveMemories" })

/**
 * Retrieve memories relevant to the user's current query.
 *
 * Returns a formatted string containing:
 * 1. Session memory (current conversation summary)
 * 2. Relevant topic memories from past sessions
 * 3. Reliability metadata (confidence, staleness warnings)
 *
 * Returns null if memory is disabled or nothing is relevant.
 */
export async function retrieveRelevantMemories(
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isAutoMemoryEnabled()) return null
  if (!query || query.trim().length < 5) return null

  const memoryDir = getAutoMemPath()
  const sections: string[] = []

  // 1. Session memory — running summary of the current conversation
  try {
    const sessionMemory = await getSessionMemoryContent()
    if (sessionMemory && sessionMemory.trim().length > 50) {
      sections.push(
        "## Current Session Context",
        "",
        sessionMemory.trim(),
      )
    }
  } catch (e) {
    log.warn("failed to load session memory", { error: e })
  }

  // 2. Relevant topic memories from past sessions
  try {
    const abortSignal = signal ?? new AbortController().signal
    const relevant = await loadRelevantMemoryContent(
      query,
      memoryDir,
      abortSignal,
    )
    if (relevant) {
      sections.push(
        "## Relevant Memories",
        "",
        "The following memories from past sessions may be relevant to the current conversation:",
        "",
        relevant,
      )
    }
  } catch (e) {
    log.warn("failed to retrieve relevant memories", { error: e })
  }

  // 3. Staleness check — warn about memories approaching expiry
  try {
    const abortSignal = signal ?? new AbortController().signal
    const headers = await scanMemoryFiles(memoryDir, abortSignal)
    const staleMemories = headers.filter((m) => m.isStale)
    if (staleMemories.length > 0) {
      sections.push(
        "## ⚠ Memory Reliability Notices",
        "",
        "The following memories are approaching their expiry date. Verify they are still accurate before relying on them:",
        "",
        ...staleMemories.slice(0, 5).map((m) => {
          const desc = m.description || m.filename
          return `- **${desc}** (expires: ${m.expires}, confidence: ${m.confidence})`
        }),
      )
    }
  } catch (e) {
    log.warn("failed to check memory staleness", { error: e })
  }

  if (sections.length === 0) return null

  const result = [
    "<recalled_memories>",
    ...sections,
    "</recalled_memories>",
  ].join("\n")

  log.info("retrieved relevant memories", {
    queryLength: query.length,
    resultLength: result.length,
  })

  return result
}
