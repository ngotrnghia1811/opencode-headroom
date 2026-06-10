export interface DiffCompressorConfig {
  max_context_lines: number
  max_hunks_per_file: number
  keep_file_headers: boolean
}

const DEFAULTS: DiffCompressorConfig = {
  max_context_lines: 3,
  max_hunks_per_file: 10,
  keep_file_headers: true,
}

import { deriveKey } from "../ccr/hash"
import type { CcrStore } from "../ccr/store"

// ─── Module-level regex ────────────────────────────────────────────

const FILE_HEADER_RE = /^(diff --git |--- a\/|\+\+\+ b\/|index [0-9a-f]+\.\.[0-9a-f]+)/
const HUNK_HEADER_RE = /^@@+ -?\d+(?:,\d+)? (?:-?\d+(?:,\d+)? )*\+?\d+(?:,\d+)? @@+/
const ADD_DEL_RE = /^[+-]/
const CONTEXT_RE = /^ /

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

// ─── Compression ───────────────────────────────────────────────────

function compressDiffLines(lines: string[], cfg: DiffCompressorConfig, ccrHash?: string): string {
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
      // Flush any dropped context marker
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
      // Keep context lines if we're within the limit
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
