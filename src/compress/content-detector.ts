import { ContentType, type DetectionResult } from "./types"
export { ContentType }

// ─── Compiled regex patterns (module-level) ────────────────────────

const SEARCH_RESULT_RE = /^[^\s:]+:\d+:/
const DIFF_HEADER_RE = /^(diff --git|diff --combined |diff --cc |--- a\/|\+\+\+ b\/|index\s+[0-9a-f]+\.\.[0-9a-f]+|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/
const DIFF_CHANGE_RE = /^[+-][^+-]/

const HTML_DOCTYPE_RE = /^\s*<!doctype\s+html/i
const HTML_TAG_RE = /<html[\s>]/i
const HTML_HEAD_RE = /<head[\s>]/i
const HTML_BODY_RE = /<body[\s>]/i
const HTML_STRUCTURAL_RE = /<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/ig

const LOG_PATTERNS: [RegExp, number][] = [
  [/\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i, 0],
  [/\b(WARN|WARNING)\b/i, 1],
  [/\b(INFO|DEBUG|TRACE)\b/i, 2],
  [/^\s*\d{4}-\d{2}-\d{2}/, 3],
  [/^\s*\[\d{2}:\d{2}:\d{2}\]/, 3],
  [/^={3,}|^-{3,}/, 3],
  [/^\s*PASSED|^\s*FAILED|^\s*SKIPPED/, 3],
  [/^npm ERR!|^yarn error|^cargo error/, 3],
  [/Traceback \(most recent call last\)/, 3],
  [/^\w*(Error|Exception):/, 3],
  [/^\s*at\s+[\w.$]+\(/, 3],
]

const CODE_PATTERNS: Record<string, RegExp[]> = {
  python: [/^\s*(def|class|import|from|async def)\s+\w+/, /^\s*@\w+/, /^\s*"""/, /^\s*if __name__\s*==/],
  javascript: [/^\s*(function|const|let|var|class|import|export)\s+/, /^\s*(async\s+function|=>\s*\{)/, /^\s*module\.exports/],
  typescript: [/^\s*(interface|type|enum|namespace)\s+\w+/, /:\s*(string|number|boolean|any|void)\b/],
  go: [/^\s*(func|type|package|import)\s+/, /^\s*func\s+\([^)]+\)\s+\w+/],
  rust: [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/, /^\s*#\[/],
  java: [/^\s*(public|private|protected)\s+(class|interface|enum)/, /^\s*@\w+/, /^\s*package\s+[\w.]+;/],
}

// ─── Top-level detection ───────────────────────────────────────────

export function detectContentType(content: string): DetectionResult {
  if (!content?.trim()) {
    return { content_type: ContentType.PlainText, confidence: 0, metadata: {} }
  }

  const jsonResult = tryDetectJson(content)
  if (jsonResult) return jsonResult

  const diffResult = tryDetectDiff(content)
  if (diffResult && diffResult.confidence >= 0.7) return diffResult

  const htmlResult = tryDetectHtml(content)
  if (htmlResult && htmlResult.confidence >= 0.7) return htmlResult

  const searchResult = tryDetectSearch(content)
  if (searchResult && searchResult.confidence >= 0.6) return searchResult

  const logResult = tryDetectLog(content)
  if (logResult && logResult.confidence >= 0.5) return logResult

  const codeResult = tryDetectCode(content)
  if (codeResult && codeResult.confidence >= 0.5) return codeResult

  const proseResult = tryDetectProse(content)
  if (proseResult) return proseResult

  return { content_type: ContentType.PlainText, confidence: 0.5, metadata: {} }
}

// ─── Individual detectors ──────────────────────────────────────────

function tryDetectJson(content: string): DetectionResult | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith("[")) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    if (parsed.length > 0 && parsed.every((item) => typeof item === "object" && item !== null)) {
      return { content_type: ContentType.JsonArray, confidence: 1.0, metadata: { item_count: parsed.length, is_dict_array: true } }
    }
    return { content_type: ContentType.JsonArray, confidence: 0.8, metadata: { item_count: parsed.length, is_dict_array: false } }
  } catch {
    return null
  }
}

function tryDetectDiff(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 500)

  let headerMatches = 0
  let changeMatches = 0

  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) headerMatches++
    if (DIFF_CHANGE_RE.test(line)) changeMatches++
  }

  if (headerMatches === 0) return null

  const confidence = Math.min(1.0, 0.5 + headerMatches * 0.2 + changeMatches * 0.05)
  return { content_type: ContentType.GitDiff, confidence, metadata: { header_matches: headerMatches, change_lines: changeMatches } }
}

function tryDetectHtml(content: string): DetectionResult | null {
  const sample = content.slice(0, 3000)

  const hasDoctype = HTML_DOCTYPE_RE.test(sample)
  const hasHtmlTag = HTML_TAG_RE.test(sample)
  const hasHead = HTML_HEAD_RE.test(sample)
  const hasBody = HTML_BODY_RE.test(sample)

  const structuralMatches = [...sample.matchAll(HTML_STRUCTURAL_RE)].length

  if (!hasDoctype && !hasHtmlTag && structuralMatches < 3) return null

  let confidence = 0

  if (hasDoctype) confidence += 0.5
  if (hasHtmlTag) confidence += 0.3
  if (hasHead) confidence += 0.1
  if (hasBody) confidence += 0.1

  confidence += Math.min(0.3, structuralMatches * 0.03)
  confidence = Math.min(1.0, confidence)

  if (confidence < 0.5) return null

  return { content_type: ContentType.Html, confidence, metadata: { has_doctype: hasDoctype, has_html_tag: hasHtmlTag, structural_tags: structuralMatches } }
}

function tryDetectSearch(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 100)
  if (lines.length === 0) return null

  let matchingLines = 0
  for (const line of lines) {
    if (line.trim() && SEARCH_RESULT_RE.test(line)) matchingLines++
  }

  if (matchingLines === 0) return null

  const nonEmpty = lines.filter((l) => l.trim()).length
  if (nonEmpty === 0) return null

  const ratio = matchingLines / nonEmpty
  if (ratio < 0.3) return null

  const confidence = Math.min(1.0, 0.4 + ratio * 0.6)
  return { content_type: ContentType.SearchResults, confidence, metadata: { matching_lines: matchingLines, total_lines: nonEmpty } }
}

function tryDetectLog(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 200)
  if (lines.length === 0) return null

  let patternMatches = 0
  let errorMatches = 0

  for (const line of lines) {
    for (let i = 0; i < LOG_PATTERNS.length; i++) {
      const [pattern, group] = LOG_PATTERNS[i]
      if (pattern.test(line)) {
        patternMatches++
        if (group < 2) errorMatches++
        break
      }
    }
  }

  if (patternMatches === 0) return null

  const nonEmpty = lines.filter((l) => l.trim()).length
  if (nonEmpty === 0) return null

  const ratio = patternMatches / nonEmpty
  if (ratio < 0.1) return null

  const confidence = Math.min(1.0, 0.3 + ratio * 0.5 + errorMatches * 0.05)
  return { content_type: ContentType.BuildOutput, confidence, metadata: { pattern_matches: patternMatches, error_matches: errorMatches, total_lines: nonEmpty } }
}

function tryDetectCode(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 100)
  if (lines.length === 0) return null

  const languageScores: Record<string, number> = {}

  for (const line of lines) {
    for (const [lang, patterns] of Object.entries(CODE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          languageScores[lang] = (languageScores[lang] || 0) + 1
          break
        }
      }
    }
  }

  if (Object.keys(languageScores).length === 0) return null

  let bestLang = ""
  let bestScore = 0
  for (const [lang, score] of Object.entries(languageScores)) {
    if (score > bestScore) {
      bestScore = score
      bestLang = lang
    }
  }

  if (bestScore < 3) return null

  const nonEmpty = lines.filter((l) => l.trim()).length
  const ratio = bestScore / Math.max(nonEmpty, 1)

  const confidence = Math.min(1.0, 0.4 + ratio * 0.4 + bestScore * 0.02)
  return { content_type: ContentType.SourceCode, confidence, metadata: { language: bestLang, pattern_matches: bestScore } }
}

// ─── Prose detection (plain text with multiple sentences) ───────────

const SENTENCE_END_RE = /[.!?]\s+[A-Z]/g

function tryDetectProse(content: string): DetectionResult | null {
  // Count sentence boundaries: period/exclamation/question followed by space and capital
  const matches = [...content.matchAll(SENTENCE_END_RE)]
  const boundaries = matches.length

  // Also count the last sentence if text ends with period
  const trimmed = content.trimEnd()
  if (trimmed.endsWith(".") || trimmed.endsWith("!") || trimmed.endsWith("?")) {
    // Already counted as part of boundaries if followed by capital, but
    // the final sentence won't have that. Add 1 if we have at least some content.
  }

  // Minimum 2 sentences (headroom routes multi-sentence prose to Kompress)
  const estimatedSentences = boundaries + 1
  if (estimatedSentences < 2) return null

  // Must be predominantly text (not code/log/diff)
  // Heuristic: at least 70% of lines don't look like code
  const lines = content.split("\n").filter(l => l.trim())
  if (lines.length === 0) return null

  let proseLines = 0
  for (const line of lines) {
    const t = line.trim()
    // Lines that look like prose: start with capital letter, contain spaces, end with punctuation
    if (/^[A-Z]/.test(t) && t.includes(" ") && !/^\s*(import|export|function|const|let|var|class|def)\s/.test(t)) {
      proseLines++
    }
  }

  const proseRatio = proseLines / lines.length
  if (proseRatio < 0.5) return null

  const confidence = Math.min(0.9, 0.5 + proseRatio * 0.4)
  return { content_type: ContentType.Prose, confidence, metadata: { sentences: estimatedSentences } }
}
