# opencode-headroom — Development Plan

*Reference: /Users/nghiango-mbp/opencode-learn/_references/headroom (v0.24.0) | Last updated: 2026-06-09*

---

## 1. Feature Description

**What.** An opencode plugin that brings headroom's context compression into opencode's agent loop. Headroom is a context compression layer for AI agents that intercepts prompts, tool outputs, logs, search results, diffs, files, and conversation history before they reach the LLM, applying type-aware compression to reduce token usage by 60–95% while preserving accuracy.

**Example: tool output compression.** An opencode agent runs `rg "error" src/` and gets 800 lines of grep output. Without headroom, all 800 lines enter the LLM context verbatim — ~3,200 tokens. The plugin's `experimental.chat.messages.transform` hook intercepts the tool result block, routes it through the ContentDetector (which classifies it as `SearchResults`), dispatches to SearchCompressor, and produces a compressed representation: file headers + first/last matches per file + error-boosted lines — ~120 tokens. A `<<ccr:a1b2c3d4e5f6...>>` marker is appended so the LLM can retrieve the original on demand.

**Example: CCR retrieval.** Later in the conversation, the LLM calls the `headroom_retrieve` tool:

```
Tool: headroom_retrieve
Args: { "hash": "a1b2c3d4e5f6a1b2c3d4e5f6" }
→ Returns the original 800-line grep output from the CCR store (SQLite, BLAKE3-keyed).
```

**Purpose in an opencode workflow.** Coding agents accumulate context fast — every `bash` tool call, every `read` file output, every `grep` result. Headroom compresses this stream *before* it reaches the LLM, reducing:
- **Context bloat**: fewer tokens = faster responses
- **Cost**: 60–95% token reduction on tool outputs means 60–95% fewer billable tokens
- **Effective context window**: compressed content lets the agent see more history before hitting context limits

The plugin is **reversible**: originals are stored in a CCR (Compress-Cache-Retrieve) SQLite store, keyed by BLAKE3 hash. The LLM can call `headroom_retrieve(hash)` to get any original it needs.

---

## 2. Reference Implementation Analysis

The reference at `_references/headroom` (v0.24.0) is a Python+PyO3+Rust project: Python orchestrates the proxy pipeline, Rust crates provide the hot-path compressors via PyO3 bindings, and a TypeScript SDK wraps the proxy API. Key components being ported:

### 2.1 ContentDetector

- **What it does.** Classifies a text block into one of seven content types: `JsonArray`, `SourceCode`, `SearchResults`, `BuildOutput`, `GitDiff`, `Html`, `PlainText`. Detection is regex/heuristic-based — no ML, no I/O.
- **Core algorithm.** Ordered cascade of regex detectors with confidence scoring:
  1. **JSON** (`content_detector.py:171–198`): parse with `JSON.parse`; if array-of-objects → `JsonArray` with confidence 1.0; if array but not-of-dicts → confidence 0.8.
  2. **Diff** (`content_detector.py:201–234`): scan first 500 lines for `diff --git`, `@@ -A,B +C,D @@`, `--- a/` headers. Count header matches and `[+-]` change lines. Confidence = `min(1.0, 0.5 + headers*0.2 + changes*0.05)`. Minimum 1 header match required.
  3. **HTML** (`content_detector.py:248–303`): check first 3000 chars for `<!doctype html>`, `<html>`, `<head>`, `<body>`, structural tags (`<div>`, `<span>`, `<script>`, etc.). Confidence from weighted sum — needs ≥0.5 to return.
  4. **Search results** (`content_detector.py:306–337`): pattern `^[^\s:]+:\d+:` on first 100 lines. Needs ≥30% of non-empty lines to match. Confidence = `min(1.0, 0.4 + ratio*0.6)`.
  5. **Build/log output** (`content_detector.py:340–380`): 11 log patterns (ERROR/WARN/INFO, timestamps, tracebacks, stack traces, npm/cargo errors, test PASSED/FAILED). Scan first 200 lines, needs ≥10% matches. Confidence = `min(1.0, 0.3 + ratio*0.5 + errors*0.05)`.
  6. **Source code** (`content_detector.py:383–418`): language-specific patterns for Python, JavaScript, TypeScript, Go, Rust, Java. Scan first 100 lines, needs ≥3 matches for best language. Confidence = `min(1.0, 0.4 + ratio*0.4 + matches*0.02)`.
  7. **Fallback**: `PlainText` with confidence 0.5.

  Detection order is priority-ordered: more distinctive formats (JSON, diff, HTML) are checked first; more ambiguous formats (log, code) later. The Rust port (`content_detector.rs`, 769 LOC) mirrors this byte-for-byte using `regex::Regex` compiled in `LazyLock` statics.
- **Where to find it.** Python: `headroom/transforms/content_detector.py` (435 LOC). Rust: `crates/headroom-core/src/transforms/content_detector.rs` (769 LOC, includes Magika integration layer).
- **Complexity: Low.** Pure regex cascade, no state, no async. Straightforward port to TypeScript with native `RegExp`.

### 2.2 SmartCrusher

- **What it does.** Statistical JSON array compression. Given a JSON array of objects (e.g. tool output from a list API), keeps the most informative subset: first K items, last K items, error/anomaly items, and relevance-scored items. The Rust port also does lossless-first compaction (tabular arrays → CSV+schema strings; opaque blobs → `<<ccr:HASH>>` markers).
- **Core algorithm.** Three-tier decision (port of `adaptive_sizer.rs`, 610 LOC):
  1. **Fast path** (`n ≤ 8` → keep all). Compute unique-count via SimHash clustering (MD5 of 4-grams → first 64 bits → weighted-vote aggregation). If ≤3 unique groups → keep that many.
  2. **Kneedle algorithm** (standard path): Build a cumulative unique-bigram coverage curve by iterating items in importance order. A bigram is a pair of whitespace-split words `(word_i, word_{i+1})`. The curve `y_i = |unique_bigrams_seen_so_far|` is normalized to [0,1] on both axes. The "knee" is the point of maximum deviation from the diagonal `y=x`: `knee = argmax_i (norm_x_i - norm_y_i)`. Requires deviation > 0.05; if none found → scale keep-fraction by diversity ratio (`0.3 + 0.7 * diversity_ratio`).
  3. **zlib validation**: compress the kept K items via zlib (level 1) and the full N items. If `compressed_ratio(kept) / compressed_ratio(full) < 0.85` (kept subset is much more redundant), bump K by 20%.

  The kept fraction is split: `first_fraction=0.3` items from the start, `last_fraction=0.15` from the end, and the remainder filled by relevance score. Error/anomaly items bypass the cap. CCR markers (`<<ccr:BLAKE3_24HEX>>`) are appended for dropped rows.

  For MVP, use a simplified K = `Math.ceil(Math.sqrt(n))` with first/last bias — the full Kneedle port arrives in Phase 3.
- **Where to find it.** Python (Rust-bridge shim): `headroom/transforms/smart_crusher.py` (910 LOC). Rust core: `crates/headroom-core/src/transforms/smart_crusher/` (21 modules). Adaptive sizer: `crates/headroom-core/src/transforms/adaptive_sizer.rs` (610 LOC).
- **Complexity: High.** Full port involves SimHash, Kneedle, zlib validation, BM25 relevance scoring, outlier detection. MVP simplifies K selection; full port deferred to Phase 3.

### 2.3 LogCompressor

- **What it does.** Compresses build/test/lint log output. Deduplicates repeated lines, keeps errors/warnings/first/last lines, preserves stack traces and summary lines.
- **Core algorithm.** Five-stage pipeline:
  1. **Format detection**: classify as pytest/npm/cargo/make/jest/generic via keyword patterns.
  2. **Line parsing**: classify each line as ERROR/FAIL/WARN/INFO/DEBUG/TRACE; detect stack traces and summary lines via regex.
  3. **Scoring**: per-line importance score (ERROR=1.0, FAIL=1.0, WARN=0.5, INFO=0.1, DEBUG=0.05, TRACE=0.02; +0.3 for stack traces, +0.4 for summaries).
  4. **Selection**: keep first + last errors (configurable), top-N warnings with conservative dedupe, top-M stack traces with line limit. Dedupe normalizes only the trailing variable region (digits→N, hex→ADDR, paths→/PATH/) after the first `:` or `=`, preserving message identifiers.
  5. **Adaptive cap**: use `compute_optimal_k` (Kneedle) to bound total lines; if still exceeding, take top-scoring lines.
