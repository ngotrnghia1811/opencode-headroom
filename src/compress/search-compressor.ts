export interface SearchCompressorConfig {
  max_matches_per_file: number
  max_files: number
  max_total_matches: number
  keep_first_match: boolean
  keep_last_match: boolean
}

const DEFAULTS: SearchCompressorConfig = {
  max_matches_per_file: 5,
  max_files: 20,
  max_total_matches: 100,
  keep_first_match: true,
  keep_last_match: true,
}

import { deriveKey } from "../ccr/hash"
import type { CcrStore } from "../ccr/store"

// ─── Module-level regex ────────────────────────────────────────────

// Match file:line:content or file-line-content (ripgrep context uses - separator)
// \2 backreference ensures separator before/after line number matches (:42: or -41-)
const GREP_LINE_RE = /^(.+?)([:-])(\d+)\2(.*)$/

// ─── Public API ────────────────────────────────────────────────────

export function compressSearch(
  content: string,
  config?: Partial<SearchCompressorConfig>,
  store?: CcrStore,
): string {
  const cfg = { ...DEFAULTS, ...config }
  const lines = content.split("\n")

  const matches = parseSearchLines(lines)

  // If nothing parsed, return original
  if (Object.keys(matches).length === 0) return content

  const totalMatches = Object.values(matches).reduce((sum, m) => sum + m.length, 0)
  if (totalMatches === 0) return content

  const selected = selectMatches(matches, cfg)
  const ccrHash = store ? deriveKey(content) : undefined
  const result = formatOutput(selected, matches, ccrHash)

  // Token monotone: if compressed is longer than original, return original
  if (result.length >= content.length) return content

  if (store && ccrHash) store.put(ccrHash, content)
  return result
}

// ─── Parsing ───────────────────────────────────────────────────────

interface Match {
  file: string
  line: number
  content: string
  raw: string
  context_type: "match" | "context"
}

function parseSearchLines(lines: string[]): Record<string, Match[]> {
  const matches: Record<string, Match[]> = {}

  for (const line of lines) {
    if (!line.trim()) continue

    // Handle Windows drive-letter paths (e.g., C:\Users\foo.ts:42:content)
    // The drive letter colon comes before the line number colon.
    // Detect: if we have "X:\" at position 0-1, this is a Windows path
    let adjusted = line
    let skipPrefix = 0
    if (/^[A-Za-z]:\\/.test(line)) {
      skipPrefix = 2 // skip "C:"
      adjusted = line.slice(2)
    }

    const match = GREP_LINE_RE.exec(adjusted)
    if (!match) continue

    const file = (skipPrefix > 0 ? line.slice(0, 2) : "") + match[1]
    const separator = match[2]
    const lineNum = parseInt(match[3], 10)
    const content = match[4]
    const context_type: "match" | "context" = separator === "-" ? "context" : "match"

    if (isNaN(lineNum)) continue

    if (!matches[file]) matches[file] = []
    matches[file].push({ file, line: lineNum, content, raw: line, context_type })
  }

  return matches
}

// ─── Relevance Scoring ─────────────────────────────────────────────

function scoreMatch(line: string, context?: string): number {
  let score = 0.5 // baseline
  // Error/warning pattern boosts
  if (/\b(error|err|fail|exception|panic|fatal)\b/i.test(line)) score += 0.5
  if (/\b(warn|warning)\b/i.test(line)) score += 0.4
  // Context word overlap (if context provided)
  if (context) {
    const ctxTokens = context.toLowerCase().split(/\W+/).filter((t) => t.length > 3)
    const lineTokens = line.toLowerCase().split(/\W+/)
    const overlap = ctxTokens.filter((t) => lineTokens.includes(t)).length
    score += Math.min(0.3, overlap * 0.1)
  }
  return Math.min(1.0, score)
}

// ─── Selection ─────────────────────────────────────────────────────

function selectMatches(
  matches: Record<string, Match[]>,
  cfg: SearchCompressorConfig,
): Record<string, Match[]> {
  // Sort files by total match count (most matches first)
  const sortedFiles = Object.entries(matches)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, cfg.max_files)

  const selected: Record<string, Match[]> = {}
  let totalSelected = 0

  for (const [file, fileMatches] of sortedFiles) {
    if (totalSelected >= cfg.max_total_matches) break

    const sorted = [...fileMatches].sort((a, b) => a.line - b.line)
    const fileSelected: Match[] = []
    let remaining = Math.min(cfg.max_matches_per_file, cfg.max_total_matches - totalSelected)

    if (cfg.keep_first_match && sorted.length > 0) {
      fileSelected.push(sorted[0])
      remaining--
    }

    if (cfg.keep_last_match && sorted.length > 1) {
      const last = sorted[sorted.length - 1]
      if (last !== sorted[0] && remaining > 0) {
        fileSelected.push(last)
        remaining--
      }
    }

    // Fill remaining slots from middle (prefer match lines, then relevance-scored)
    if (remaining > 0 && sorted.length > 2) {
      const middle = sorted.slice(1, sorted.length - 1)
      middle.sort((a, b) => {
        if (a.context_type !== b.context_type) {
          return a.context_type === "match" ? -1 : 1
        }
        // Higher relevance first
        const scoreA = scoreMatch(a.content + a.raw)
        const scoreB = scoreMatch(b.content + b.raw)
        return scoreB - scoreA
      })
      for (let i = 0; i < middle.length && remaining > 0; i++) {
        if (!fileSelected.includes(middle[i])) {
          fileSelected.push(middle[i])
          remaining--
        }
      }
    }

    // Sort by line number for consistent output
    fileSelected.sort((a, b) => a.line - b.line)
    selected[file] = fileSelected
    totalSelected += fileSelected.length
  }

  return selected
}

// ─── Output formatting ─────────────────────────────────────────────

function formatOutput(
  selected: Record<string, Match[]>,
  original: Record<string, Match[]>,
  ccrHash?: string,
): string {
  const resultLines: string[] = []
  const retrieveHint = ccrHash ? ` — retrieve with <<ccr:${ccrHash}>>` : ""

  for (const file of Object.keys(selected).sort()) {
    const selMatches = selected[file]
    for (const m of selMatches) {
      resultLines.push(m.raw || `${m.file}:${m.line}:${m.content}`)
    }

    const originalMatches = original[file]
    if (originalMatches && originalMatches.length > selMatches.length) {
      const omitted = originalMatches.length - selMatches.length
      resultLines.push(`[... ${omitted} more matches in ${file}${retrieveHint}]`)
    }
  }

  // Report any files that were entirely omitted
  const selectedFiles = new Set(Object.keys(selected))
  const omittedFiles = Object.keys(original).filter((f) => !selectedFiles.has(f))
  if (omittedFiles.length > 0) {
    resultLines.push(`[... ${omittedFiles.length} more files with matches omitted${retrieveHint}]`)
  }

  return resultLines.join("\n")
}
