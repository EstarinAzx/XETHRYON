/**
 * Minimal YAML frontmatter parser.
 * Replaces cc-leak's `utils/frontmatterParser.js`.
 *
 * Input: raw markdown string
 * Output: { data: Record<string, string>, content: string }
 */

// --- Memory reliability types ---

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

/**
 * Default expiry durations per memory type (in days).
 * - project: 30 days (deadlines, initiatives are short-lived)
 * - feedback: 90 days (preferences evolve)
 * - user: 180 days (identity changes slowly)
 * - reference: never expires (external pointers stay valid)
 */
export const DEFAULT_EXPIRY_DAYS: Record<string, number | null> = {
  project: 30,
  feedback: 90,
  user: 180,
  reference: null,
}

/**
 * Parse a confidence level string. Returns undefined for invalid values.
 */
export function parseConfidence(raw: unknown): ConfidenceLevel | undefined {
  if (typeof raw !== 'string') return undefined
  return CONFIDENCE_LEVELS.find(c => c === raw.toLowerCase())
}

export interface FrontmatterResult {
  data: Record<string, string>
  content: string
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Expects `---\n` delimiters. Returns empty data if no frontmatter found.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { data: {}, content: raw }
  }

  const lineBreak = raw.includes('\r\n') ? '\r\n' : '\n'
  const endIdx = raw.indexOf(`${lineBreak}---`, 4)
  if (endIdx === -1) {
    return { data: {}, content: raw }
  }

  const frontmatterBlock = raw.slice(raw.indexOf(lineBreak) + lineBreak.length, endIdx)
  const content = raw.slice(endIdx + lineBreak.length + 3).replace(/^\r?\n/, '')

  const data: Record<string, string> = {}
  for (const line of frontmatterBlock.split(lineBreak)) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) data[key] = value
  }

  return { data, content }
}

/**
 * Calculate the expiry date for a memory based on its type and creation date.
 * Returns null if the memory type never expires.
 */
export function calculateExpiry(memoryType: string | undefined, createdDate: Date): string | null {
  if (!memoryType) return null
  const days = DEFAULT_EXPIRY_DAYS[memoryType]
  if (days === null || days === undefined) return null
  const expiry = new Date(createdDate)
  expiry.setDate(expiry.getDate() + days)
  return expiry.toISOString().slice(0, 10) // YYYY-MM-DD
}