- **Where to find it.** Python (Rust-bridge shim): `headroom/transforms/log_compressor.py` (516 LOC). Rust core: `crates/headroom-core/src/transforms/log_compressor.rs`.
- **Complexity: Low–Medium.** Regex classification and scoring are straightforward. Conservate dedupe and adaptive cap add mild complexity.

### 2.4 SearchCompressor

- **What it does.** Compresses grep/ripgrep output. Collapses `file:line:match` patterns into per-file compact representations: keep first + last match per file, top-scoring matches by relevance to context, error-keyword-boosted lines. Stale-file lines within a file are dropped if the file has too many matches.
- **Core algorithm.**
  1. **Parse**: split content by `file:line:match` pattern. Rust parser handles Windows paths (drive-letter colon) and dashes-in-filename that the old Python regex broke.
  2. **Score**: boost matches containing context keywords (+0.3 per word match), error keywords from `PRIORITY_PATTERNS_SEARCH` (+0.5 to +0.1), and custom context keywords (+0.4).
  3. **Select**: adaptive K via `compute_optimal_k`; per-file cap via `max_matches_per_file` (default 5); always keep first/last; global cap via `max_total_matches` (default 30) and `max_files` (default 15).
  4. **Format**: reconstruct `file:line:match` lines for kept matches, append `[... and N more matches in file]` summaries.
- **Where to find it.** Python (Rust-bridge shim): `headroom/transforms/search_compressor.py` (373 LOC). Rust core: `crates/headroom-core/src/transforms/search_compressor.rs`.
- **Complexity: Low.** Parse/score/select/filter pipeline with straightforward regex and scoring math.

### 2.5 DiffCompressor

- **What it does.** Compresses unified diffs. Keeps file headers (`diff --git a/... b/...`), hunk markers (`@@ -A,B +C,D @@`), added/deleted lines (`+`/`-`), and up to `max_context_lines` (default 2) of context lines. Drops unchanged context lines. Caps hunks per file (default 10), files (default 20). CCR-offloads large diffs (>50 lines).
- **Core algorithm.**
  1. Parse diff into files → hunks → lines with tag (context/add/del/header).
  2. For each hunk, keep: header line, all `+`/`-` lines, and `max_context_lines` context lines around each changed block.
  3. Cap hunks per file and files globally.
  4. If lines removed > `min_lines_for_ccr` (50), emit `<<ccr:HASH>>` marker.
- **Where to find it.** Python (Rust-bridge shim): `headroom/transforms/diff_compressor.py` (171 LOC). Rust core: `crates/headroom-core/src/transforms/diff_compressor.rs`.
- **Complexity: Low.** Line-by-line state machine; the only subtlety is hunk boundary detection (including merge-commit `@@@` headers).

### 2.6 CacheAligner

- **What it does.** **Detector-only** transform (no mutation). Scans the system prompt for volatile/dynamic content that breaks LLM provider KV cache hits: UUIDs, ISO 8601 timestamps, JWTs, and hex hashes (MD5/SHA1/SHA256). Emits warnings so operators know their cache prefix is unstable.
- **Core algorithm.**
  1. Split system prompt content into whitespace-delimited tokens (strip surrounding punctuation).
  2. Classify each token via structural parsers (no regex):
     - **UUID**: canonical 36-char form with 4 dashes via `uuid.UUID()` parse.
     - **ISO 8601**: `datetime.fromisoformat()` parse, supports `Z` suffix → `+00:00` conversion.
     - **JWT**: three dot-separated base64url segments, each decodable.
     - **Hex hash**: length in {32, 40, 64}, all hex digits.
  3. Emit one warning per token type with count: e.g. `"CacheAligner: detected volatile content in system prompt (uuid=3, iso8601=5, hex_hash=2); cache prefix unstable."`
  4. Compute stable prefix hash for observability (`CachePrefixMetrics`).
  **Invariant I2**: the prompt is never modified. The earlier rewrite path (strip dynamic content → re-insert as context block) was removed because it mutated the cache hot zone.
- **Where to find it.** `headroom/transforms/cache_aligner.py` (388 LOC).
- **Complexity: Low.** Pure detection — no mutation, no async. TypeScript equivalents: `crypto.randomUUID()` for UUID parsing (or manual dash-count check), `new Date(token).toISOString()` round-trip for ISO 8601, `Buffer.from(seg, 'base64url')` for JWT segments, length+hex-digit check for hashes.

### 2.7 CCR (Compress-Cache-Retrieve)

- **What it does.** Reversibility layer for compressed content. When a compressor drops data, it stores the original payload in a key-value store keyed by BLAKE3 hash (`first 24 hex chars` → 96 bits). The compressed output carries a `<<ccr:HASH>>` marker. The LLM can call `headroom_retrieve(hash)` to get the original back.
- **Core algorithm.**
  1. **Put**: `compute_key(payload)` → BLAKE3 hash, first 24 hex chars. Store `(hash, payload, timestamp)` in backend. Cap at 1000 entries (LRU eviction). TTL 5 minutes.
  2. **Get**: lookup hash → return payload or `null` if missing/expired. Expiry is checked on read (lazy eviction).
  3. **Marker format**: `<<ccr:${hash}>>` (fixed grammar across all compressors).
  4. **Marker injection**: compressors append the marker to their output when they drop data.
- **Backends** (Rust). In-memory (`DashMap`), SQLite (WAL mode, shared DB file), Redis (cfg-gated). The plugin uses `bun:sqlite` as the TypeScript equivalent.
- **Where to find it.** Rust: `crates/headroom-core/src/ccr/mod.rs` (116 LOC). Python store: `headroom/cache/compression_store.py`. CCR tool injection: `headroom/ccr/tool_injection.py`.
- **Complexity: Low.** Simple key-value store with TTL. `bun:sqlite` is synchronous and fast — ~20 lines of setup.

### 2.8 TransformPipeline

