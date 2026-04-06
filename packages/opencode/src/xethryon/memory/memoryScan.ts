/**
 * Memory-directory scanning primitives.
 * Ported from cc-leak/src/memdir/memoryScan.ts.
 *
 * Includes memory reliability layer: confidence, expiry, staleness.
 */

import { readdir, readFile, stat } from "fs/promises"
import { basename, join } from "path"
import { parseFrontmatter, parseConfidence, calculateExpiry, type ConfidenceLevel } from "./frontmatter.js"
import { type MemoryType, parseMemoryType } from "./memoryTypes.js"

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
  // Reliability fields
  confidence: ConfidenceLevel
  created: string       // ISO date string (YYYY-MM-DD)
  expires: string | null // ISO date string or null (never expires)
  isExpired: boolean
  isStale: boolean       // within 7 days of expiry
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30
const STALE_WARNING_DAYS = 7

/**
 * Check if a memory is expired based on its expiry date.
 */
function checkExpired(expires: string | null): boolean {
  if (!expires) return false
  return new Date() > new Date(expires)
}

/**
 * Check if a memory is stale (within STALE_WARNING_DAYS of expiry).
 */
function checkStale(expires: string | null): boolean {
  if (!expires) return false
  const expiryDate = new Date(expires)
  const warningDate = new Date()
  warningDate.setDate(warningDate.getDate() + STALE_WARNING_DAYS)
  return warningDate >= expiryDate && !checkExpired(expires)
}

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted by confidence (high first), then newest-first.
 * Expired memories are excluded by default.
 *
 * Set includeExpired=true to include them (e.g. for cleanup tools).
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
  includeExpired = false,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      (f) => f.endsWith(".md") && basename(f) !== "MEMORY.md",
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        if (signal.aborted) throw new Error("aborted")

        const filePath = join(memoryDir, relativePath)
        const [content, fileStat] = await Promise.all([
          readFile(filePath, "utf-8").then(
            (c) => c.split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n"),
          ),
          stat(filePath),
        ])

        const { data } = parseFrontmatter(content)
        const memType = parseMemoryType(data.type)
        const created = data.created || new Date(fileStat.mtimeMs).toISOString().slice(0, 10)
        const expires = data.expires || calculateExpiry(memType, new Date(created))

        return {
          filename: relativePath,
          filePath,
          mtimeMs: fileStat.mtimeMs,
          description: data.description || null,
          type: memType,
          confidence: parseConfidence(data.confidence) ?? "medium",
          created,
          expires,
          isExpired: checkExpired(expires),
          isStale: checkStale(expires),
        }
      }),
    )

    const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2 }

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value)
      .filter((m) => includeExpired || !m.isExpired)
      .sort((a, b) => {
        // Sort by confidence first, then by recency
        const confDiff = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]
        if (confDiff !== 0) return confDiff
        return b.mtimeMs - a.mtimeMs
      })
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] [confidence] filename (timestamp): description.
 * Stale memories get a ⚠ warning prefix.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : ""
      const conf = `[${m.confidence}] `
      const staleTag = m.isStale ? "⚠ STALE — " : ""
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${staleTag}${tag}${conf}${m.filename} (${ts}): ${m.description}`
        : `- ${staleTag}${tag}${conf}${m.filename} (${ts})`
    })
    .join("\n")
}
