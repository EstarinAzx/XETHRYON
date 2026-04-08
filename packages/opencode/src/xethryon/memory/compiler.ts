/**
 * Knowledge Compiler for Xethryon.
 *
 * Inspired by Karpathy's LLM Knowledge Base architecture.
 * Compiles daily conversation logs into structured, cross-referenced
 * wiki-style knowledge articles with [[wikilinks]].
 *
 * Pipeline:
 *   daily/YYYY-MM-DD.md → LLM compiler → knowledge/concepts/, connections/
 *     → updates knowledge/index.md + knowledge/log.md
 */

import { readFile, writeFile, readdir, mkdir } from "fs/promises"
import { join, basename } from "path"
import { Log } from "@/util/log"
import {
  getDailyLogDir,
  getKnowledgeDir,
  getConceptsDir,
  getConnectionsDir,
  getKnowledgeIndexPath,
  getKnowledgeBuildLogPath,
  getAutoMemPath,
  getAutoMemEntrypoint,
} from "./paths.js"
import {
  loadCompilerState,
  needsCompilation,
  recordCompilation,
  type CompilerState,
} from "./compilerState.js"

const log = Log.create({ service: "xethryon.compiler" })

/**
 * Ensure all knowledge directories exist.
 */
export async function ensureKnowledgeDirs(): Promise<void> {
  await mkdir(getDailyLogDir(), { recursive: true })
  await mkdir(getConceptsDir(), { recursive: true })
  await mkdir(getConnectionsDir(), { recursive: true })
  await mkdir(join(getKnowledgeDir(), "qa"), { recursive: true })
}

/**
 * List all daily log files.
 */
async function listDailyLogs(): Promise<string[]> {
  const dailyDir = getDailyLogDir()
  try {
    const entries = await readdir(dailyDir)
    return entries
      .filter((e) => e.endsWith(".md"))
      .sort()
      .map((e) => join(dailyDir, e))
  } catch {
    return []
  }
}

/**
 * List all existing wiki articles in knowledge/.
 */
async function listWikiArticles(): Promise<Map<string, string>> {
  const articles = new Map<string, string>()
  const knowledgeDir = getKnowledgeDir()

  for (const subdir of ["concepts", "connections", "qa"]) {
    const dir = join(knowledgeDir, subdir)
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue
        const fullPath = join(dir, entry)
        const content = await readFile(fullPath, "utf-8")
        articles.set(`${subdir}/${entry.replace(".md", "")}`, content)
      }
    } catch {
      // Directory doesn't exist yet
    }
  }

  return articles
}

/**
 * Read the current knowledge index.
 */
async function readKnowledgeIndex(): Promise<string> {
  try {
    return await readFile(getKnowledgeIndexPath(), "utf-8")
  } catch {
    return "# Knowledge Base Index\n\n| Article | Summary | Compiled From | Updated |\n|---------|---------|---------------|---------|\n"
  }
}

/**
 * Build the compilation prompt for the LLM.
 */
