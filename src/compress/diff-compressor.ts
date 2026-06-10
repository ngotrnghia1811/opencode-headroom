export interface DiffCompressorConfig {
  max_context_lines: number
  max_hunks_per_file: number
  max_files?: number
  keep_file_headers: boolean
}

const DEFAULTS: DiffCompressorConfig = {
  max_context_lines: 3,
  max_hunks_per_file: 10,
  max_files: 10,
  keep_file_headers: true,
}

import { deriveKey } from "../ccr/hash"
import type { CcrStore } from "../ccr/store"

// ─── Module-level regex ────────────────────────────────────────────

const FILE_HEADER_RE = /^(diff --git |--- a\/|\+\+\+ b\/|index [0-9a-f]+\.\.[0-9a-f]+)/
const HUNK_HEADER_RE = /^@@+ -?\d+(?:,\d+)? (?:-?\d+(?:,\d+)? )*\+?\d+(?:,\d+)? @@+/
const ADD_DEL_RE = /^[+-]/
const CONTEXT_RE = /^ /

// ─── Structured types ──────────────────────────────────────────────

interface DiffHunk {
  header: string // @@ -a,b +c,d @@ optional context
  lines: string[] // all lines in this hunk (+, -, space, \ No newline)
  addCount: number
  delCount: number
}

interface DiffFile {
  header: string[] // all lines from diff --git ... to first @@
  hunks: DiffHunk[]
}

// ─── Public API ────────────────────────────────────────────────────

export function compressDiff(
  content: string,
  config?: Partial<DiffCompressorConfig>,
  store?: CcrStore,
): string {
  const cfg = { ...DEFAULTS, ...config }
  const lines = content.split("\n")

  if (lines.length < 5) return content

  const ccrHash = store ? deriveKey(content) : undefined
  const result = compressDiffLines(lines, cfg, ccrHash)

  // Token monotone: if compressed is longer than original, return original
  if (result.length >= content.length) return content

  if (store && ccrHash) store.put(ccrHash, content)
  return result
}

// ─── Structured parser ─────────────────────────────────────────────

function parseDiff(content: string): DiffFile[] {
  const lines = content.split("\n")
  const files: DiffFile[] = []
  let currentFile: DiffFile | null = null
  let currentHunkLines: string[] = []
  let currentHunkHeader = ""
  let addCount = 0
  let delCount = 0
  let seenFirstHunk = false

  const flushHunk = () => {
    if (!currentHunkHeader || !currentFile) return
    currentFile.hunks.push({
      header: currentHunkHeader,
      lines: currentHunkLines,
      addCount,
      delCount,
    })
    currentHunkLines = []
    currentHunkHeader = ""
    addCount = 0
    delCount = 0
  }

  for (const line of lines) {
    if (/^diff --git /.test(line)) {
      flushHunk()
      if (currentFile) files.push(currentFile)
      currentFile = { header: [line], hunks: [] }
      seenFirstHunk = false
      continue
    }

    if (!currentFile) continue

    // Combined diff headers (--- / +++ before diff --git in merge diffs)
    if (!seenFirstHunk && /^(---|\+\+\+) /.test(line)) {
      currentFile.header.push(line)
      continue
    }

    if (HUNK_HEADER_RE.test(line)) {
      flushHunk()
      currentHunkHeader = line
      seenFirstHunk = true
      continue
    }

    if (!seenFirstHunk) {
      currentFile.header.push(line)
      continue
    }

    // Inside hunk — collect lines
    if (currentHunkHeader) {
      currentHunkLines.push(line)
      if (line.startsWith("+") && !line.startsWith("+++")) addCount++
      if (line.startsWith("-") && !line.startsWith("---")) delCount++
    }
  }

  flushHunk()
  if (currentFile) files.push(currentFile)
  return files
}

// ─── Hunk compression ──────────────────────────────────────────────

function compressHunk(hunk: DiffHunk, maxContextLines: number): string[] {
  const result: string[] = [hunk.header]

  // Find first and last change line indices
  let firstChange = -1
  let lastChange = -1
  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i]
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      if (firstChange === -1) firstChange = i
      lastChange = i
    }
  }

  if (firstChange === -1) {
    const totalContext = hunk.lines.length
    if (totalContext > 0) {
      result.push(`[... ${totalContext} context-only lines dropped]`)
    }
    return result
  }

  let contextDropped = 0

  const isChangeLine = (line: string) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))

  for (let i = 0; i < hunk.lines.length; i++) {
    if (isChangeLine(hunk.lines[i])) {
      if (contextDropped > 0) {
        result.push(`[... ${contextDropped} context lines dropped]`)
        contextDropped = 0
      }
      result.push(hunk.lines[i])
      continue
    }

    // Context line — keep if within maxContextLines of a change
    if (i < firstChange) {
      if (firstChange - i <= maxContextLines) {
        if (contextDropped > 0) {
          result.push(`[... ${contextDropped} context lines dropped]`)
          contextDropped = 0
        }
        result.push(hunk.lines[i])
      } else {
        if (contextDropped === 0) contextDropped = 1
        contextDropped++
      }
    } else if (i > lastChange) {
      if (i - lastChange <= maxContextLines) {
        if (contextDropped > 0) {
          result.push(`[... ${contextDropped} context lines dropped]`)
          contextDropped = 0
        }
        result.push(hunk.lines[i])
      } else {
        if (contextDropped === 0) contextDropped = 1
        contextDropped++
      }
    } else {
      // Between changes — always keep
      result.push(hunk.lines[i])
    }
  }

  if (contextDropped > 0) {
    result.push(`[... ${contextDropped} context lines dropped]`)
  }

  return result
}

