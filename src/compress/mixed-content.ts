import { ContentType } from "./types"

export interface ContentSection {
  content: string
  content_type: ContentType
  start_line: number
  end_line: number
}

// Regex patterns (module-level)
const CODE_FENCE_RE = /^```(\w*)$/
const JSON_BLOCK_START = /^\s*[\[{]/
const SEARCH_RESULT_RE = /^(.+?)[:-](\d+)[:-]/
const PROSE_RE = /[.!?][\s\n]+[A-Z]/g

/**
 * Port of is_mixed_content() — content_router.py:524-541.
 * Detects if content contains 2+ distinct content types.
 */
export function isMixedContent(content: string): boolean {
  const lines = content.split("\n")
  let indicators = 0

  if (lines.some(l => CODE_FENCE_RE.test(l))) indicators++

  if (lines.some(l => JSON_BLOCK_START.test(l))) indicators++

  if (lines.some(l => SEARCH_RESULT_RE.test(l))) indicators++

  const proseMatches = (content.match(PROSE_RE) || []).length
  if (proseMatches > 5) indicators++

  return indicators >= 2
}

/**
 * Port of split_into_sections() — content_router.py:544-645.
 * Parse mixed content into typed sections.
 */
export function splitIntoSections(content: string): ContentSection[] {
  const lines = content.split("\n")
  const sections: ContentSection[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code fence section
    const fenceMatch = CODE_FENCE_RE.exec(line)
    if (fenceMatch) {
      const codeLines: string[] = []
      const startLine = i
      i++

      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i++
      }

      sections.push({
        content: codeLines.join("\n"),
        content_type: ContentType.SourceCode,
        start_line: startLine,
        end_line: i,
      })
      i++ // skip closing ```
      continue
    }

    // JSON block section
    if (JSON_BLOCK_START.test(line.trimStart())) {
      const result = extractJsonBlock(lines, i)
      if (result) {
        sections.push({
          content: result.json,
          content_type: ContentType.JsonArray,
          start_line: i,
          end_line: result.endLine,
        })
        i = result.endLine + 1
        continue
      }
    }

    // Search result lines
    if (SEARCH_RESULT_RE.test(line)) {
      const searchLines: string[] = []
      const startLine = i
      while (i < lines.length && SEARCH_RESULT_RE.test(lines[i])) {
        searchLines.push(lines[i])
        i++
      }
      sections.push({
        content: searchLines.join("\n"),
        content_type: ContentType.SearchResults,
        start_line: startLine,
        end_line: i - 1,
      })
      continue
    }

    // Text section: collect until next special section
    const textLines: string[] = [line]
    const startLine = i
    i++

    while (i < lines.length) {
      const nextLine = lines[i]
      if (CODE_FENCE_RE.test(nextLine) ||
          JSON_BLOCK_START.test(nextLine.trimStart()) ||
          SEARCH_RESULT_RE.test(nextLine)) {
        break
      }
      textLines.push(nextLine)
      i++
    }

    const textContent = textLines.join("\n")
    if (textContent.trim()) {
      sections.push({
        content: textContent,
        content_type: ContentType.PlainText,
        start_line: startLine,
        end_line: i - 1,
      })
    }
  }

  return sections
}

/**
 * Port of _extract_json_block() — content_router.py:648-698.
 * Extract a complete JSON block, handling string-escaped brackets/braces.
 */
function extractJsonBlock(lines: string[], start: number): { json: string; endLine: number } | null {
  let bracketCount = 0
  let braceCount = 0
  const jsonLines: string[] = []
  let inString = false
  let escaped = false

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    jsonLines.push(line)

    for (const ch of line) {
      if (escaped) { escaped = false; continue }
      if (ch === "\\") { if (inString) escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === "[") bracketCount++
      else if (ch === "]") bracketCount--
      else if (ch === "{") braceCount++
      else if (ch === "}") braceCount--
    }

    if (bracketCount <= 0 && braceCount <= 0 && jsonLines.length > 0) {
      return { json: jsonLines.join("\n"), endLine: i }
    }
  }

  return null
}