- **What it does.** Orchestrates the compression pipeline: CacheAligner → ContentRouter → (compressor delegation). Fail-open semantics: any failure in any transform reverts to original content. Token-monotone validation: if `tokens(compressed) >= tokens(original)`, the compression is reverted.
- **Core algorithm.**
  1. **Deep copy** input messages (so transforms don't alias into the caller's data).
  2. **Freeze prefix**: skip first `frozen_message_count` messages (they're provider-KV-cached — invariant I2).
  3. **Apply transforms in order**: for each transform, check `should_apply()` → call `apply()` → accumulate results (tokens saved, transforms applied, warnings, timing).
  4. **Live-zone only**: only the most recent user message + latest tool results are in the "live zone" and subject to compression. Earlier messages are in the "frozen zone" and untouched.
  5. **Empty-output guard**: if compression produces empty output from non-empty input, revert to original (empty user-message content causes Anthropic 400).
  6. **Report**: `TransformResult` with `messages`, `tokens_before`, `tokens_after`, `transforms_applied`, `markers_inserted`, `warnings`, `timing`.
- **Where to find it.** `headroom/transforms/pipeline.py` (438 LOC). Rust live-zone logic: `crates/headroom-core/src/transforms/live_zone.rs`.
- **Complexity: Medium.** Orchestration with multiple invariants (fail-open, token-monotone, empty-output guard).

---

## 3. opencode Integration Architecture

### 3.1 Plugin Hooks Used

| Hook | Purpose | Priority |
|---|---|---|
| `experimental.chat.messages.transform` | **Primary.** Intercept messages before LLM call; compress tool results and non-user messages in the live zone. The `output.messages` array is mutated in-place. | 1 (MVP) |
| `tool` | Expose `headroom_retrieve` tool for CCR retrieval. | 2 |
| `experimental.chat.system.transform` | CacheAligner: scan system prompt for volatile content, emit warnings. Read-only — never mutates the system prompt (invariant I2). | 3 |
| `tool.execute.after` | Per-tool-output compression: compress a single tool result as it streams in, before it joins the message array. Lower overhead than full-message-scan. | 4 (optimization) |

### 3.2 Hook Details

**`experimental.chat.messages.transform`** (primary integration point):

```ts
"experimental.chat.messages.transform"?: (
  input: {},
  output: {
    messages: { info: Message; parts: Part[] }[]
  },
) => Promise<void>
```

The hook receives `output.messages` — an array of `{ info, parts }` objects where `info` is the opencode internal `Message` (containing `role`, `id`, `content`, `toolCalls`, etc.) and `parts` are the structured content blocks. The plugin mutates `output.messages` in place, replacing large text content in tool results with compressed versions.

**`tool` hook** (CCR retrieval):

```ts
tool: {
  headroom_retrieve: tool({
    description: "Retrieve original content for a CCR hash produced by headroom compression",
    args: {
      hash: z.string().describe("24-char BLAKE3 hex hash from a <<ccr:HASH>> marker"),
    },
    async execute(args, ctx) {
      const original = ccrStore.get(args.hash)
      return { title: `CCR Retrieve: ${args.hash.slice(0, 8)}...`, output: original ?? "Not found" }
    },
  })
}
```

### 3.3 Compression Pipeline as an opencode Plugin

```
opencode session
       │
       ▼
┌─────────────────────────────────────────────────┐
│  experimental.chat.messages.transform hook       │
│                                                  │
│  HeadroomPlugin.compress(messages)               │
│    │                                             │
│    ├─ 1. Identify live zone                      │
│    │     (most recent user msg + tool results)    │
│    │                                             │
│    ├─ 2. CacheAligner.detect(systemPrompt)       │
│    │     → emit warnings, never mutate            │
│    │                                             │
│    ├─ 3. For each live-zone text block:          │
│    │     ContentDetector.detect(text)             │
│    │       │                                     │
│    │       ├─ JsonArray → SmartCrusher.crush()   │
│    │       ├─ SearchResults → SearchCompressor   │
│    │       ├─ BuildOutput → LogCompressor        │
│    │       ├─ GitDiff → DiffCompressor           │
│    │       ├─ Html → HtmlExtractor               │
│    │       └─ PlainText → passthrough (MVP)       │
│    │                                             │
│    ├─ 4. Token-monotone validation                │
│    │     if tokens(compressed) ≥ tokens(original) │
│    │       → revert to original                   │
│    │                                             │
│    ├─ 5. CCR store (if compression dropped data) │
│    │     ccrStore.put(hash, original)             │
│    │     append <<ccr:HASH>> marker                │
│    │                                             │
│    └─ 6. Return mutated messages                  │
│                                                  │
└─────────────────────────────────────────────────┘
       │
       ▼
   LLM Provider
       │
       ├── LLM calls headroom_retrieve(hash)
       │     → ccrStore.get(hash) → original content
       │
       ▼
   LLM Response
```

### 3.4 TypeScript/Bun-Native Implementation

**No Python runtime required.** The plugin is pure TypeScript running in Bun. All compressors are implemented natively in TypeScript — regex for detection, string operations for compression, `bun:sqlite` for CCR storage.

### 3.5 CCR Backend: `bun:sqlite`

```ts
import { Database } from "bun:sqlite"

const db = new Database(":memory:") // or file path from workspace dir
db.run(`
  CREATE TABLE IF NOT EXISTS ccr_entries (
    hash TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`)
const putStmt = db.prepare("INSERT OR REPLACE INTO ccr_entries (hash, payload) VALUES (?, ?)")
const getStmt = db.prepare("SELECT payload FROM ccr_entries WHERE hash = ? AND created_at > unixepoch() - 300")
const purgeStmt = db.prepare("DELETE FROM ccr_entries WHERE created_at < unixepoch() - 300")
```

### 3.6 Token Counting: `js-tiktoken`

```ts
import { encoding_for_model } from "js-tiktoken"

const enc = encoding_for_model("gpt-4o") // or cl100k_base for generic
function countTokens(text: string): number {
  return enc.encode(text).length
}
```

---

## 4. Step-by-Step Implementation Plan

### Step 1 — Package Scaffolding

**What.** Create the plugin skeleton: `package.json`, `tsconfig.json`, `src/index.ts` stub.

**Key files.** `contrib/opencode-headroom/package.json`, `tsconfig.json`, `src/index.ts`.

**TS sketch (`package.json`):**

```json
{
  "name": "opencode-headroom",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/index.ts"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "dependencies": {
    "js-tiktoken": "^1.0.19"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

**TS sketch (`src/index.ts` stub):**

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const server: Plugin = async (input, options) => {
  return {
    tool: {},
  }
}
```

**Why this step comes first.** Everything else depends on a compilable plugin skeleton. Run `bun typecheck` to verify.

---

### Step 2 — ContentDetector Module

**What.** Port the regex content type detection from `content_detector.py` / `content_detector.rs` to TypeScript.

**Key files.** `src/compress/content-detector.ts`, `src/compress/types.ts`.

**TS sketch (`src/compress/types.ts`):**

```ts
export const ContentType = {
  JsonArray: "json_array",
  SourceCode: "source_code",
  SearchResults: "search",
  BuildOutput: "build",
  GitDiff: "diff",
  Html: "html",
  PlainText: "text",
} as const
export type ContentType = (typeof ContentType)[keyof typeof ContentType]

export interface DetectionResult {
  content_type: ContentType
  confidence: number
  metadata: Record<string, unknown>
}
```

**TS sketch (`src/compress/content-detector.ts`):**

```ts
import { ContentType, type DetectionResult } from "./types"

// ─── Compiled regex patterns (module-level, shared) ────────────────

const SEARCH_RESULT_RE = /^[^\s:]+:\d+:/
const DIFF_HEADER_RE = /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/
const DIFF_CHANGE_RE = /^[+-][^+-]/
const HTML_DOCTYPE_RE = /^\s*<!doctype\s+html/i
const HTML_STRUCTURAL_RE = /<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/i

const LOG_PATTERNS: [RegExp, number][] = [
  [/\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i, 0],  // index 0-1: error patterns
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

  // 1. JSON (highest priority — SmartCrusher compatibility)
  const jsonResult = tryDetectJson(content)
  if (jsonResult) return jsonResult

  // 2. Diff (very distinctive)
  const diffResult = tryDetectDiff(content)
  if (diffResult && diffResult.confidence >= 0.7) return diffResult

  // 3. HTML
  const htmlResult = tryDetectHtml(content)
  if (htmlResult && htmlResult.confidence >= 0.7) return htmlResult

  // 4. Search results
  const searchResult = tryDetectSearch(content)
  if (searchResult && searchResult.confidence >= 0.6) return searchResult

  // 5. Build/log output
  const logResult = tryDetectLog(content)
  if (logResult && logResult.confidence >= 0.5) return logResult

  // 6. Source code
  const codeResult = tryDetectCode(content)
  if (codeResult && codeResult.confidence >= 0.5) return codeResult

  // 7. Fallback
  return { content_type: ContentType.PlainText, confidence: 0.5, metadata: {} }
}

// ─── Individual detectors ──────────────────────────────────────────

function tryDetectJson(content: string): DetectionResult | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith("[")) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && parsed.every((item) => typeof item === "object" && item !== null)) {
        return { content_type: ContentType.JsonArray, confidence: 1.0, metadata: { item_count: parsed.length, is_dict_array: true } }
      }
      return { content_type: ContentType.JsonArray, confidence: 0.8, metadata: { item_count: parsed.length, is_dict_array: false } }
    }
  } catch { /* not valid JSON */ }
  return null
}

// tryDetectDiff, tryDetectHtml, tryDetectSearch, tryDetectLog, tryDetectCode
// follow the same algorithm as §2.1 — scanning first 100-500 lines,
// counting pattern matches, computing confidence via the same formulas
```

**Why this step comes before Step 3–6.** Every compressor dispatch depends on ContentDetector output. Must be implemented and tested first.

---

### Step 3 — LogCompressor

**What.** Compress build/test/lint log output.

**Key files.** `src/compress/log-compressor.ts`.

**TS sketch:**

```ts
export interface LogCompressorConfig {
  max_errors: number       // default 10
  error_context_lines: number  // default 3
  keep_first_error: boolean    // default true
  keep_last_error: boolean     // default true
  max_stack_traces: number     // default 3
  stack_trace_max_lines: number  // default 20
  max_warnings: number        // default 5
  dedupe_warnings: boolean    // default true
  keep_summary_lines: boolean // default true
  max_total_lines: number     // default 100
}

export interface LogCompressionResult {
  compressed: string
  original_line_count: number
  compressed_line_count: number
  format_detected: string  // "pytest" | "npm" | "cargo" | "make" | "jest" | "generic"
  compression_ratio: number
}

export function compressLog(content: string, config?: Partial<LogCompressorConfig>): LogCompressionResult {
  const cfg = { /* defaults merged with config */ }
  const lines = content.split("\n")
  const detected = detectLogFormat(lines)
  const parsed = parseLogLines(lines, cfg)

  // Select lines: keep first/last errors, top warnings (deduped), stack traces, summaries
  const selected = selectLogLines(parsed, cfg)

  // Cap at adaptive max (simplified: sqrt(n) for MVP)
  const formatResult = formatLogOutput(selected, lines)

  return {
    compressed: formatResult.output,
    original_line_count: lines.length,
    compressed_line_count: selected.length,
    format_detected: detected,
    compression_ratio: selected.length / Math.max(1, lines.length),
  }
}
```

**Why this step comes before Step 4/5/6.** LogCompressor is the simplest compressor — good for establishing the compressor interface and testing patterns. Search and Diff follow the same shape.

---

### Step 4 — SearchCompressor

**What.** Compress grep/ripgrep output.

**Key files.** `src/compress/search-compressor.ts`.

**TS sketch:**

```ts
export interface SearchCompressorConfig {
  max_matches_per_file: number  // default 5
  always_keep_first: boolean    // default true
  always_keep_last: boolean     // default true
  max_total_matches: number     // default 30
  max_files: number             // default 15
  context_keywords: string[]    // default []
  boost_errors: boolean         // default true
}

export interface SearchCompressionResult {
  compressed: string
  original_match_count: number
  compressed_match_count: number
  files_affected: number
  compression_ratio: number
}

export function compressSearch(content: string, context?: string, config?: Partial<SearchCompressorConfig>): SearchCompressionResult {
  // 1. Parse: extract file:line:match triples
  //    Handle Windows paths: detect drive-letter prefix (C:\...) before scanning for line-number colon
  // 2. Score: boost matches containing context keywords, error keywords
  // 3. Select: per-file first/last, global cap via adaptive K (simplified for MVP)
  // 4. Format: reconstruct lines + summary lines
}
```

---

### Step 5 — DiffCompressor

**What.** Compress unified diffs.

**Key files.** `src/compress/diff-compressor.ts`.

**TS sketch:**

```ts
export interface DiffCompressorConfig {
  max_context_lines: number       // default 2
  max_hunks_per_file: number      // default 10
  max_files: number               // default 20
  always_keep_additions: boolean  // default true
  always_keep_deletions: boolean  // default true
}

export interface DiffCompressionResult {
  compressed: string
  original_line_count: number
  compressed_line_count: number
  files_affected: number
  additions: number
  deletions: number
  hunks_kept: number
  hunks_removed: number
  compression_ratio: number
}

export function compressDiff(content: string, config?: Partial<DiffCompressorConfig>): DiffCompressionResult {
  // 1. Parse: identify file headers (diff --git, --- a/, +++ b/), hunk headers (@@ -A,B +C,D @@), change lines (+/-)
  // 2. Recognize merge-commit headers (diff --combined, diff --cc, @@@ ... @@@)
  // 3. For each hunk: keep header + all +/- lines + max_context_lines context around each changed block
  // 4. Cap hunks per file and total files
  // 5. If dropped lines > 50: emit CCR marker (if CCR store available)
}
```

---

### Step 6 — SmartCrusher

**What.** Statistical JSON array compression. **Most complex component — this step requires the most design detail.**

**Key files.** `src/compress/smart-crusher.ts`.

**TS sketch:**

```ts
export interface SmartCrusherConfig {
  enabled: boolean                    // default true
  min_items_to_analyze: number       // default 5
  min_tokens_to_crush: number        // default 200
  max_items_after_crush: number      // default 15
  preserve_change_points: boolean    // default true
  first_fraction: number             // default 0.3  (fraction kept from start)
  last_fraction: number              // default 0.15 (fraction kept from end)
  dedup_identical_items: boolean     // default true
  enable_ccr_marker: boolean         // default true
}

export interface CrushResult {
  compressed: string
  original: string
  was_modified: boolean
  strategy: string  // "smart_crusher" | "passthrough"
  ccr_hash?: string
}

export function crushJsonArray(
  content: string,
  query?: string,
  config?: Partial<SmartCrusherConfig>,
): CrushResult {
  const cfg = { /* defaults merged with config */ }
  let items: Record<string, unknown>[]
  try {
    items = JSON.parse(content)
    if (!Array.isArray(items)) return passthrough(content)
    if (items.length < cfg.min_items_to_analyze) return passthrough(content)
  } catch {
    return passthrough(content)
  }

  const n = items.length

  // ─── Phase 1 MVP: simplified K = ceil(sqrt(n)) ─────────────────
  // Full Kneedle (Phase 3) replaces this with:
  //   - SimHash clustering for unique-count
  //   - Cumulative bigram-coverage curve
  //   - Knee-point detection via max deviation from diagonal
  //   - zlib ratio validation
  const k = Math.min(cfg.max_items_after_crush, Math.ceil(Math.sqrt(n)))

  // ─── Phase 1 MVP: simple first/last/bias selection ─────────────
  const firstCount = Math.floor(k * cfg.first_fraction)
  const lastCount = Math.floor(k * cfg.last_fraction)
  const first = items.slice(0, firstCount)
  const last = items.slice(-lastCount)
  const seen = new Set([...first, ...last])
  const firstLastLen = first.length + last.length

  // Fill remaining slots from the middle (simple: uniform sample)
  const remaining = Math.max(0, k - firstLastLen)
  const middle = items.slice(firstCount, n - lastCount)
  const step = Math.max(1, Math.floor(middle.length / Math.max(1, remaining)))
  const sampled: Record<string, unknown>[] = []
  for (let i = 0; i < middle.length && sampled.length < remaining; i += step) {
    if (!seen.has(middle[i])) {
      sampled.push(middle[i])
      seen.add(middle[i])
    }
  }

  const kept = [...first, ...sampled, ...last]
  // Sort by original index for stable output (reconstruct from seen-set membership)

  // ─── Phase 1 MVP: no relevance scoring or outlier detection ────

  if (kept.length >= n) return passthrough(content)

  const droppedCount = n - kept.length
  const ccrHash = cfg.enable_ccr_marker ? blake3Hex(content).slice(0, 24) : undefined
  const marker = ccrHash ? `\n{"_ccr_dropped": "<<ccr:${ccrHash} ${droppedCount}_rows_offloaded>>"}` : ""

  return {
    compressed: JSON.stringify(kept) + marker,
    original: content,
    was_modified: true,
    strategy: "smart_crusher",
    ccr_hash: ccrHash,
  }
}

function passthrough(content: string): CrushResult {
  return { compressed: content, original: content, was_modified: false, strategy: "passthrough" }
}
```

**Kneedle algorithm detail (Phase 3 full implementation):**

The Kneedle algorithm determines the optimal K adaptively by finding where information gain saturates:

1. **SimHash clustering** (`_simhash`): For each item string, compute a 64-bit SimHash fingerprint:
   - Split the item text into character 4-grams
   - For each 4-gram, compute MD5 → take first 16 hex chars (64 bits) as a `bigint`
   - Weighted voting: for each bit position (0–63), count how many 4-grams have that bit set. If count > 0, set the bit in the final fingerprint.
   - Group items by identical SimHash → number of unique groups = `unique_count`

2. **Bigram coverage curve**: Iterate items in order, computing bigrams (adjacent whitespace-split word pairs). Track the cumulative set of unique bigrams seen. Normalize both axes to [0,1]: `x_i = i/n`, `y_i = |unique_bigrams_seen_so_far| / |total_unique_bigrams|`.

3. **Knee detection**: `knee = argmax_i (x_i - y_i)`. The "knee" is where adding more items stops significantly increasing unique bigram coverage (the curve flattens). Return `null` if max deviation ≤ 0.05.

4. **Diversity ratio adjustment**: `diversity = unique_count / n`. If no knee found, keep fraction = `0.3 + 0.7 * diversity`. If knee found but diversity > 0.7, apply floor `max(knee, n * (0.3 + 0.7 * diversity))`.

5. **zlib validation**: Compress the kept-K subset and the full-N set via `Bun.deflateSync()`. If `compressed_ratio(kept) / compressed_ratio(full) < 0.85`, the kept subset is too redundant → bump K by 20%.

In TypeScript:
```ts
function computeOptimalK(items: string[], bias: number, minK: number, maxK: number): number {
  const n = items.length
  if (n <= 8) return n

  const uniqueCount = countUniqueSimhash(items, 3)
  if (uniqueCount <= 3) return Math.min(maxK, Math.max(minK, uniqueCount))

  const curve = computeUniqueBigramCurve(items)
  let knee = findKnee(curve)

  const diversityRatio = uniqueCount / n
  if (knee === null) {
    knee = Math.max(minK, Math.floor(n * (0.3 + 0.7 * diversityRatio)))
  } else if (diversityRatio > 0.7) {
    const floor = Math.max(minK, Math.floor(n * (0.3 + 0.7 * diversityRatio)))
    knee = Math.max(knee, floor)
  }

  let k = Math.max(minK, Math.floor(knee * bias))
  k = Math.min(maxK, k)

  // zlib validation
  k = validateWithZlib(items, k, maxK, 0.15)
  return k
}
```

**Why this step comes after Steps 2–5.** SmartCrusher is the most complex compressor. Building the simpler compressors first establishes patterns and testing infrastructure. The simplified MVP (K=√n) is implemented here; full Kneedle arrives in Phase 3.

---

### Step 7 — CacheAligner

**What.** Detect volatile content in system prompts — never mutate.

**Key files.** `src/compress/cache-aligner.ts`.

**TS sketch:**

```ts
export interface VolatileFinding {
  label: "uuid" | "iso8601" | "jwt" | "hex_hash"
  sample: string  // truncated
}

export function detectVolatileContent(text: string): VolatileFinding[] {
  if (!text) return []
  const tokens = text.split(/\s+/).map((t) => t.replace(/^[.,;:!?"'()[\]{}<>]+|[.,;:!?"'()[\]{}<>]+$/g, ""))
  const findings: VolatileFinding[] = []
  for (const token of tokens) {
    if (isUUID(token)) {
      findings.push({ label: "uuid", sample: truncate(token) })
    } else if (isJWT(token)) {
      findings.push({ label: "jwt", sample: truncate(token) })
    } else if (isISO8601(token)) {
      findings.push({ label: "iso8601", sample: truncate(token) })
    } else if (isHexHash(token)) {
      findings.push({ label: "hex_hash", sample: truncate(token) })
    }
  }
  return findings
}

function isUUID(token: string): boolean {
  // Canonical 36-char with dashes: 8-4-4-4-12
  if (token.length !== 36 || token.split("-").length !== 5) return false
  try { crypto.randomUUID(); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token) } catch { return false }
}

function isISO8601(token: string): boolean {
  if (token.length < 8) return false
  if (!token.includes("T") && !token.includes("-")) return false
  const d = new Date(token.endsWith("Z") ? token : token + "Z")
  return !isNaN(d.getTime())
}

function isJWT(token: string): boolean {
  const parts = token.split(".")
  if (parts.length !== 3) return false
  return parts.every((p) => {
    if (p.length < 4) return false
    try { Buffer.from(p, "base64url"); return true } catch { return false }
  })
}

function isHexHash(token: string): boolean {
  const validLengths = new Set([32, 40, 64])
  return validLengths.has(token.length) && /^[0-9a-f]+$/i.test(token)
}
```

**Why this step comes after compressors.** CacheAligner is a standalone detector — no dependency on other compressors. Its position here is a natural grouping: all `src/compress/` modules are built before the pipeline.

---

### Step 8 — TransformPipeline

**What.** Orchestrate: CacheAligner → ContentDetector → dispatch to compressor. Fail-open semantics.

**Key files.** `src/compress/pipeline.ts`.

**TS sketch:**

```ts
import { detectContentType, ContentType } from "./content-detector"
import { compressLog } from "./log-compressor"
import { compressSearch } from "./search-compressor"
import { compressDiff } from "./diff-compressor"
import { crushJsonArray } from "./smart-crusher"
import { detectVolatileContent } from "./cache-aligner"
import { countTokens } from "../util/tokens"

export interface PipelineConfig {
  min_chars_for_compression: number       // default 500
  min_tokens_to_crush: number             // default 200
  enable_smart_crusher: boolean           // default true
  enable_search_compressor: boolean        // default true
  enable_log_compressor: boolean           // default true
  enable_diff_compressor: boolean          // default true
  enable_cache_aligner: boolean            // default true
  ccr_enabled: boolean                     // default true
}

export interface PipelineResult {
  messages: unknown[]
  tokens_before: number
  tokens_after: number
  tokens_saved: number
  compression_ratio: number
  transforms_applied: string[]
  ccr_hashes: string[]
  warnings: string[]
}

/**
 * Apply compression to opencode messages in the live zone.
 *
 * Invariants:
 * - **Fail-open**: any compression failure → revert to original for that block
 * - **Token-monotone**: if tokens(compressed) >= tokens(original) → revert
 * - **Live-zone only**: skip system messages, skip frozen (cached) prefix
 */
export function compressMessages(
  messages: { info: { role: string; content?: string | unknown[] }; parts: { type: string; text?: string }[] }[],
  config?: Partial<PipelineConfig>,
): PipelineResult {
  const cfg = { /* defaults */ }
  const warnings: string[] = []
  const transforms_applied: string[] = []
  const ccr_hashes: string[] = []

  const tokensBefore = countTokens(serializeMessages(messages))

  for (const msg of messages) {
    // CacheAligner: detect volatile content in system prompts
    if (cfg.enable_cache_aligner && msg.info.role === "system") {
      const systemText = typeof msg.info.content === "string" ? msg.info.content : ""
      const findings = detectVolatileContent(systemText)
      if (findings.length > 0) {
        const counts = /* aggregate by label */
        warnings.push(`CacheAligner: detected volatile content in system prompt (${counts}); cache prefix unstable.`)
      }
      continue  // Never mutate system messages (invariant I2)
    }

    // Compress tool result / assistant text blocks
    for (const part of msg.parts ?? []) {
      if (part.type !== "text" || !part.text) continue
      const text = part.text as string
      if (text.length < cfg.min_chars_for_compression) continue

      const tokensOriginal = countTokens(text)
      if (tokensOriginal < cfg.min_tokens_to_crush) continue

      let compressed: string | null = null
      let strategy = ""

      try {
        const detection = detectContentType(text)

        switch (detection.content_type) {
          case ContentType.JsonArray:
            if (cfg.enable_smart_crusher) {
              const result = crushJsonArray(text)
              if (result.was_modified) {
                compressed = result.compressed
                strategy = "smart_crusher"
                if (result.ccr_hash) ccr_hashes.push(result.ccr_hash)
              }
            }
            break
          case ContentType.SearchResults:
            if (cfg.enable_search_compressor) {
              const result = compressSearch(text)
              compressed = result.compressed
              strategy = "search"
            }
            break
          case ContentType.BuildOutput:
            if (cfg.enable_log_compressor) {
              const result = compressLog(text)
              compressed = result.compressed
              strategy = "log"
            }
            break
          case ContentType.GitDiff:
            if (cfg.enable_diff_compressor) {
              const result = compressDiff(text)
              compressed = result.compressed
              strategy = "diff"
            }
            break
          default:
            // PlainText and Html → passthrough for MVP
            break
        }
      } catch (err) {
        // Fail-open: revert to original on any error
        compressed = null
      }

      // Token-monotone validation
      if (compressed !== null) {
        const tokensCompressed = countTokens(compressed)
        if (tokensCompressed >= tokensOriginal) {
          compressed = null  // Revert — compression didn't help
        } else {
          transforms_applied.push(strategy)
          part.text = compressed
        }
      }
    }
  }

  const tokensAfter = countTokens(serializeMessages(messages))

  return {
    messages,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    tokens_saved: tokensBefore - tokensAfter,
    compression_ratio: tokensBefore > 0 ? tokensAfter / tokensBefore : 1,
    transforms_applied,
    ccr_hashes,
    warnings,
  }
}
```

**Why this step comes before Step 9.** Pipeline wires everything together. The CCR store (Step 9) is referenced by the pipeline but is a separate concern.

---

### Step 9 — CCR Store

**What.** SQLite-backed Compress-Cache-Retrieve store via `bun:sqlite`.

**Key files.** `src/ccr/store.ts`.

**TS sketch:**

```ts
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

export class CcrStore {
  private db: Database
  private putStmt: ReturnType<Database["prepare"]>
  private getStmt: ReturnType<Database["prepare"]>
  private purgeStmt: ReturnType<Database["prepare"]>

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath)
    this.db.run("PRAGMA journal_mode=WAL")
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ccr_entries (
        hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
    this.putStmt = this.db.prepare("INSERT OR REPLACE INTO ccr_entries (hash, payload) VALUES (?, ?)")
    this.getStmt = this.db.prepare("SELECT payload FROM ccr_entries WHERE hash = ? AND created_at > unixepoch() - 300")
    this.purgeStmt = this.db.prepare("DELETE FROM ccr_entries WHERE created_at < unixepoch() - 300")
  }

  put(payload: string): string {
    const hash = computeCcrKey(payload)
    this.putStmt.run(hash, payload)
    this.purgeStmt.run()  // Lazy purge on every write
    return hash
  }

  get(hash: string): string | null {
    const row = this.getStmt.get(hash) as { payload: string } | undefined
    return row?.payload ?? null
  }

  ccrMarker(hash: string): string {
    return `<<ccr:${hash}>>`
  }
}

export function computeCcrKey(payload: string): string {
  // BLAKE3 → first 24 hex chars (96-bit, collision-resistant for bounded LRU)
  // Node.js has no native BLAKE3; use SHA-256 as acceptable substitute for plugin
  return createHash("sha256").update(payload).digest("hex").slice(0, 24)
}

export function extractCcrHashes(text: string): string[] {
  // Extract all <<ccr:HASH>> hashes from text via substring scan (no regex)
  const hashes: string[] = []
  const prefix = "<<ccr:"
  let idx = 0
  while (true) {
    const start = text.indexOf(prefix, idx)
    if (start === -1) break
    let cursor = start + prefix.length
    while (cursor < text.length && /[0-9a-fA-F]/.test(text[cursor])) cursor++
    const hash = text.slice(start + prefix.length, cursor)
    if (hash.length >= 12) hashes.push(hash.toLowerCase())
    idx = cursor
  }
  return [...new Set(hashes)]
}
```

**Note on BLAKE3:** Node.js/Bun doesn't ship BLAKE3 natively. For the plugin, SHA-256 truncated to 24 hex chars is an acceptable substitute. The original headroom uses BLAKE3 for speed; SHA-256 is fast enough for the plugin's CCR store volume (≤1000 entries, 5-min TTL). If parity is critical, add `blake3` npm package in Phase 2b.

**Why this step comes after Pipeline.** The pipeline references the CCR store interface, but the store itself is an independent module. Built after pipeline to keep the build incremental.

---

### Step 10 — Token Counter

**What.** Wrapper around `js-tiktoken` for token-monotone validation.

**Key files.** `src/util/tokens.ts`.

**TS sketch:**

```ts
import { encoding_for_model, type TiktokenModel } from "js-tiktoken"

let _enc: ReturnType<typeof encoding_for_model> | null = null

export function getEncoder(model: TiktokenModel = "gpt-4o") {
  if (!_enc) _enc = encoding_for_model(model)
  return _enc
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length
}

export function countMessageTokens(messages: unknown[]): number {
  // Rough estimate: serialize and count. For production, use
  // opencode's internal token counter if exposed, otherwise tiktoken.
  const serialized = JSON.stringify(messages)
  return countTokens(serialized)
}
```

---

### Step 11 — `headroom_retrieve` Tool

**What.** Expose the CCR retrieval tool to the LLM.

**Key files.** `src/tool/retrieve.ts`.

**TS sketch:**

```ts
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import type { CcrStore } from "../ccr/store"

export function createRetrieveTool(ccrStore: CcrStore) {
  return tool({
    description: "Retrieve original content for a CCR hash produced by headroom compression. " +
      "Use this when a compressed tool output has a <<ccr:HASH>> marker and you need the full original.",
    args: {
      hash: z.string().describe("24-character hex hash from a <<ccr:HASH>> marker"),
    },
    async execute(args, ctx) {
      const original = ccrStore.get(args.hash)
      if (!original) {
        return { title: `CCR Retrieve: ${args.hash.slice(0, 8)}...`, output: `No stored content found for hash ${args.hash}. The entry may have expired (5-minute TTL).` }
      }
      return {
        title: `CCR Retrieve: ${args.hash.slice(0, 8)}... (${original.length} chars)`,
        output: original,
        metadata: { hash: args.hash, size: original.length },
      }
    },
  })
}
```

---

### Step 12 — Plugin Entry Point

**What.** Wire all hooks into the `Plugin` function.

**Key files.** `src/index.ts`.

**TS sketch:**

```ts
import type { Plugin } from "@opencode-ai/plugin"
import { CcrStore } from "./ccr/store"
import { createRetrieveTool } from "./tool/retrieve"
import { compressMessages, type PipelineConfig } from "./compress/pipeline"
import { detectVolatileContent } from "./compress/cache-aligner"
import { parsePluginOptions } from "./config"

export const server: Plugin = async (input, options) => {
  const config = parsePluginOptions(options ?? {})
  const ccrStore = new CcrStore(config.ccr_db_path ?? ":memory:")

  return {
    tool: {
      headroom_retrieve: createRetrieveTool(ccrStore),
    },

    "experimental.chat.messages.transform": async (input, output) => {
      if (!config.enabled) return

      const result = compressMessages(output.messages as any, {
        min_chars_for_compression: config.min_chars_for_compression,
        enable_smart_crusher: config.enable_smart_crusher,
        enable_search_compressor: config.enable_search_compressor,
        enable_log_compressor: config.enable_log_compressor,
        enable_diff_compressor: config.enable_diff_compressor,
        enable_cache_aligner: config.enable_cache_aligner,
        ccr_enabled: config.ccr_enabled,
      })

      // Store CCR entries for any markers emitted
      for (const hash of result.ccr_hashes) {
        // The compressed text with the marker is already in output.messages;
        // we just need to ensure the CCR store has the originals.
        // (In the actual implementation, compressors call ccrStore.put()
        //  directly; this loop is a safety net.)
      }

      // Log warnings (CacheAligner detections, etc.)
      for (const warning of result.warnings) {
        console.warn(`[headroom] ${warning}`)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!config.enable_cache_aligner) return
      for (const line of output.system) {
        const findings = detectVolatileContent(line)
        if (findings.length > 0) {
          const counts = /* aggregate */
          console.warn(`[headroom] CacheAligner: volatile content in system prompt (${counts})`)
        }
      }
      // Never mutate output.system — invariant I2
    },
  }
}
```

---

### Step 13 — Configuration

**What.** Plugin options schema with Zod, sensible defaults.

**Key files.** `src/config.ts`.

**TS sketch:**

```ts
import { z } from "zod"

export const HeadroomOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  ccr_enabled: z.boolean().default(true),
  ccr_db_path: z.string().optional(),  // defaults to ":memory:"; use file path for persistence
  min_chars_for_compression: z.number().int().positive().default(500),
  min_tokens_to_crush: z.number().int().positive().default(200),
  enable_smart_crusher: z.boolean().default(true),
  enable_search_compressor: z.boolean().default(true),
  enable_log_compressor: z.boolean().default(true),
  enable_diff_compressor: z.boolean().default(true),
  enable_cache_aligner: z.boolean().default(true),
  enable_html_extractor: z.boolean().default(false),  // deferred
  enable_code_compressor: z.boolean().default(false),  // deferred
  first_fraction: z.number().min(0).max(1).default(0.3),
  last_fraction: z.number().min(0).max(1).default(0.15),
  max_items_after_crush: z.number().int().positive().default(15),
  max_errors: z.number().int().positive().default(10),
  max_warnings: z.number().int().positive().default(5),
  max_matches_per_file: z.number().int().positive().default(5),
  max_context_lines: z.number().int().nonnegative().default(2),
})

export type HeadroomOptions = z.infer<typeof HeadroomOptionsSchema>

export function parsePluginOptions(input: unknown): HeadroomOptions {
  return HeadroomOptionsSchema.parse(input ?? {})
}
```

---

### Step 14 — Testing

**What.** Unit tests for each compressor, parity tests against headroom fixtures, integration tests.

**Key files.** `src/test/` directory.

**TS sketch (`src/test/content-detector.test.ts`):**

```ts
import { describe, test, expect } from "bun:test"
import { detectContentType, ContentType } from "../compress/content-detector"

describe("ContentDetector", () => {
  test("detects JSON array of dicts", () => {
    const result = detectContentType('[{"id": 1, "name": "foo"}, {"id": 2, "name": "bar"}]')
    expect(result.content_type).toBe(ContentType.JsonArray)
    expect(result.confidence).toBe(1.0)
    expect(result.metadata.is_dict_array).toBe(true)
  })

  test("detects git diff", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,6 @@
 import { foo } from "./foo"
+import { bar } from "./bar"
 const x = 1`
    const result = detectContentType(diff)
    expect(result.content_type).toBe(ContentType.GitDiff)
    expect(result.confidence).toBeGreaterThanOrEqual(0.7)
  })

  test("detects search results", () => {
    const search = `src/a.ts:10:const x = 1
src/a.ts:20:const y = 2
src/b.ts:5:function main() {`
    const result = detectContentType(search)
    expect(result.content_type).toBe(ContentType.SearchResults)
  })

  test("detects build output", () => {
    const log = `ERROR: something failed
WARNING: something warns
npm ERR! code ENOENT
npm ERR! path /some/path`
    const result = detectContentType(log)
    expect(result.content_type).toBe(ContentType.BuildOutput)
  })

  test("falls back to plain text for prose", () => {
    const result = detectContentType("This is a plain English sentence with no special structure.")
    expect(result.content_type).toBe(ContentType.PlainText)
  })
})
```

---

## 5. Affected Files

| File | Purpose | Phase |
|---|---|---|
| `contrib/opencode-headroom/package.json` | Package manifest, dependencies (js-tiktoken, zod), exports | 1 |
| `contrib/opencode-headroom/tsconfig.json` | TypeScript config (extends @tsconfig/bun) | 1 |
| `contrib/opencode-headroom/src/index.ts` | Plugin entrypoint — wires all hooks | 1 |
| `contrib/opencode-headroom/src/config.ts` | Plugin options parsing (Zod) | 1 |
| `contrib/opencode-headroom/src/compress/types.ts` | Shared types: ContentType, DetectionResult, compressor interfaces | 1 |
| `contrib/opencode-headroom/src/compress/content-detector.ts` | Content type detection via regex cascade | 1 |
| `contrib/opencode-headroom/src/compress/log-compressor.ts` | Build/test/lint log compression | 1 |
| `contrib/opencode-headroom/src/compress/search-compressor.ts` | grep/ripgrep output compression | 1 |
| `contrib/opencode-headroom/src/compress/diff-compressor.ts` | Unified diff compression | 1 |
| `contrib/opencode-headroom/src/compress/smart-crusher.ts` | JSON array compression (simplified K=√n) | 1 |
| `contrib/opencode-headroom/src/compress/cache-aligner.ts` | Volatile content detection in system prompts | 1 |
| `contrib/opencode-headroom/src/compress/pipeline.ts` | TransformPipeline orchestrator (fail-open, token-monotone) | 1 |
| `contrib/opencode-headroom/src/util/tokens.ts` | Token counter (js-tiktoken wrapper) | 1 |
| `contrib/opencode-headroom/src/ccr/store.ts` | CCR SQLite store via bun:sqlite | 2 |
| `contrib/opencode-headroom/src/tool/retrieve.ts` | headroom_retrieve tool definition | 2 |
| `contrib/opencode-headroom/src/test/` | Unit tests, parity tests, property tests | 1–4 |
| `contrib/opencode-headroom/src/compress/kneedle.ts` | Full Kneedle algorithm (adaptive K) | 3 |
| `contrib/opencode-headroom/src/compress/relevance.ts` | BM25 relevance scoring | 3 |
| `contrib/opencode-headroom/src/compress/code-compressor.ts` | tree-sitter WASM code compression | 4 (deferred) |
| `contrib/opencode-headroom/src/compress/kompress-compressor.ts` | ML-based prose compression (ONNX) | 4 (deferred) |

---

## 6. Phase Plan

### Phase 1 — MVP: Core Compression (target: working `chat.messages.transform` hook)

- ContentDetector (all types except ML-based)
- LogCompressor, SearchCompressor, DiffCompressor
- SmartCrusher (simplified K = √n — no Kneedle, no relevance scoring)
- TransformPipeline (fail-open orchestration, live-zone identification, token-monotone validation)
- `experimental.chat.messages.transform` hook integration
- Token counter (js-tiktoken)
- CacheAligner (detection only — warnings, no mutation)
- Basic unit tests for each compressor

**Validation gate:** Run the plugin against a real opencode session with large tool outputs. Verify that tool output text blocks are visibly compressed and token counts drop. Confirm fail-open: error in any compressor → original content preserved.

### Phase 2 — Reversibility

- CCR store (SQLite via `bun:sqlite`)
- `headroom_retrieve` tool (registered via `tool` hook)
- CCR marker injection in all compressors
- CCR marker extraction and hash → original lookup
- Round-trip test: compress → retrieve → verify byte-equality

**Validation gate:** Run a session where SmartCrusher drops JSON rows. Verify the `<<ccr:HASH>>` marker appears in the compressed output. Call `headroom_retrieve(hash)` and verify the original JSON array is returned.

### Phase 3 — Full SmartCrusher

- Kneedle algorithm for adaptive K (port from `adaptive_sizer.rs`)
  - SimHash clustering for unique-count
  - Cumulative bigram-coverage curve
  - Knee-point detection (max deviation from diagonal)
  - Diversity ratio adjustment
  - zlib validation via `Bun.deflateSync()`
- BM25 relevance scoring (port from `headroom/relevance/`)
- Full outlier detection (z-score based anomaly flagging)
- CacheAligner optional normalization mode (UUID → placeholder, timestamp → placeholder — opt-in, violates I2 by default)

**Validation gate:** Run the SmartCrusher on the 17 recorded fixtures from `tests/parity/fixtures/smart_crusher/`. Verify compressed output matches the reference Python/Rust output (within token-count tolerance).

### Phase 4 — Advanced (deferred)

- CodeCompressor: tree-sitter WASM integration for AST-aware code compression
- KompressCompressor: ONNX model integration (`chopratejas/kompress-base`) for ML-based prose compression
- HierarchicalMemory: cross-agent SQLite + HNSW vector store
- `headroom learn` port: TOIN (Tool Output Intelligence Network) pattern learning
- Observability: OTel metrics export (strategy counts, token savings, timing)
- `tool.execute.after` hook integration: per-tool-output inline compression
- `headroom_stats` tool: expose compression statistics to the agent

---

## 7. Potential Challenges

| Problem | Resolution |
|---|---|
| **Token counting accuracy**: js-tiktoken counts may differ from opencode's internal token counter (which may use Anthropic's tokenizer for Claude models) | Use `js-tiktoken` for `cl100k_base` (OpenAI) as a cross-model approximation. The token-monotone invariant only requires relative comparison, not absolute accuracy. If opencode exposes an internal `countTokens()` API, prefer that. |
| **bun:sqlite WAL mode + concurrent sessions**: If two opencode sessions share the same CCR DB file, WAL-mode writes may conflict | Use `:memory:` database by default (per-plugin-instance, not shared). For persistent CCR, use session-ID-scoped DB files: `ccr_${sessionID}.sqlite`. Document the concurrency model. |
| **Live-zone identification**: opencode's internal message format (`Message` + `Part[]`) differs from headroom's OpenAI/Anthropic format. The frozen/live boundary must be identified correctly. | Study opencode's message structure in the `experimental.chat.messages.transform` hook. The most recent user message + any tool results after it = live zone. System messages and earlier assistant/user messages = frozen. Add defensive logging during Phase 1 to verify zone detection. |
| **SmartCrusher Kneedle → TypeScript**: The Rust implementation uses MD5, zlib (flate2), and mathematical operations that must be byte-exact for parity tests | Use `node:crypto` for MD5, `Bun.deflateSync()` for zlib. Accept small numeric drift in floating-point knee computation; test against the 17 recorded fixtures with `expect.closeTo()` tolerance. |
| **Fail-open in async TypeScript**: A compressor-thrown exception must be caught per-block, not crash the entire hook | Wrap each `compressXxx()` call in try/catch at the pipeline level. On catch, log the error and use the original content. The `experimental.chat.messages.transform` hook is `Promise<void>` — errors bubble to opencode's hook runner and should be handled gracefully. |
| **Plugin hook ordering**: What if another plugin also mutates `chat.messages.transform` output? | opencode runs hooks in registration order. Headroom should run **last** (after other plugins have added their content). Document the recommended position: put headroom as the last entry in the `plugin` array in `opencode.json`. Alternatively, use `tool.execute.after` for per-tool compression (earlier in the pipeline). |
| **CCR marker parsing**: The `<<ccr:HASH>>` marker grammar is fixed but must be extracted from arbitrary text including JSON strings | Use the substring-scan approach (no regex) from the Rust reference (`_collect_ccr_hashes_from_string`). Walk parsed JSON trees for CCR markers in string values. Fall back to token-scan for non-JSON text. |
| **SHA-256 vs BLAKE3**: Node.js has no native BLAKE3; SHA-256 is slower | For the plugin's CCR volume (≤1000 entries, 5-min TTL), SHA-256 is fast enough (~5µs per hash). If parity with the reference is required, add the `blake3` npm package (WASM-based) in Phase 2b. |
| **Large message arrays**: The `experimental.chat.messages.transform` hook receives the full message history; scanning all messages every turn is O(N) | Live-zone-only scanning bounds the work. Skip frozen (prefix-cached) messages. Cache ContentDetector results by content hash for repeated outputs (e.g., the same tool invoked twice). |

---

## 8. Testing Plan

### 8.1 Unit Tests (`bun test`)

| Test | File |
|---|---|
| `detectContentType` JSON array of dicts → `JsonArray`, confidence 1.0 | `src/test/content-detector.test.ts` |
| `detectContentType` JSON array of primitives → `JsonArray`, confidence 0.8 | `src/test/content-detector.test.ts` |
| `detectContentType` unified diff → `GitDiff`, confidence ≥ 0.7 | `src/test/content-detector.test.ts` |
| `detectContentType` merge-commit diff (`diff --cc`, `@@@`) → `GitDiff` | `src/test/content-detector.test.ts` |
| `detectContentType` ripgrep output → `SearchResults`, confidence ≥ 0.6 | `src/test/content-detector.test.ts` |
| `detectContentType` build log with ERROR/WARN → `BuildOutput`, confidence ≥ 0.5 | `src/test/content-detector.test.ts` |
| `detectContentType` Python source code → `SourceCode`, language=python | `src/test/content-detector.test.ts` |
| `detectContentType` plain prose → `PlainText` | `src/test/content-detector.test.ts` |
| `compressLog` deduplicates repeated warnings (conservative dedupe) | `src/test/log-compressor.test.ts` |
| `compressLog` keeps first/last errors | `src/test/log-compressor.test.ts` |
| `compressLog` preserves stack traces | `src/test/log-compressor.test.ts` |
| `compressLog` respects `max_total_lines` cap | `src/test/log-compressor.test.ts` |
| `compressSearch` keeps first/last match per file | `src/test/search-compressor.test.ts` |
| `compressSearch` respects `max_total_matches` and `max_files` caps | `src/test/search-compressor.test.ts` |
| `compressSearch` handles Windows paths (C:\Users\...) | `src/test/search-compressor.test.ts` |
| `compressSearch` handles filenames with dashes | `src/test/search-compressor.test.ts` |
| `compressDiff` drops context lines, keeps additions/deletions | `src/test/diff-compressor.test.ts` |
| `compressDiff` handles merge-commit headers | `src/test/diff-compressor.test.ts` |
| `compressDiff` respects `max_hunks_per_file` cap | `src/test/diff-compressor.test.ts` |
| `crushJsonArray` reduces large array (simplified K=√n) | `src/test/smart-crusher.test.ts` |
| `crushJsonArray` passthrough for small arrays (< `min_items_to_analyze`) | `src/test/smart-crusher.test.ts` |
| `crushJsonArray` emits `<<ccr:HASH>>` marker when rows dropped | `src/test/smart-crusher.test.ts` |
| `detectVolatileContent` finds UUIDs, timestamps, JWTs, hex hashes | `src/test/cache-aligner.test.ts` |
| `detectVolatileContent` returns empty for stable content | `src/test/cache-aligner.test.ts` |
| `countTokens` returns consistent results for same text | `src/test/tokens.test.ts` |
| `CcrStore.put` + `CcrStore.get` round-trip | `src/test/ccr-store.test.ts` |
| `CcrStore.get` returns null for expired entry | `src/test/ccr-store.test.ts` |
| `extractCcrHashes` finds all `<<ccr:HASH>>` markers in text | `src/test/ccr-store.test.ts` |
| `parsePluginOptions` with defaults and overrides | `src/test/config.test.ts` |

### 8.2 Parity Tests (Phase 3)

Run SmartCrusher against headroom's 17 recorded fixtures (`tests/parity/fixtures/smart_crusher/`). For each fixture:
1. Load the input JSON array.
2. Run `crushJsonArray()` with the reference config.
3. Compare compressed output to the expected output.
4. Accept tolerance: item count within ±1, byte-level diff for JSON normalization within 5%.

### 8.3 Property Tests

- **Token-monotone**: for any input, `countTokens(compressed) ≤ countTokens(original)`. Generate random tool outputs across all content types, compress, verify.
- **Fail-open**: inject errors into each compressor (e.g., pass malformed JSON to SmartCrusher). Verify the pipeline returns the original content, not an error.
- **CCR round-trip**: compress with CCR enabled → extract hash from output → retrieve → verify `get(hash) === original`.
- **Idempotency**: applying compression twice yields the same output as applying once (compressed content should pass through the second time since it's below the size threshold or already minimal).

### 8.4 Integration Test

1. Create a mock opencode session with large tool outputs (JSON arrays of 100 items, grep output of 500 lines, build log of 200 lines).
2. Load the plugin with `experimental.chat.messages.transform` hook.
3. Verify `output.messages` has compressed content blocks.
4. Verify `tokens_before > tokens_after`.
5. Verify no crash, no data loss.

---

## 9. Open Questions

| # | Question | Recommendation |
|---|---|---|
| **OQ-1** | Does the `experimental.chat.messages.transform` hook receive the full message array including frozen (cached) messages, or only pending messages? | Study the hook implementation in `packages/opencode/src/` before Phase 1. The hook's `output.messages` likely includes all messages. Identify frozen boundary by role: system = frozen, intermediate assistant = frozen, most recent user + tool results after it = live. If opencode doesn't expose a `frozen_message_count`, infer it heuristically. |
| **OQ-2** | What message format does opencode use internally — `Message` + `Part[]`? Does each tool result have a `text` part or a different structure? | Inspect the `Message` and `Part` types in `@opencode-ai/sdk`. The `experimental.chat.messages.transform` hook passes `{ info: Message, parts: Part[] }[]`. Tool results likely appear as `Part` objects with `type: "tool_result"` or similar. Read the SDK types before implementing the pipeline message walker. |
| **OQ-3** | Is `bun:sqlite` available in plugin context? The plugin runs inside opencode's Bun process — does it have access to `bun:sqlite`? | Bun plugins have access to all Bun APIs including `bun:sqlite`. If not, fall back to an in-memory `Map` with TTL-based eviction (simpler, but not persistent across sessions). Test during Phase 1 scaffolding. |
| **OQ-4** | Should the plugin expose a `headroom_stats` tool (like headroom's `headroom_stats` endpoint)? | Yes — useful for agent self-awareness. Add in Phase 2 or 3 as a simple stats tool that reports: tokens saved total, compression ratio, strategies used, CCR entries active. |
| **OQ-5** | Should CacheAligner run on every request or only on first message? | Every request, but only on the system prompt (which is typically static). Detection is cheap (O(n) token scan). Running every request catches cases where a plugin or dynamic context injection modifies the system prompt between turns. |
| **OQ-6** | Token counter: `js-tiktoken` vs `@dqbd/tiktoken` — which is lighter-weight in Bun? | `js-tiktoken` is a pure-JS port that works in any runtime. `@dqbd/tiktoken` has native bindings. For Bun, `js-tiktoken` is the safer choice (no native compilation). Both use the same BPE ranks. |
| **OQ-7** | Should the plugin use `tool.execute.after` for per-tool-output compression (streaming) in addition to batch `chat.messages.transform`? | Yes — as an optional optimization in Phase 4. `tool.execute.after` compresses a single tool result immediately, reducing memory and CPU for the later full-message-scan. However, it may miss cross-message compression opportunities (e.g., multiple grep outputs that could be merged). Start with batch mode (Phase 1), add streaming as an opt-in Phase 4 feature. |
| **OQ-8** | What is the exact structure of opencode's `Message` type? Specifically, how are tool results represented: `role: "tool"` with string content, or Anthropic-style `content: [{ type: "tool_result", content: "..." }]`? | Inspect `@opencode-ai/sdk` exports. The `Part` type likely has discriminated union members like `{ type: "tool_result"; tool_use_id: string; content: string }` (Anthropic style) or `{ type: "text"; text: string }`. The pipeline must handle both. Key question for Phase 1 implementation: read the SDK types before writing the message walker. |

---

*Implementation file: contrib/opencode-headroom/ | Last updated: 2026-06-09*
