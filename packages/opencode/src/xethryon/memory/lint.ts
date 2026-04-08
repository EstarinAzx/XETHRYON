/**
 * Knowledge Base Lint — structural health checks.
 *
 * 7 checks ported from Karpathy's architecture:
 * 1. Broken [[wikilinks]] pointing to non-existent articles
 * 2. Orphan pages with zero inbound links
 * 3. Orphan daily logs not yet compiled
 * 4. Stale articles (source changed since compilation)
 * 5. Missing backlinks (A→B but not B→A)
 * 6. Sparse articles (under 200 words)
 * 7. Contradictions (deferred to existing contradictions.ts)
 */

import { readFile, readdir } from "fs/promises"
import { join, basename } from "path"
import { Log } from "@/util/log"
import {
  getKnowledgeDir,
  getDailyLogDir,
} from "./paths.js"
import { loadCompilerState, fileHash } from "./compilerState.js"

const log = Log.create({ service: "xethryon.lint" })

export type LintSeverity = "error" | "warning" | "suggestion"

export interface LintIssue {
  check: string
  severity: LintSeverity
  message: string
  file?: string
}

/**
 * List all wiki articles and their content.
 */
async function loadAllArticles(): Promise<Map<string, string>> {
  const articles = new Map<string, string>()
  const knowledgeDir = getKnowledgeDir()

  for (const subdir of ["concepts", "connections", "qa"]) {
    const dir = join(knowledgeDir, subdir)
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue
        const slug = `${subdir}/${entry.replace(".md", "")}`
        const content = await readFile(join(dir, entry), "utf-8")
        articles.set(slug, content)
      }
    } catch {
      // Directory might not exist
    }
  }

  return articles
}

/**
 * Extract all [[wikilinks]] from content.
 */
function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1])
  }
  return links
}

/**
 * Check 1: Broken wikilinks
 */
function checkBrokenLinks(
  articles: Map<string, string>,
): LintIssue[] {
  const issues: LintIssue[] = []
  const slugs = new Set(articles.keys())

  for (const [slug, content] of articles) {
    const links = extractWikilinks(content)
    for (const link of links) {
      // Normalize: strip daily/ prefix for source links
      if (link.startsWith("daily/")) continue
      if (!slugs.has(link)) {
        issues.push({
          check: "broken-link",
          severity: "error",
          message: `[[${link}]] in ${slug} points to non-existent article`,
          file: slug,
        })
      }
    }
  }

  return issues
}

/**
 * Check 2: Orphan pages (zero inbound links)
 */
function checkOrphanPages(
  articles: Map<string, string>,
): LintIssue[] {
  const issues: LintIssue[] = []
  const inboundCounts = new Map<string, number>()

  // Initialize all slugs with 0
  for (const slug of articles.keys()) {
    inboundCounts.set(slug, 0)
  }

  // Count inbound links
  for (const [, content] of articles) {
    const links = extractWikilinks(content)
    for (const link of links) {
      if (inboundCounts.has(link)) {
        inboundCounts.set(link, (inboundCounts.get(link) ?? 0) + 1)
      }
    }
  }

  for (const [slug, count] of inboundCounts) {
    if (count === 0) {
      issues.push({
        check: "orphan-page",
        severity: "warning",
        message: `${slug} has zero inbound links from other articles`,
        file: slug,
      })
    }
  }

  return issues
}

/**
 * Check 3: Orphan daily logs (not yet compiled)
 */
async function checkOrphanSources(): Promise<LintIssue[]> {
  const issues: LintIssue[] = []
  const state = await loadCompilerState()
  const dailyDir = getDailyLogDir()

  try {
    const entries = await readdir(dailyDir)
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      if (!state.ingested[entry]) {
        issues.push({
          check: "orphan-source",
          severity: "warning",
          message: `daily/${entry} has not been compiled yet`,
          file: `daily/${entry}`,
        })
      }
    }
  } catch {
    // Daily dir doesn't exist yet
  }

  return issues
}