function buildCompilePrompt(
  dailyLogContent: string,
  dailyLogName: string,
  currentIndex: string,
  existingArticles: Map<string, string>,
  conceptsDir: string,
  connectionsDir: string,
  knowledgeDir: string,
): string {
  let existingContext = ""
  if (existingArticles.size > 0) {
    const parts: string[] = []
    for (const [relPath, content] of existingArticles) {
      parts.push(`### ${relPath}\n\`\`\`markdown\n${content}\n\`\`\``)
    }
    existingContext = parts.join("\n\n")
  }

  const timestamp = new Date().toISOString()

  return `You are a knowledge compiler. Read the daily conversation log and extract knowledge into structured wiki articles.

## Output Format

Respond with ONLY structured file operations using this exact format:

=== WRITE: concepts/slug-name.md ===
---
title: "Concept Name"
tags: [domain, topic]
sources:
  - "daily/${dailyLogName}"
created: ${timestamp.split("T")[0]}
updated: ${timestamp.split("T")[0]}
---

# Concept Name

[2-4 sentence core explanation]

## Key Points

- [Bullet points, each self-contained]

## Details

[Deeper explanation, encyclopedia-style paragraphs]

## Related Concepts

- [[concepts/related-concept]] - How it connects
=== END ===

=== WRITE: connections/x-and-y.md ===
[connection article content with frontmatter]
=== END ===

=== INDEX ===
[Full updated index.md content with table]
=== END ===

=== LOG ===
## [${timestamp}] compile | ${dailyLogName}
- Source: daily/${dailyLogName}
- Articles created: [[concepts/x]]
- Articles updated: (none)
=== END ===

## Rules

1. Extract 2-7 distinct concepts worth their own article
2. Use YAML frontmatter with title, tags, sources, created, updated
3. Use [[concepts/slug]] wikilinks to link related concepts
4. Write in encyclopedia style — neutral, comprehensive, factual
5. If this log adds to an existing concept, update that article (include full content)
6. Create connection articles only for genuinely non-obvious relationships
7. Keep article filenames lowercase with hyphens (e.g., git-worktree-isolation.md)
8. Every article must link to at least 1 other article via [[wikilinks]]
9. If nothing worth saving, respond with exactly: NO_ARTICLES

## Current Wiki Index

${currentIndex}

## Existing Wiki Articles

${existingContext || "(No existing articles yet)"}

## Daily Log to Compile

**File:** ${dailyLogName}

${dailyLogContent}`
}

/**
 * Parse the LLM's compilation response into file operations.
 */
function parseCompileResponse(response: string): {
  files: Array<{ path: string; content: string }>
  index?: string
  buildLog?: string
} {
  const files: Array<{ path: string; content: string }> = []
  let index: string | undefined
  let buildLog: string | undefined

  // Parse WRITE blocks
  const writeRegex = /=== WRITE:\s*(.+?)\s*===\n([\s\S]*?)(?:=== END ===|(?==== ))/g
  let match: RegExpExecArray | null
  while ((match = writeRegex.exec(response)) !== null) {
    files.push({
      path: match[1].trim(),
      content: match[2].trim(),
    })
  }

  // Parse INDEX block
  const indexMatch = response.match(/=== INDEX ===\n([\s\S]*?)(?:=== END ===|$)/)
  if (indexMatch) {
    index = indexMatch[1].trim()
  }

  // Parse LOG block
  const logMatch = response.match(/=== LOG ===\n([\s\S]*?)(?:=== END ===|$)/)
  if (logMatch) {
    buildLog = logMatch[1].trim()
  }

  return { files, index, buildLog }
}

/**
 * Compile a single daily log into knowledge articles.
 */