// ─── Main compression (structured) ─────────────────────────────────

function compressDiffLines(lines: string[], cfg: DiffCompressorConfig, ccrHash?: string): string {
  const content = lines.join("\n")
  const files = parseDiff(content)

  if (files.length === 0) return compressDiffLinesFallback(lines, cfg, ccrHash)

  const retrieveHint = ccrHash ? ` — retrieve with <<ccr:${ccrHash}>>` : ""
  const maxFiles = cfg.max_files ?? 10

  // Cap files by total change density
  let selectedFiles = files
  if (files.length > maxFiles) {
    selectedFiles = [...files]
      .sort((a, b) => {
        const aChanges = a.hunks.reduce((s, h) => s + h.addCount + h.delCount, 0)
        const bChanges = b.hunks.reduce((s, h) => s + h.addCount + h.delCount, 0)
        return bChanges - aChanges
      })
      .slice(0, maxFiles)
  }

  const output: string[] = []

  for (const file of selectedFiles) {
    // Output file header
    for (const h of file.header) output.push(h)

    // Select top hunks by change density
    let fileHunks = file.hunks
    if (fileHunks.length > cfg.max_hunks_per_file) {
      fileHunks = [...fileHunks]
        .sort((a, b) => b.addCount + b.delCount - (a.addCount + a.delCount))
        .slice(0, cfg.max_hunks_per_file)
    }

    for (const hunk of fileHunks) {
      const compressed = compressHunk(hunk, cfg.max_context_lines)
      for (const cl of compressed) {
        if (cl.startsWith("[... ")) {
          output.push(cl.replace("]", `${retrieveHint}]`))
        } else {
          output.push(cl)
        }
      }
    }

    // Mark omitted hunks
    const omittedHunks = file.hunks.length - fileHunks.length
    if (omittedHunks > 0) {
      output.push(`[... ${omittedHunks} hunks omitted${retrieveHint}]`)
    }
  }

  // Mark omitted files
  const omittedFiles = files.length - selectedFiles.length
  if (omittedFiles > 0) {
    output.push(`[... ${omittedFiles} files omitted${retrieveHint}]`)
  }

  return output.join("\n")
}

// ─── Fallback: old line-scan approach ──────────────────────────────

function compressDiffLinesFallback(lines: string[], cfg: DiffCompressorConfig, ccrHash?: string): string {
  const output: string[] = []
  const retrieveHint = ccrHash ? ` — retrieve with <<ccr:${ccrHash}>>` : ""
  let currentHunkContext: string[] = []
  let hunksInFile = 0
  let contextDropped = 0
  let inHunk = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // File headers — always keep
    if (FILE_HEADER_RE.test(line)) {
      if (contextDropped > 0) {
        output.push(`[... ${contextDropped} context lines dropped${retrieveHint}]`)
        contextDropped = 0
      }
      hunksInFile = 0
      inHunk = false
      currentHunkContext = []
      output.push(line)
      continue
    }

    // Hunk header
    if (HUNK_HEADER_RE.test(line)) {
      if (contextDropped > 0) {
        output.push(`[... ${contextDropped} context lines dropped${retrieveHint}]`)
        contextDropped = 0
      }
      hunksInFile++
      inHunk = true
      currentHunkContext = []

      if (hunksInFile <= cfg.max_hunks_per_file) {
        output.push(line)
        continue
      }
      // Skip this hunk
      inHunk = false
      continue
    }

    if (!inHunk) {
      if (contextDropped === 0) contextDropped = 1
      contextDropped++
      continue
    }

    // Additions / deletions — always keep
    if (ADD_DEL_RE.test(line)) {
      if (contextDropped > 0) {
        output.push(`[... ${contextDropped} context lines dropped${retrieveHint}]`)
        contextDropped = 0
      }
      output.push(line)
      currentHunkContext = []
      continue
    }

    // Context lines — keep only max_context_lines around changes
    if (CONTEXT_RE.test(line) || /^\s*$/.test(line)) {
      currentHunkContext.push(line)
      if (currentHunkContext.length <= cfg.max_context_lines) {
        if (contextDropped > 0) {
          output.push(`[... ${contextDropped} context lines dropped${retrieveHint}]`)
          contextDropped = 0
        }
        output.push(line)
      } else {
        if (contextDropped === 0) contextDropped = 1
        contextDropped++
      }
      continue
    }

    // All other lines
    if (contextDropped > 0) {
      output.push(`[... ${contextDropped} context lines dropped${retrieveHint}]`)
      contextDropped = 0
    }
    output.push(line)
    currentHunkContext = []
  }

  if (contextDropped > 0) {
    output.push(`[... ${contextDropped} context lines dropped${retrieveHint}]`)
  }

  return output.join("\n")
}