/**
 * Check 4: Stale articles (source changed since compilation)
 */
async function checkStaleArticles(): Promise<LintIssue[]> {
  const issues: LintIssue[] = []
  const state = await loadCompilerState()
  const dailyDir = getDailyLogDir()

  for (const [logName, entry] of Object.entries(state.ingested)) {
    const logPath = join(dailyDir, logName)
    try {
      const currentHash = await fileHash(logPath)
      if (currentHash && currentHash !== entry.hash) {
        issues.push({
          check: "stale-article",
          severity: "warning",
          message: `daily/${logName} changed since last compilation (${entry.compiledAt})`,
          file: `daily/${logName}`,
        })
      }
    } catch {
      // Log file might have been deleted
    }
  }

  return issues
}

/**
 * Check 5: Missing backlinks (A→B but B doesn't link back to A)
 */
function checkMissingBacklinks(
  articles: Map<string, string>,
): LintIssue[] {
  const issues: LintIssue[] = []

  for (const [slugA, contentA] of articles) {
    const linksFromA = extractWikilinks(contentA).filter((l) => !l.startsWith("daily/"))

    for (const linkedSlug of linksFromA) {
      const contentB = articles.get(linkedSlug)
      if (!contentB) continue // Broken link, handled by check 1

      const linksFromB = extractWikilinks(contentB)
      if (!linksFromB.includes(slugA)) {
        issues.push({
          check: "missing-backlink",
          severity: "suggestion",
          message: `${slugA} links to ${linkedSlug}, but ${linkedSlug} doesn't link back`,
          file: linkedSlug,
        })
      }
    }
  }

  return issues
}

/**
 * Check 6: Sparse articles (under 200 words)
 */
function checkSparseArticles(
  articles: Map<string, string>,
): LintIssue[] {
  const issues: LintIssue[] = []

  for (const [slug, content] of articles) {
    // Strip frontmatter
    const body = content.replace(/^---[\s\S]*?---\n*/m, "")
    const wordCount = body.trim().split(/\s+/).length

    if (wordCount < 200) {
      issues.push({
        check: "sparse-article",
        severity: "suggestion",
        message: `${slug} has only ${wordCount} words (minimum: 200)`,
        file: slug,
      })
    }
  }

  return issues
}

/**
 * Run all structural lint checks (no LLM needed — free).
 */
export async function runStructuralLint(): Promise<LintIssue[]> {
  const articles = await loadAllArticles()
  const issues: LintIssue[] = []

  issues.push(...checkBrokenLinks(articles))
  issues.push(...checkOrphanPages(articles))
  issues.push(...(await checkOrphanSources()))
  issues.push(...(await checkStaleArticles()))
  issues.push(...checkMissingBacklinks(articles))
  issues.push(...checkSparseArticles(articles))

  log.info("structural lint complete", {
    articles: articles.size,
    issues: issues.length,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    suggestions: issues.filter((i) => i.severity === "suggestion").length,
  })

  return issues
}

/**
 * Format lint issues as a readable report.
 */
export function formatLintReport(issues: LintIssue[]): string {
  if (issues.length === 0) {
    return "✅ Knowledge base is healthy — no issues found."
  }

  const severityIcon: Record<LintSeverity, string> = {
    error: "🔴",
    warning: "🟡",
    suggestion: "💡",
  }

  const lines = [
    `Knowledge Base Lint Report`,
    `══════════════════════════`,
    `${issues.filter((i) => i.severity === "error").length} errors, ${issues.filter((i) => i.severity === "warning").length} warnings, ${issues.filter((i) => i.severity === "suggestion").length} suggestions`,
    "",
  ]

  for (const issue of issues) {
    lines.push(`${severityIcon[issue.severity]} [${issue.check}] ${issue.message}`)
  }

  return lines.join("\n")
}
