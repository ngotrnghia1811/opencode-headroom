import { deriveKey } from "../ccr/hash"
import type { CcrStore } from "../ccr/store"
import { computeOptimalK } from "./kneedle"

export interface LogCompressorConfig {
  max_errors: number
  error_context_lines: number
  keep_first_error: boolean
  keep_last_error: boolean
  max_stack_traces: number
  stack_trace_max_lines: number
  max_warnings: number
  dedupe_warnings: boolean
  keep_summary_lines: boolean
  max_total_lines: number
}

const DEFAULTS: LogCompressorConfig = {
  max_errors: 10,
  error_context_lines: 3,
  keep_first_error: true,
  keep_last_error: true,
  max_stack_traces: 3,
  stack_trace_max_lines: 20,
  max_warnings: 5,
  dedupe_warnings: true,
  keep_summary_lines: true,
  max_total_lines: 100,
}

interface LogLine {
  index: number
  content: string
  level: "error" | "fail" | "warn" | "info" | "debug" | "trace" | "unknown"
  isStackTrace: boolean
  isSummary: boolean
  score: number
}

// ─── Module-level regex ────────────────────────────────────────────

const LEVEL_PATTERNS: [string, RegExp][] = [
  ["error", /\b(?:ERROR|error|Error|FATAL|fatal|Fatal|CRITICAL|critical|FAIL|FAILED|fail|failed|Fail|Failed)\b/],
  ["warn", /\b(?:WARN|WARNING|warn|warning|Warn|Warning)\b/],
  ["info", /\b(?:INFO|info|Info)\b/],
  ["debug", /\b(?:DEBUG|debug|Debug)\b/],
  ["trace", /\b(?:TRACE|trace|Trace)\b/],
]

