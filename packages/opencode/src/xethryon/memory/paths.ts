/**
 * Memory directory path resolution for Xethryon.
 * Ported from cc-leak/src/memdir/paths.ts with OpenCode adaptations.
 */

import { homedir } from "os"
import { isAbsolute, join, normalize, sep } from "path"
import { Instance } from "@/project/instance"

const AUTO_MEM_DIRNAME = "memory"
const AUTO_MEM_ENTRYPOINT_NAME = "MEMORY.md"

/**
 * Whether auto-memory features are enabled.
 * Controlled by XETHRYON_DISABLE_AUTO_MEMORY env var.
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.XETHRYON_DISABLE_AUTO_MEMORY
  if (envVal === "1" || envVal === "true") return false
  return true
}

/**
 * Normalize and validate a candidate auto-memory directory path.
 *
 * SECURITY: Rejects paths that would be dangerous as a read-allowlist root:
 * - relative (!isAbsolute)
 * - root/near-root (length < 3)
 * - Windows drive-root (C:)
 * - UNC paths (\\server\share)
 * - null byte
 */
export function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) return undefined

  let candidate = raw
  if (
    expandTilde &&
    (candidate.startsWith("~/") || candidate.startsWith("~\\"))
  ) {
    const rest = candidate.slice(2)
    const restNorm = normalize(rest || ".")
    if (restNorm === "." || restNorm === "..") return undefined
    candidate = join(homedir(), rest)
  }

  const normalized = normalize(candidate).replace(/[/\\]+$/, "")
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.includes("\0")
  ) {
    return undefined
  }

  return (normalized + sep).normalize("NFC")
}

/**
 * Sanitize a filesystem path into a safe directory name.
 * Replaces path separators with underscores, strips leading slashes/drive letters.
 */
function sanitizePath(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/^[A-Za-z]:/, "")           // strip Windows drive letter
    .replace(/^[/\\]+/, "")              // strip leading separators
    .replace(/[/\\]+$/g, "")             // strip trailing separators
    .replace(/[/\\]/g, "_")              // replace separators with underscore
    .replace(/[<>:"|?*]/g, "_")          // replace invalid chars
    || "default"
}

/**
 * Returns the base directory for persistent memory storage.
 * Uses ~/.xethryon as the config home.
 */
function getMemoryBaseDir(): string {
  if (process.env.XETHRYON_MEMORY_PATH) {
    const validated = validateMemoryPath(process.env.XETHRYON_MEMORY_PATH, false)
    if (validated) return validated.replace(/[/\\]+$/, "")
  }
  return join(homedir(), ".xethryon")
}

/**
 * Returns the auto-memory base: the working directory (sandbox).
 * Each distinct project directory gets its own memory folder.
 * 
 * NOTE: Previously used Instance.worktree (git root), but non-git projects
 * set worktree to "/" which sanitizes to "default", causing all non-git
 * projects to share memory. Using directory ensures unique folders.
 */
function getAutoMemBase(): string {
  try {
    return Instance.directory
  } catch {
    // Fallback if Instance isn't initialized yet
    return process.cwd()
  }
}

let _cachedAutoMemPath: string | undefined

/**
 * Returns the auto-memory directory path.
 * Shape: ~/.xethryon/projects/{sanitized-project-root}/memory/
 *
 * Memoized for performance — called frequently during prompt building.
 */
export function getAutoMemPath(): string {
  if (_cachedAutoMemPath) return _cachedAutoMemPath

  const override = validateMemoryPath(process.env.XETHRYON_MEMORY_PATH, false)
  if (override) {
    _cachedAutoMemPath = override
    return override
  }

  const projectsDir = join(getMemoryBaseDir(), "projects")
  _cachedAutoMemPath = (
    join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
  ).normalize("NFC")

  return _cachedAutoMemPath
}

/**
 * Returns the auto-memory entrypoint (MEMORY.md inside the auto-memory dir).
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * Returns the daily log file path for the given date (defaults to today).
 * Shape: {autoMemPath}/daily/YYYY-MM-DD.md
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, "0")
  const dd = date.getDate().toString().padStart(2, "0")
  return join(getAutoMemPath(), "daily", `${yyyy}-${mm}-${dd}.md`)
}

/**
 * Returns the daily/ log directory path.
 */
export function getDailyLogDir(): string {
  return join(getAutoMemPath(), "daily")
}

// ─── Knowledge Base Paths ──────────────────────────────────────────

/**
 * Returns the knowledge/ base directory.
 * Shape: {autoMemPath}/knowledge/
 */
export function getKnowledgeDir(): string {
  return join(getAutoMemPath(), "knowledge")
}

/**
 * Returns the knowledge/concepts/ directory.
 */
export function getConceptsDir(): string {
  return join(getKnowledgeDir(), "concepts")
}

/**
 * Returns the knowledge/connections/ directory.
 */
export function getConnectionsDir(): string {
  return join(getKnowledgeDir(), "connections")
}

/**
 * Returns the knowledge/qa/ directory.
 */
export function getQADir(): string {
  return join(getKnowledgeDir(), "qa")
}

/**
 * Returns the knowledge/index.md path — the master catalog.
 */
export function getKnowledgeIndexPath(): string {
  return join(getKnowledgeDir(), "index.md")
}

/**
 * Returns the knowledge/log.md path — the append-only build log.
 */
export function getKnowledgeBuildLogPath(): string {
  return join(getKnowledgeDir(), "log.md")
}

/**
 * Returns the compiler state file path.
 */
export function getCompilerStatePath(): string {
  return join(getKnowledgeDir(), ".state.json")
}

/**
 * Check if an absolute path is within the auto-memory directory.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}

/**
 * Reset the memoized auto-memory path. For testing only.
 */
export function _resetAutoMemPath(): void {
  _cachedAutoMemPath = undefined
}

