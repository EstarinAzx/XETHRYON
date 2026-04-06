/**
 * Memory contradiction detection.
 *
 * Lightweight keyword-based conflict detection for the memory reliability layer.
 * When a new memory is being saved, scans existing memories of the same type
 * for potential contradictions based on keyword overlap in descriptions.
 *
 * NOT semantic similarity — just keyword overlap. Fast and effective for
 * obvious contradictions like "use tabs" vs "use spaces".
 */

import { scanMemoryFiles, type MemoryHeader } from "./memoryScan.js"
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths.js"
import { Log } from "@/util/log"

const log = Log.create({ service: "xethryon.contradictions" })

/**
 * Minimum keyword overlap ratio to consider two memories as potentially contradicting.
 * 0.5 = 50% of keywords must overlap.
 */
const OVERLAP_THRESHOLD = 0.5

/**
 * Words to ignore when comparing descriptions (too common to be meaningful).
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "shall",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "and", "or", "but", "not", "no", "nor",
  "this", "that", "these", "those", "it", "its",
  "use", "uses", "using", "used", "when", "if", "then",
])

/**
 * Extract meaningful keywords from a description string.
 */
function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  )
}

/**
 * Calculate the overlap ratio between two keyword sets.
 * Returns a number between 0 and 1.
 */
function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let matches = 0
  for (const word of a) {
    if (b.has(word)) matches++
  }
  const smaller = Math.min(a.size, b.size)
  return matches / smaller
}

export interface ConflictResult {
  /** The existing memory that may conflict */
  existing: MemoryHeader
  /** Overlap score (0-1) */
  overlapScore: number
  /** Shared keywords */
  sharedKeywords: string[]
}

/**
 * Check if a new memory description conflicts with existing memories.
 *
 * @param newDescription - The description of the memory being saved
 * @param newType - The type of the memory being saved (only checks same type)
 * @returns Array of potential conflicts, sorted by overlap score (highest first)
 */
export async function detectContradictions(
  newDescription: string,
  newType?: string,
): Promise<ConflictResult[]> {
  if (!isAutoMemoryEnabled()) return []
  if (!newDescription || newDescription.trim().length < 10) return []

  const memoryDir = getAutoMemPath()
  const controller = new AbortController()

  try {
    const headers = await scanMemoryFiles(memoryDir, controller.signal, true)
    const newKeywords = extractKeywords(newDescription)

    if (newKeywords.size < 2) return []

    const conflicts: ConflictResult[] = []

    for (const header of headers) {
      // Only compare same-type memories (feedback vs feedback, etc.)
      if (newType && header.type !== newType) continue
      if (!header.description) continue

      const existingKeywords = extractKeywords(header.description)
      const overlap = keywordOverlap(newKeywords, existingKeywords)

      if (overlap >= OVERLAP_THRESHOLD) {
        const shared: string[] = []
        for (const word of newKeywords) {
          if (existingKeywords.has(word)) shared.push(word)
        }
        conflicts.push({
          existing: header,
          overlapScore: overlap,
          sharedKeywords: shared,
        })
      }
    }

    conflicts.sort((a, b) => b.overlapScore - a.overlapScore)

    if (conflicts.length > 0) {
      log.info("detected potential memory contradictions", {
        newDescription: newDescription.slice(0, 80),
        conflictCount: conflicts.length,
      })
    }

    return conflicts
  } catch (e) {
    log.warn("contradiction detection failed", { error: e })
    return []
  }
}

/**
 * Format contradiction warnings for system prompt injection.
 * Used during memory extraction to warn the agent about potential conflicts.
 */
export function formatConflictWarnings(conflicts: ConflictResult[]): string {
  if (conflicts.length === 0) return ""

  const lines = [
    "⚠ POTENTIAL MEMORY CONFLICTS DETECTED:",
    "",
    "The following existing memories may conflict with what you're about to save.",
    "Consider updating or removing the old memory instead of creating a duplicate.",
    "",
  ]

  for (const c of conflicts.slice(0, 3)) {
    const score = Math.round(c.overlapScore * 100)
    lines.push(`- "${c.existing.description}" (${c.existing.filename}, ${score}% overlap)`)
    lines.push(`  Shared topics: ${c.sharedKeywords.join(", ")}`)
    if (c.existing.isExpired) {
      lines.push(`  ↳ This memory is EXPIRED — safe to replace.`)
    } else if (c.existing.isStale) {
      lines.push(`  ↳ This memory is STALE — approaching expiry, consider replacing.`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