const STACK_TRACE_PATTERNS: RegExp[] = [
  /^\s*Traceback \(most recent call last\)/,
  /^\s*File ".+", line \d+/,
  /^\s*at .+\(.+:\d+:\d+\)/,
  /^\s+at [\w.$]+\(/,
  /^\s*--> .+:\d+:\d+/,
  /^\s*\d+:\s+0x[0-9a-f]+/,
]

const SUMMARY_PATTERNS: RegExp[] = [
  /^={3,}/,
  /^-{3,}/,
  /^\d+ (passed|failed|skipped|error|warning)/i,
  /^(?:Tests?|Suites?):?\s+\d+/,
  /^(?:TOTAL|Total|Summary)/,
  /^(?:Build|Compile|Test).*(?:succeeded|failed|complete)/i,
]

function scoreLine(ll: LogLine): number {
  const levelScores: Record<string, number> = {
    error: 1.0,
    fail: 1.0,
    warn: 0.5,
    info: 0.1,
    debug: 0.05,
    trace: 0.02,
    unknown: 0.1,
  }
  let score = levelScores[ll.level] ?? 0.1
  if (ll.isStackTrace) score += 0.3
  if (ll.isSummary) score += 0.4
  return Math.min(1.0, score)
}

// ─── Public API ────────────────────────────────────────────────────

export function compressLog(
  content: string,
  config?: Partial<LogCompressorConfig>,
  store?: CcrStore,
): string {
  const cfg = { ...DEFAULTS, ...config }
  const lines = content.split("\n")

  // Only skip if trivially small (fewer than 10 lines)
  if (lines.length < 10) return content

  const parsed = parseLogLines(lines)
  const selected = selectLines(parsed, cfg)

  const ccrHash = store ? deriveKey(content) : undefined
  const result = formatOutput(selected, parsed.length, parsed, ccrHash)
  if (!result) return content

  // Token monotone: if compressed is longer than original, return original
  if (result.length >= content.length) return content

  if (store && ccrHash) store.put(ccrHash, content)
  return result
}

// ─── Parsing ───────────────────────────────────────────────────────

function parseLogLines(lines: string[]): LogLine[] {
  const logLines: LogLine[] = []
  let inStackTrace = false
  let stackTraceLines = 0
  let currentStack: LogLine[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const ll: LogLine = {
      index: i,
      content: line,
      level: "unknown",
      isStackTrace: false,
      isSummary: false,
      score: 0,
    }

    // Level classification
    for (const [level, pattern] of LEVEL_PATTERNS) {
      if (pattern.test(line)) {
        ll.level = level as LogLine["level"]
        break
      }
    }

    // Stack trace detection
    for (const pattern of STACK_TRACE_PATTERNS) {
      if (pattern.test(line)) {
        inStackTrace = true
        stackTraceLines = 0
        break
      }
    }

    if (inStackTrace) {
      ll.isStackTrace = true
      stackTraceLines++
      if (stackTraceLines > 20) {
        inStackTrace = false
      } else if (!line.trim()) {
        // Blank line — peek ahead to see if next non-blank line continues the trace
        const nextNonBlank = lines.slice(i + 1).find((l) => l.trim() !== "")
        const continuesTrace =
          nextNonBlank &&
          (/^\s+at\s/.test(nextNonBlank) || // JS: at Module.func (file:line)
            /^\s+File\s+"/.test(nextNonBlank) || // Python: File "path", line N
            /^\s+\d+\s+/.test(nextNonBlank) || // line number context
            /^Caused by:/i.test(nextNonBlank) ||
            /^During handling of the above/i.test(nextNonBlank) ||
            /^The above exception was/i.test(nextNonBlank))
        if (!continuesTrace) inStackTrace = false
      }
    }

    // Summary detection
    for (const pattern of SUMMARY_PATTERNS) {
      if (pattern.test(line)) {
        ll.isSummary = true
        break
      }
    }

    ll.score = scoreLine(ll)
    logLines.push(ll)
  }

  return logLines
}

// ─── Selection ─────────────────────────────────────────────────────

function selectLines(allLines: LogLine[], cfg: LogCompressorConfig): LogLine[] {
  const errors = allLines.filter((l) => l.level === "error")
  const warns = allLines.filter((l) => l.level === "warn")
  const summaries = allLines.filter((l) => l.isSummary)

  // Collect stack traces (contiguous blocks)
  const stackTraces: LogLine[][] = []
  for (const ll of allLines) {
    if (ll.isStackTrace) {
      if (stackTraces.length === 0 || allLines[ll.index - 1]?.isStackTrace !== true) {
        stackTraces.push([])
      }
      stackTraces[stackTraces.length - 1].push(ll)
    }
  }

  const selected: LogLine[] = []

  // Errors: keep first + last, fill to max_errors
  selectWithFirstLast(errors, cfg.max_errors, cfg.keep_first_error, cfg.keep_last_error, selected)

  // Warnings: dedupe then take top max_warnings
  let topWarns = warns
  if (cfg.dedupe_warnings && warns.length > 0) {
    topWarns = dedupeSimilar(warns)
  }
  for (const w of topWarns.slice(0, cfg.max_warnings)) {
    if (!selected.includes(w)) selected.push(w)
  }

  // Stack traces: top max_stack_traces, truncate each to stack_trace_max_lines
  let keptStacks = 0
  for (const stack of stackTraces) {
    if (keptStacks >= cfg.max_stack_traces) break
    for (const ll of stack.slice(0, cfg.stack_trace_max_lines)) {
      if (!selected.includes(ll)) selected.push(ll)
    }
    keptStacks++
  }

  // Summaries
  if (cfg.keep_summary_lines) {
    for (const s of summaries) {
      if (!selected.includes(s)) selected.push(s)
    }
  }

  // Add context lines around error/fail lines only (not around deduped warnings)
  const errorSelection = selected.filter((l) => l.level === "error" || l.level === "fail")
  addContext(allLines, errorSelection, selected, cfg.error_context_lines)

  // Sort by original index
  selected.sort((a, b) => a.index - b.index)

  // Cap at max_total_lines via Kneedle adaptive K
  const allLineStrings = allLines.map((l) => l.content)
  const adaptiveMax = computeOptimalK(allLineStrings, 1.0, 10, cfg.max_total_lines)
  if (selected.length > adaptiveMax) {
    selected.sort((a, b) => b.score - a.score)
    const truncated = selected.slice(0, adaptiveMax)
    truncated.sort((a, b) => a.index - b.index)
    return truncated
  }

  return selected
}

function selectWithFirstLast(
  lines: LogLine[],
  maxCount: number,
  keepFirst: boolean,
  keepLast: boolean,
  out: LogLine[],
): void {
  if (lines.length === 0) return

  if (lines.length <= maxCount) {
    for (const l of lines) {
      if (!out.includes(l)) out.push(l)
    }
    return
  }

  if (keepFirst && !out.includes(lines[0])) out.push(lines[0])
  if (keepLast && !out.includes(lines[lines.length - 1])) out.push(lines[lines.length - 1])

  const remaining = maxCount - out.filter((o) => lines.includes(o)).length
  if (remaining <= 0) return

  const candidates = lines
    .filter((l) => !out.includes(l))
    .sort((a, b) => b.score - a.score)

  for (let i = 0; i < Math.min(remaining, candidates.length); i++) {
    out.push(candidates[i])
  }
}

function dedupeSimilar(lines: LogLine[]): LogLine[] {
  const seen = new Set<string>()
  const result: LogLine[] = []

  for (const ll of lines) {
    const content = ll.content
    let splitAt = content.length
    for (let i = 0; i < content.length; i++) {
      if (content[i] === ":" || content[i] === "=") {
        splitAt = i
        break
      }
    }
    const prefix = content.slice(0, splitAt)
    let suffix = content.slice(splitAt)

    suffix = suffix.replace(/\d+/g, "N")
    suffix = suffix.replace(/0x[0-9a-fA-F]+/g, "ADDR")
    suffix = suffix.replace(/\/[\w/]+\//g, "/PATH/")

    const normalized = prefix + suffix
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(ll)
    }
  }
  return result
}

function addContext(allLines: LogLine[], refLines: LogLine[], out: LogLine[], ctxLines: number): void {
  const refIndices = new Set(refLines.map((l) => l.index))
  const contextIndices = new Set<number>()

  for (const idx of refIndices) {
    for (let i = Math.max(0, idx - ctxLines); i < idx; i++) {
      contextIndices.add(i)
    }
    for (let i = idx + 1; i < Math.min(allLines.length, idx + ctxLines + 1); i++) {
      contextIndices.add(i)
    }
  }

  const outIndices = new Set(out.map((l) => l.index))
  for (const idx of contextIndices) {
    if (!refIndices.has(idx) && !outIndices.has(idx) && idx < allLines.length) {
      out.push(allLines[idx])
    }
  }
}

// ─── Output formatting ─────────────────────────────────────────────

function formatOutput(
  selected: LogLine[],
  totalLines: number,
  allLines: LogLine[],
  ccrHash?: string,
): string | null {
  const selectedIndices = new Set(selected.map((l) => l.index))
  const retrieveHint = ccrHash ? ` — retrieve with <<ccr:${ccrHash}>>` : ""

  // Build output with omission markers
  const resultLines: string[] = []
  let lastIdx = -1
  let omitted = 0

  for (let i = 0; i < allLines.length; i++) {
    if (selectedIndices.has(i)) {
      if (omitted > 0) {
        resultLines.push(`[... ${omitted} lines omitted${retrieveHint}]`)
        omitted = 0
      }
      resultLines.push(allLines[i].content)
      lastIdx = i
    } else {
      omitted++
    }
  }

  if (omitted > 0) {
    resultLines.push(`[... ${omitted} lines omitted${retrieveHint}]`)
  }

  // Summary footer
  const errorCount = allLines.filter((l) => l.level === "error").length
  const warnCount = allLines.filter((l) => l.level === "warn").length
  const infoCount = allLines.filter((l) => l.level === "info").length

  const parts: string[] = []
  if (errorCount > 0) parts.push(`${errorCount} ERROR`)
  if (warnCount > 0) parts.push(`${warnCount} WARN`)
  if (infoCount > 0) parts.push(`${infoCount} INFO`)
  const omittedTotal = totalLines - selected.length
  if (omittedTotal > 0 && parts.length > 0) {
    resultLines.push(`[${omittedTotal} lines omitted: ${parts.join(", ")}${retrieveHint}]`)
  }

  return resultLines.join("\n")
}