async function compileDailyLog(
  logPath: string,
  state: CompilerState,
  llmCall: (prompt: string) => Promise<string>,
): Promise<{ articlesCreated: string[]; articlesUpdated: string[] }> {
  const logName = basename(logPath)
  const logContent = await readFile(logPath, "utf-8")

  if (logContent.trim().length < 50) {
    log.info("daily log too short, skipping", { logName })
    return { articlesCreated: [], articlesUpdated: [] }
  }

  // Build compilation context
  const currentIndex = await readKnowledgeIndex()
  const existingArticles = await listWikiArticles()

  const prompt = buildCompilePrompt(
    logContent,
    logName,
    currentIndex,
    existingArticles,
    getConceptsDir(),
    getConnectionsDir(),
    getKnowledgeDir(),
  )

  log.info("compiling daily log", { logName, promptLength: prompt.length })

  const response = await llmCall(prompt)

  if (response.includes("NO_ARTICLES")) {
    log.info("compiler found nothing worth saving", { logName })
    await recordCompilation(state, logName, logPath, [], [])
    return { articlesCreated: [], articlesUpdated: [] }
  }

  // Parse and write
  const { files, index, buildLog } = parseCompileResponse(response)
  const knowledgeDir = getKnowledgeDir()
  const articlesCreated: string[] = []
  const articlesUpdated: string[] = []

  for (const file of files) {
    const fullPath = join(knowledgeDir, file.path.endsWith(".md") ? file.path : `${file.path}.md`)
    const existed = existingArticles.has(file.path.replace(".md", ""))

    await mkdir(join(fullPath, ".."), { recursive: true })
    await writeFile(fullPath, file.content, "utf-8")

    if (existed) {
      articlesUpdated.push(file.path)
    } else {
      articlesCreated.push(file.path)
    }
    log.info("article written", { path: file.path })
  }

  // Update index.md
  if (index) {
    await writeFile(getKnowledgeIndexPath(), index, "utf-8")
    log.info("knowledge index updated")
  }

  // Append to build log
  if (buildLog) {
    const buildLogPath = getKnowledgeBuildLogPath()
    let existing = ""
    try {
      existing = await readFile(buildLogPath, "utf-8")
    } catch {
      existing = "# Build Log\n\n"
    }
    await writeFile(buildLogPath, existing + "\n" + buildLog + "\n", "utf-8")
  }

  // Sync MEMORY.md as alias of index.md
  if (index) {
    try {
      await writeFile(getAutoMemEntrypoint(), index, "utf-8")
    } catch {
      // Non-critical
    }
  }

  // Record in state
  await recordCompilation(state, logName, logPath, articlesCreated, articlesUpdated)

  return { articlesCreated, articlesUpdated }
}

/**
 * Run the full compilation pipeline.
 * Finds uncompiled daily logs and compiles them into knowledge articles.
 */
export async function runCompilation(
  llmCall: (prompt: string) => Promise<string>,
  options?: { force?: boolean },
): Promise<{
  compiled: number
  articlesCreated: string[]
  articlesUpdated: string[]
}> {
  await ensureKnowledgeDirs()

  const state = await loadCompilerState()
  const allLogs = await listDailyLogs()

  let toCompile: string[] = []

  if (options?.force) {
    toCompile = allLogs
  } else {
    for (const logPath of allLogs) {
      const logName = basename(logPath)
      if (await needsCompilation(logPath, logName, state)) {
        toCompile.push(logPath)
      }
    }
  }

  if (toCompile.length === 0) {
    log.info("nothing to compile — all daily logs up to date")
    return { compiled: 0, articlesCreated: [], articlesUpdated: [] }
  }

  log.info("compiling daily logs", { count: toCompile.length })

  const allCreated: string[] = []
  const allUpdated: string[] = []

  for (const logPath of toCompile) {
    try {
      const result = await compileDailyLog(logPath, state, llmCall)
      allCreated.push(...result.articlesCreated)
      allUpdated.push(...result.articlesUpdated)
    } catch (e) {
      log.error("compilation failed for log", { logPath, error: e })
    }
  }

  log.info("compilation complete", {
    compiled: toCompile.length,
    created: allCreated.length,
    updated: allUpdated.length,
  })

  return {
    compiled: toCompile.length,
    articlesCreated: allCreated,
    articlesUpdated: allUpdated,
  }
}

/**
 * Append a session entry to today's daily log.
 * Used by both regular sessions and swarm agents.
 */
export async function appendToDailyLog(
  content: string,
  section: string = "Session",
): Promise<void> {
  const logPath = (await import("./paths.js")).getAutoMemDailyLogPath()
  await mkdir(join(logPath, ".."), { recursive: true })

  const now = new Date()
  const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`

  let existing = ""
  try {
    existing = await readFile(logPath, "utf-8")
  } catch {
    const dateStr = now.toISOString().split("T")[0]
    existing = `# Daily Log: ${dateStr}\n\n## Sessions\n\n`
  }

  const entry = `### ${section} (${timeStr})\n\n${content}\n\n`
  await writeFile(logPath, existing + entry, "utf-8")

  log.info("daily log entry appended", { section, logPath })
}
