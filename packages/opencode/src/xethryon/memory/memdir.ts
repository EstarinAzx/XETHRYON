/**
 * Memory prompt builder for Xethryon.
 * Ported from cc-leak/src/memdir/memdir.ts.
 *
 * Stripped: KAIROS, TEAMMEM, GrowthBook flags, analytics/telemetry.
 * Adapted: fs operations use Node fs/promises directly.
 */

import { readFileSync } from "fs"
import { mkdir } from "fs/promises"
import { join } from "path"
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from "./memoryTypes.js"
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths.js"

export const ENTRYPOINT_NAME = "MEMORY.md"
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Truncate MEMORY.md content to the line AND byte caps.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split("\n")
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

export const DIR_EXISTS_GUIDANCE =
  "This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence)."

/**
 * Ensure a memory directory exists. Idempotent.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true })
  } catch {
    // EEXIST is expected; EACCES/EPERM are real problems but we
    // continue either way — the model's Write will surface errors.
  }
}

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = [
        "## How to save memories",
        "",
        "**IMPORTANT: Always write memories to the knowledge base, NOT to flat files or MEMORY.md.**",
        "",
        "Write memories as knowledge articles in these directories:",
        "- `knowledge/concepts/` — standalone concepts, patterns, decisions, user preferences",
        "- `knowledge/connections/` — cross-cutting insights linking multiple concepts",
        "- `knowledge/qa/` — specific Q&A pairs for quick lookup",
        "",
        "### Article format",
        "",
        "Each article uses YAML frontmatter + markdown with `[[wikilinks]]`:",
        "",
        "```markdown",
        "---",
        "title: Express Error Handling Pattern",
        "created: 2026-04-08",
        "updated: 2026-04-08",
        "tags: [express, error-handling, middleware]",
        "---",
        "",
        "# Express Error Handling Pattern",
        "",
        "Custom error classes extending `AppError` with centralized error middleware.",
        "Related: [[express-middleware-vs-route-handlers]], [[typescript-strict-mode]]",
        "```",
        "",
        "### Saving process",
        "",
        "1. Write the article to the appropriate directory (e.g., `knowledge/concepts/api-naming-convention.md`)",
        "2. Add a one-line entry to `knowledge/index.md` linking to the article",
        "3. Add `[[wikilinks]]` in the article body to cross-reference related concepts",
        "4. Append a brief note to today's daily log (`daily/YYYY-MM-DD.md`)",
        "",
        "### Rules",
        "",
        "- Use kebab-case filenames (e.g., `error-handling-patterns.md`)",
        "- Check for existing articles before creating duplicates — update existing ones instead",
        "- Use `[[concept-name]]` wikilinks to connect concepts (this creates graph edges in Obsidian)",
        "- Do NOT write to MEMORY.md or create flat memory files — those are legacy",
        "- Organize semantically by topic, not chronologically",
        "- Update or remove articles that are wrong or outdated",
      ]

  const lines: string[] = [
    `# ${displayName}`,
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
    "",
    ...WHEN_TO_ACCESS_SECTION,
    "",
    ...TRUSTING_RECALL_SECTION,
    "",
    "## Memory and other forms of persistence",
    "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
    "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
    "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
    "",
    ...(extraGuidelines ?? []),
    "",
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * Build the "Searching past context" section.
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  const memSearch = `grep with pattern="<search term>" path="${autoMemDir}" glob="*.md"`
  return [
    "## Searching past context",
    "",
    "When looking for past context:",
    "1. Search topic files in your memory directory:",
    "```",
    memSearch,
    "```",
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    "",
  ]
}

/**
 * Build the typed-memory prompt with knowledge index content included.
 * Reads knowledge/index.md first (compiled wiki), falls back to MEMORY.md.
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const entrypoint = join(memoryDir, ENTRYPOINT_NAME)
  const knowledgeIndex = join(memoryDir, "knowledge", "index.md")

  // Try knowledge/index.md first (compiled wiki), fallback to MEMORY.md
  let indexContent = ""
  let sourceLabel = ENTRYPOINT_NAME

  try {
    indexContent = readFileSync(knowledgeIndex, { encoding: "utf-8" })
    sourceLabel = "Knowledge Index"
  } catch {
    try {
      indexContent = readFileSync(entrypoint, { encoding: "utf-8" })
    } catch {
      // No memory file yet
    }
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  // Add knowledge base section
  if (indexContent.trim()) {
    const t = truncateEntrypointContent(indexContent)
    lines.push(
      `## ${sourceLabel}`,
      "",
      "This is your compiled knowledge base index. Each entry links to a detailed concept article.",
      "When you need details on a concept, read the linked article file from the knowledge/ directory.",
      "",
      t.content,
    )
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      "",
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  // Add knowledge base locations
  lines.push(
    "",
    "## Knowledge Base Structure",
    "",
    `- **Daily logs**: \`${join(memoryDir, "daily")}/\` — raw conversation extracts`,
    `- **Concepts**: \`${join(memoryDir, "knowledge", "concepts")}/\` — compiled knowledge articles`,
    `- **Connections**: \`${join(memoryDir, "knowledge", "connections")}/\` — cross-cutting insights`,
    `- **Q&A**: \`${join(memoryDir, "knowledge", "qa")}/\` — filed query answers`,
    "",
    "Articles use `[[wikilinks]]` for cross-references. The knowledge base is Obsidian-compatible.",
  )

  return lines.join("\n")
}

/**
 * Load the memory prompt for inclusion in the system prompt.
 * Returns null when auto memory is disabled.
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  if (!isAutoMemoryEnabled()) return null

  const autoDir = getAutoMemPath()
  await ensureMemoryDirExists(autoDir)

  // Ensure knowledge directories exist
  try {
    const { ensureKnowledgeDirs } = await import("./compiler.js")
    await ensureKnowledgeDirs()
  } catch {
    // Non-critical — dirs will be created on first compile
  }

  return buildMemoryPrompt({
    displayName: "Xethryon Memory",
    memoryDir: autoDir,
  })
}

