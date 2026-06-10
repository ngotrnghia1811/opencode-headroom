# opencode-headroom — Compression Algorithms Reference

> **Version:** 0.1.3 · **Last updated:** 2026-06-10
>
> Deep-dive technical reference for every compression algorithm in the
> `opencode-headroom` plugin. This document describes the exact behaviour,
> formulas, and invariants of each compressor — readable by an engineer who
> wants to understand the code without reading all of it.

---

## Table of Contents

1. [ContentDetector](#1-contentdetector) — 7-type cascade with confidence formulas
2. [SmartCrusher](#2-smartcrusher) — JSON array compression with structural outlier preservation
3. [Kneedle](#3-kneedle) — Adaptive sizing (SimHash, bigram curve, knee detection, zlib)
4. [Relevance](#4-relevance) — BM25 scoring and hybrid embedding scorer
5. [LogCompressor](#5-logcompressor) — 5-stage log compression pipeline
6. [SearchCompressor](#6-searchcompressor) — grep/ripgrep output compression
7. [DiffCompressor](#7-diffcompressor) — Structured diff parser and hunk compression
8. [KompressCompressor](#8-kompresscompressor) — ONNX-based ML prose compression
9. [Embedding](#9-embedding) — BGE-small model loading and vector operations
10. [Outliers](#10-outliers) — Rare-field and rare-status detection
11. [CacheAligner](#11-cachealigner) — System prompt normalization patterns
12. [CompressionCache](#12-compressioncache) — Two-tier caching with TTL
13. [MixedContent](#13-mixedcontent) — Mixed-type detection and section splitting
14. [Pipeline](#14-pipeline) — Main orchestration layer (hooks, dispatch, token-monotone, fail-open)
15. [CCR Store](#15-ccr-store) — SQLite-backed content retrieval store

---

## Architecture Overview

```
Tool output text
       │
       ▼
┌──────────────────────┐
│  ContentDetector     │  7-type cascade: JSON → Diff → HTML → Search → Log → Code → Prose
│  (content-detector)  │  Returns DetectionResult { content_type, confidence, metadata }
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  MixedContent        │  Detects 2+ content types → splits into typed sections
│  (mixed-content)     │  Each section compressed independently by its type-specific compressor
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  Pipeline            │  Orchestration: cache check → mixed-content split → dispatch → token guard
│  (pipeline)          │  Dispatches to: SmartCrusher / LogCompressor / SearchCompressor / DiffCompressor / Kompress
└──────────────────────┘
         │
    ┌────┴────┬──────────┬──────────┬──────────┐
    ▼         ▼          ▼          ▼          ▼
SmartCrusher LogComp   SearchComp DiffComp   Kompress
(Kneedle    (5-stage)  (grep/rip) (hunk)    (ONNX ML)
+BM25+Outl)
```

**Invariants maintained by the Pipeline (not individual compressors):**

1. **Token-monotone:** compressed output MUST have strictly fewer tokens than input. If not, the original is returned unmodified (`passthrough_revert`).
2. **Fail-open:** any exception inside a compressor → original content returned (`passthrough_error`). The LLM never sees a crash.
3. **CCR reversibility:** when content is compressed, the original is stored in the CCR store keyed by a SHA-256 hash. The compressed output includes a `<<ccr:HASH>>` marker so the LLM can retrieve the full content via the `headroom_retrieve` tool.
4. **Two-tier cache:** known-noncompressible hashes skip instantly (Tier 1). Previously-compressed results return cached output (Tier 2).

---

## 1. ContentDetector

**Source:** `src/compress/content-detector.ts:1-258`

### Overview

ContentDetector classifies a text block into one of 7 types using a cascade of
rule-based detectors. Each detector computes a confidence score (0.0–1.0). The
pipeline dispatches the result to the type-specific compressor for that
content type. PlainText is a terminal type — no compression is attempted.

The cascade order is fixed: **JSON → Diff → HTML → Search → Log → Code → Prose → PlainText**.
The first detector that exceeds its confidence threshold wins (greedy, deterministic).

### Headroom Reference

- `headroom-core/src/transforms/content_detector.rs:1-367` — Rust implementation of the 7-type cascade
- `headroom/transforms/content_detector.py:1-288` — Python fallback with identical logic

### Algorithm

**Step 1: Guard — empty/whitespace input**

```
if content.trim() === "":
    return { content_type: PlainText, confidence: 0, metadata: {} }
```

**Step 2: JSON detection (tryDetectJson, line 72)**

```
parse JSON.parse(content)
if parsed is Array and all elements are plain objects:
    confidence = 1.0, is_dict_array = true
else if parsed is Array:
    confidence = 0.8, is_dict_array = false
otherwise: return null (not detected)
```

Threshold: any confidence > 0 → accept. This is the only detector with no
minimum confidence threshold — if the text parses as a JSON array, it is
always classified as JSON.

The `is_dict_array` metadata flag distinguishes homogeneous object arrays
(most tool outputs) from heterogeneous arrays of primitives. Both are
routed to SmartCrusher.

**Step 3: Diff detection (tryDetectDiff, line 87)**

```
lines = content.split("\n").slice(0, 500)
for each line:
    if DIFF_HEADER_RE.test(line):  headerMatches++
    // header patterns: diff --git, --- / +++ /, index <sha>..<sha>, @@ hunk header, @@@ three-way merge
    if DIFF_CHANGE_RE.test(line):  changeMatches++
    // change patterns: + or - prefix (excluding +++, --- )

if headerMatches == 0: return null

confidence = min(1.0, 0.5 + headerMatches × 0.2 + changeMatches × 0.05)
```

Threshold: confidence ≥ 0.7. The formula rewards diff header line count
more heavily (0.2 each) than change lines (0.05 each) because headers are
the structural signal while change lines can appear in non-diff contexts
(console output with `+`/`-` prefixes).

**Step 4: HTML detection (tryDetectHtml, line 104)**

```
sample = content.slice(0, 3000)
hasDoctype = /<!doctype\s+html/i.test(sample)     → +0.5
hasHtmlTag = /<html[\s>]/i.test(sample)            → +0.3
hasHead    = /<head[\s>]/i.test(sample)            → +0.1
hasBody    = /<body[\s>]/i.test(sample)            → +0.1
structuralMatches = count(tags: div, span, script, style, link, meta, nav, header, footer, aside, article, section, main) → +min(0.3, count × 0.03)

if hasDoctype == false and hasHtmlTag == false and structuralMatches < 3: return null
if confidence < 0.5: return null
```

Confidence formula:

$$c = \min(1.0, \; 0.5 \cdot \mathbb{1}_{\text{doctype}} + 0.3 \cdot \mathbb{1}_{\text{html}} + 0.1 \cdot \mathbb{1}_{\text{head}} + 0.1 \cdot \mathbb{1}_{\text{body}} + \min(0.3, \, s \cdot 0.03))$$

where $s$ is the count of structural tag matches.

Threshold: ≥ 0.7.

**Step 5: Search results detection (tryDetectSearch, line 131)**

```
lines = content.split("\n").slice(0, 100)
matchingLines = count(lines where /^[^\s:]+:\d+:/ matches)  // e.g. "src/foo.ts:42:"
ratio = matchingLines / nonEmptyLines

if matchingLines == 0 or ratio < 0.3: return null

confidence = min(1.0, 0.4 + ratio × 0.6)
```

Threshold: ≥ 0.6. The regex matches `filepath:lineNumber:` patterns
characteristic of grep and ripgrep output.

**Step 6: Log / build output detection (tryDetectLog, line 152)**

```
lines = content.split("\n").slice(0, 200)
for each line:
    test 11 patterns in LOG_PATTERNS:
        group 0: ERROR|FAIL|FAILED|FATAL|CRITICAL → error (dedupe-weighted)
        group 1: WARN|WARNING → warning
        group 2: INFO|DEBUG|TRACE → info
        group 3 (structural): timestamps, [HH:MM:SS], ===/--- separators,
               PASSED/FAILED/SKIPPED, npm ERR!, traceback headers

if patternMatches == 0 or ratio < 0.1: return null

confidence = min(1.0, 0.3 + ratio × 0.5 + errorMatches × 0.05)
```

Threshold: ≥ 0.5. The 11 patterns are defined at lines 17-28:

| Index | Pattern | Group | Purpose |
|-------|---------|-------|---------|
| 0 | `\b(ERROR\|FAIL\|FAILED\|FATAL\|CRITICAL)\b` | 0 | Error-level keywords |
| 1 | `\b(WARN\|WARNING)\b` | 1 | Warning-level keywords |
| 2 | `\b(INFO\|DEBUG\|TRACE)\b` | 2 | Info/debug keywords |
| 3 | `^\s*\d{4}-\d{2}-\d{2}` | 3 | ISO-ish timestamps |
| 4 | `^\s*\[\d{2}:\d{2}:\d{2}\]` | 3 | Bracket timestamps |
| 5 | `^={3,}\|^-{3,}` | 3 | Separator lines |
| 6 | `^\s*PASSED\|^\s*FAILED\|^\s*SKIPPED` | 3 | Test result lines |
| 7 | `^npm ERR!\|^yarn error\|^cargo error` | 3 | Package manager errors |
| 8 | `Traceback \(most recent call last\)` | 3 | Python traceback | 
| 9 | `^\w*(Error\|Exception):` | 3 | Language exception headers |
| 10 | `^\s*at\s+[\w.$]+\(` | 3 | JS/V8 stack frames |

**Step 7: Code detection (tryDetectCode, line 182)**

```
lines = content.split("\n").slice(0, 100)
for each line, for each language:
    test language-specific patterns:
        python:  def|class|import|from|async def, @\w+, """, if __name__
        js/ts:   function|const|let|var|class|import|export, async function, =>
                  interface|type|enum|namespace, : (string|number|boolean|any|void)
        go:      func|type|package|import, func \(...\) \w+
        rust:    fn|struct|enum|impl|mod|use|pub, #\[
        java:    public|private|protected (class|interface|enum), @\w+, package ... ;

bestLang = highest pattern match count

if bestScore < 3: return null

ratio = bestScore / nonEmptyLines
confidence = min(1.0, 0.4 + ratio × 0.4 + bestScore × 0.02)
```

Threshold: ≥ 0.5. Language is returned in metadata under `language` key.

**Step 8: Prose detection (tryDetectProse, line 223)**

```
estimatedSentences = count(/\.\?\s+[A-Z]/g matches) + 1
if estimatedSentences < 2: return null

proseLines = count(lines where /^[A-Z]/ and contains " " and not code-like)
proseRatio = proseLines / totalLines
if proseRatio < 0.5: return null

confidence = min(0.9, 0.5 + proseRatio × 0.4)
```

Prose is the fallback before PlainText. It requires:
- At least 2 sentence boundaries (period/exclamation/question followed by space + capital)
- At least 50% of lines look like natural language (start with capital, contain spaces, don't start with code keywords)

**Step 9: Terminal fallback (line 67)**

```
return { content_type: PlainText, confidence: 0.5, metadata: {} }
```

If no detector returns a result above its threshold, the content is PlainText.
The pipeline does not attempt compression on PlainText.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| Confidence thresholds per type | JSON: none, Diff: 0.7, HTML: 0.7, Search: 0.6, Log: 0.5, Code: 0.5, Prose: implicit via return-null | `number` | **No — code constants** (individual `if` guards) | Minimum confidence for each detector to accept |
| Diff header coefficient | 0.2 | `number` | **No — code constant** | Weight per diff header line in confidence formula |
| Diff change coefficient | 0.05 | `number` | **No — code constant** | Weight per `+`/`-` change line |
| HTML structural tag list | div, span, script, style, link, meta, nav, header, footer, aside, article, section, main | `string[]` | **No — code constant** | Tags counted by HTML_STRUCTURAL_RE |
| HTML structural coefficient | 0.03 | `number` | **No — code constant** | Per-tag confidence contribution |
| Min structural tags for HTML | 3 | `number` | **No — code constant** | Minimum structural tags when no doctype/html tag |
| Search ratio threshold | 0.3 | `number` | **No — code constant** | Min fraction of lines matching search pattern |
| Log ratio threshold | 0.1 | `number` | **No — code constant** | Min fraction of lines matching log patterns |
| Code min best-score | 3 | `number` | **No — code constant** | Minimum pattern matches for best language |
| Prose min sentence count | 2 | `number` | **No — code constant** | Minimum sentence boundaries for prose detection |
| Prose min line ratio | 0.5 | `number` | **No — code constant** | Minimum fraction of prose-like lines |
| Sample window sizes | Diff: 500, HTML: 3000 chars, Search: 100, Log: 200, Code: 100 | `number` | **No — code constant** | Max lines/chars to scan per detector |

### Example

**Input (build log):**
```
Running tests...
PASSED  src/test/foo.test.ts
FAILED  src/test/bar.test.ts > bar handles empty input
  Error: Expected 42 but got 0
      at Object.<anonymous> (src/test/bar.test.ts:15:22)
      
Tests: 1 passed, 1 failed, 0 skipped (total: 2)
```

**Output (`DetectionResult`):**
```json
{
  "content_type": "build",
  "confidence": 0.65,
  "metadata": {
    "pattern_matches": 5,
    "error_matches": 1,
    "total_lines": 7
  }
}
```

### Edge Cases

- **Empty input →** PlainText, confidence 0 (line 42-44)
- **Whitespace-only input →** PlainText, confidence 0
- **Single-line JSON array `[1,2,3]` →** JsonArray, confidence 0.8 (`is_dict_array: false`)
- **Empty JSON array `[]` →** JsonArray, confidence 0.8 (all-elements-are-objects check: `[].every(...)` returns `true` but length > 0 is false → 0.8)
- **Single diff hunk with no header →** null (headerMatches = 0)
- **HTML-like comment in code →** structuralMatches < 3 → returns null, falls through to code or prose
- **1-sentence text →** estimatedSentences = 1 < 2 → returns null

### Token-Monotone Guarantee

ContentDetector does not itself enforce token monotonicity — it is a classifier,
not a compressor. The Pipeline enforces the invariant by comparing token counts
before and after the dispatched compressor runs. If the chosen compressor produces
output ≥ input tokens, the original is returned and the content hash is added to
the cache skip set so it won't be retried.

---

## 2. SmartCrusher

**Source:** `src/compress/smart-crusher.ts:1-156`

### Overview

SmartCrusher compresses JSON arrays by selecting a representative subset of items.
It uses Kneedle to determine how many items to keep (`K`), then preserves a
stratified sample: first items, last items, the most relevant middle items
(scored by BM25 + embedding hybrid), and structural outliers. The result is
a valid JSON array with an omission marker comment.

### Headroom Reference

- `headroom-core/src/transforms/smart_crusher/orchestration.rs:1-450` — main orchestration logic
- `headroom-core/src/transforms/smart_crusher/crushers.rs:1-180` — item selection strategies
- `headroom-core/src/transforms/smart_crusher/outliers.rs:1-145` — structural outlier detection
- `headroom/transforms/smart_crusher.py:1-510` — Python implementation with identical logic

### Algorithm

**Step 1: Parse and guard**

```
arr = JSON.parse(content)
if not Array: return content
if arr.length < min_items_to_analyze: return content
n = arr.length
```

**Step 2: Structural outlier detection**

```
outlierIndices = detectStructuralOutliers(arr)   // see §10 Outliers
outlierSet = Set(outlierIndices)

for i in 0..n:
    if outlierSet.has(i): outliers.push(arr[i])
    else: nonOutlierItems.push(arr[i])
```

Outliers are preserved separately and appended at the end of the output. They
do not consume the K budget.

**Step 3: Kneedle K computation**

```
items = nonOutlierItems.map(i => JSON.stringify(i))
K = computeOptimalK(items, bias=1.0, minK=1, maxK=max_items)  // see §3 Kneedle
```

K is computed on non-outlier items only. The `maxK` is `cfg.max_items` (default 30).

**Step 4: Anchor budget (first + last fraction)**

```
firstCount  = Math.ceil(K × first_fraction)   // default: ceil(K × 0.3)
lastCount   = Math.ceil(K × last_fraction)    // default: ceil(K × 0.15)
middleBudget = K - firstCount - lastCount
```

Anchors guarantee the first and last items are always present. This is critical
for understanding the structure of chronologically-ordered arrays (e.g., most recent
events, oldest logs).

**Step 5: Fill middle slots (context-aware when available)**

```
first  = nonOutlierItems.slice(0, firstCount)
last   = nonOutlierItems.slice(-lastCount)
remaining = nonOutlierItems.slice(firstCount, -lastCount) except when overlap

if context provided:
    // Hybrid BM25 + embedding scoring with adaptive alpha (see §4)
    for each item in remaining:
        scores.push({ item, score: await hybridScore(JSON.stringify(item), context, 0.5) })
    
    sorted = scores.filter(s => s.score > 0).sort by score descending
    middle.push(...top middleBudget items from sorted)
    
    // Fallback: even sampling for remaining budget slots
    unselected = remaining not in sorted
    step = max(1, floor(unselected.length / remainingBudget))
    middle.push(...every step-th item from unselected)
else:
    // Even sampling only
    step = max(1, floor(remaining.length / middleBudget))
    middle.push(...every step-th from remaining)
```

When `context` is provided (the LLM conversation context), the hybrid scorer
ranks remaining items by relevance to the conversation. When no context is
available, a simple even-spacing strategy prevents clustering.

**Step 6: Combine with deduplication**

```
combined = []
seen = Set()
for each item in [first, middle, last, outliers]:
    key = JSON.stringify(item)
    if not seen.has(key):
        seen.add(key)
        combined.push(item)
```

Deduplication prevents the same logical item from appearing multiple times
(e.g., when first/last/middle selections overlap).

**Step 7: Output formatting**

```
output = JSON.stringify(combined, null, 2)
dropped = n - combined.length

if dropped > 0:
    if store:  // CCR available
        ccrHash = deriveKey(content)
        result = output + "\n// [N items omitted — retrieve with <<ccr:HASH>>]"
    else:
        result = output + "\n// [N items omitted]"
else:
    result = output

// Token-monotone check
if countTokensSync(result) >= countTokensSync(content):
    return content          // revert to original

if store and ccrHash: store.put(ccrHash, content)
```

The output is valid JSON (the omission marker is a `//` comment below the array,
which LLMs tolerate in tool output). The `countTokensSync` check uses the
`char/4` estimator (see `src/util/tokens.ts`).

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `min_items_to_analyze` | 10 | `number` | **Yes** (via `config` arg in `crushJsonArray()`) | Minimum array length before compression is attempted |
| `max_items` | 30 | `number` | **Yes** | Maximum items in output (K cap) |
| `first_fraction` | 0.3 | `number` | **Yes** | Fraction of K reserved for first items |
| `last_fraction` | 0.15 | `number` | **Yes** | Fraction of K reserved for last items |
| `bias` | 1.0 | `number` | **No — code constant** (passed to Kneedle) | Multiplier applied to resolved K |
| `smart_crusher` toggle | `true` | `boolean` | **Yes (toggle only)** (`compressors.smart_crusher` in `opencode.json`) | Enable/disable JSON array compression |
| Hybrid alpha base | 0.5 | `number` | **No — code constant** (passed to `hybridScore()`) | Base alpha for BM25/embedding blend |

### Example

**Input (3 items omitted, 5 preserved — simplified for illustration):**
```json
[
  {"id": 1, "name": "Alice", "score": 95},
  {"id": 2, "name": "Bob", "score": 82},
  {"id": 3, "name": "Carol", "score": 78},
  {"id": 4, "name": "Dave", "score": 91},
  {"id": 5, "name": "Eve", "score": 88}
]
```

**Output (K=4, first=2, last=1, middle=1):**
```json
[
  {"id": 1, "name": "Alice", "score": 95},
  {"id": 2, "name": "Bob", "score": 82},
  {"id": 4, "name": "Dave", "score": 91},
  {"id": 5, "name": "Eve", "score": 88}
]
// [1 item omitted — retrieve with <<ccr:a1b2c3d4e5f6...>>
```

With context `"Carol's score"`, item 3 (Carol) might be selected over item 4 (Dave)
in the middle slot because BM25 + embedding scores it higher against the context.

### Edge Cases

- **Array < `min_items_to_analyze` (10) →** returned unchanged (line 41)
- **Non-JSON / parse error →** returned unchanged (line 38)
- **All items are outliers →** `outliers` contains all items, `nonOutlierItems` is empty → K computed on empty array → K=0 → output = all outliers
- **Overlap between first and last (short array) →** deduplication prevents duplicates (line 119-133)
- **Middle budget ≤ 0 (K too small) →** no middle items selected, only first + last + outliers
- **Context has no relevance →** all scores 0 → `filtered` is empty → falls through to even sampling
- **CCR store not provided →** no `<<ccr:...>>` marker in output, just `[N items omitted]`
- **Compressed is not smaller →** original returned (line 152)

### Token-Monotone Guarantee

Enforced at line 152: `if (countTokensSync(result) >= countTokensSync(content)) return content`.
Uses the synchronous `char/4` estimator. If the overhead of the JSON formatting +
omission comment exceeds the savings from dropping items, the original is returned.

---

## 3. Kneedle (Adaptive Sizer)

**Source:** `src/compress/kneedle.ts:1-235`

### Overview

Kneedle determines the optimal number of items to preserve from a collection
using a three-tier algorithm inspired by information theory and compression
ratio validation. Given an array of item strings, it returns `K` — the ideal
count to keep — balancing diversity preservation with compression aggression.

Named after the "knee" in a cumulative curve where adding more items yields
diminishing returns on information gain.

### Headroom Reference

- `headroom-core/src/transforms/adaptive_sizer.rs:1-400` — Rust implementation
- `headroom/transforms/adaptive_sizer.py:1-320` — Python fallback

### Algorithm

The algorithm has three tiers, applied sequentially.

#### Tier 1: Fast Path (lines 204-210)

```
if n ≤ 8: return n
uniqueCount = countUniqueSimhash(items, threshold=3)
if uniqueCount ≤ 3: return min(effectiveMax, max(minK, uniqueCount))
```

Very small arrays (≤ 8) are always kept in full — no compression benefit.
Arrays where all items are near-duplicates (≤ 3 unique SimHash clusters) are
reduced to just the unique count, capped at `effectiveMax`.

#### SimHash Fingerprint (lines 11-42)

Each item gets a 64-bit SimHash fingerprint:

```
function simhash(text):
    lower = text.toLowerCase()
    chars = [...lower]
    n = chars.length
    iterCount = max(1, n - 3)  // 1 for very short text
    
    votes = new Int32Array(64)   // 64-bit accumulator
    
    for i in 0..iterCount:
        gram = chars[i..i+4].join("")   // 4-char sliding bigram
        hash = MD5(gram)                 // 16 bytes
        h = BigInt from first 8 bytes of hash (big-endian)
        
        for j in 0..63:
            if (h >> j) & 1: votes[j]++
            else:            votes[j]--
    
    fingerprint = 0n
    for j in 0..63:
        if votes[j] > 0: fingerprint |= (1n << BigInt(j))
    
    return fingerprint
```

This is a standard SimHash: each bigram casts 64 weighted votes (±1), and the
final bit is 1 where the sum is positive.

#### SimHash Clustering (lines 65-83)

```
function countUniqueSimhash(items, threshold=3):
    fingerprints = items.map(simhash)
    clusters = []
    for each fp:
        found = false
        for each cluster in clusters:
            if hammingDistance(fp, cluster) ≤ threshold:
                found = true; break
        if not found: clusters.push(fp)
    return clusters.length
```

Two items are considered "same" if their 64-bit fingerprints differ by ≤ 3 bits.
Hamming distance is computed via XOR + popcount (lines 46-56).

#### Tier 2: Kneedle Bigram Curve + Knee Detection (lines 212-226)

**Step 2a: Unique bigram curve (lines 92-109)**

```
function computeUniqueBigramCurve(items):
    seen = Set()
    curve = []
    for each item:
        words = item.toLowerCase().split(/\s+/)
        if words.length < 2:
            seen.add([words[0], ""])   // singleton bigram
        else:
            for j in 0..(words.length-2):
                bigram = [words[j], words[j+1]]
                seen.add(JSON.stringify(bigram))
        curve.push(seen.size)
    return curve
```

The curve shows cumulative unique word-pair bigrams as we process items
sequentially. A flat curve means items share vocabulary (redundant). A
steep curve means each item introduces new content (diverse).

**Step 2b: Knee detection (lines 119-146)**

```
function findKnee(curve):
    n = curve.length
    if n < 3: return null
    
    yMin = curve[0], yMax = curve[n-1]
    if |yMax - yMin| < 1e-10: return 1  // flat curve
    
    xRange = n - 1, yRange = yMax - yMin
    maxDiff = -Infinity, kneeIdx = null
    
    for i in 0..n:
        xNorm = i / xRange          // normalized position
        yNorm = (curve[i] - yMin) / yRange   // normalized value
        diff = yNorm - xNorm        // distance above diagonal line
        
        if diff > maxDiff:
            maxDiff = diff
            kneeIdx = i
    
    if maxDiff < 0.05: return null   // no significant knee
    return kneeIdx + 1               // 1-indexed count
```

The knee is the point on the normalized curve farthest above the diagonal
line from (0,0) to (1,1). This is the point of maximum marginal information
gain — after this point, each additional item adds less unique content.

**Step 2c: Resolve K from knee (lines 217-226)**

```
diversityRatio = uniqueCount / n

if knee === null:
    keepFraction = 0.3 + 0.7 × diversityRatio
    resolvedKnee = max(minK, floor(n × keepFraction))
else if diversityRatio > 0.7:
    // High diversity: inflate to capture more content
    floor = max(minK, floor(n × (0.3 + 0.7 × diversityRatio)))
    resolvedKnee = max(knee, floor)
else:
    resolvedKnee = knee

K = max(minK, floor(resolvedKnee × bias))
K = min(K, effectiveMax)
```

The diversity ratio acts as a floor: highly diverse collections get a larger
fraction preserved even if the knee suggests fewer items. The `bias` parameter
(default 1.0) allows callers to scale the result.

#### Tier 3: Zlib Validation (lines 155-182)

```
function validateWithZlib(items, k, maxK, tolerance=0.15):
    if k ≥ items.length or k ≥ maxK: return k
    
    fullText = items.join("\n")
    subsetText = items.slice(0, k).join("\n")
    
    if fullText.length < 200: return k  // too small to assess
    
    fullCompressed = deflateSync(Buffer.from(fullText))
    subsetCompressed = deflateSync(Buffer.from(subsetText))
    
    fullRatio = fullCompressed.length / fullText.length
    subsetRatio = subsetCompressed.length / subsetText.length
    
    ratioDiff = |fullRatio - subsetRatio|
    
    if ratioDiff > tolerance:
        // Subset compresses differently → not representative → expand
        adjusted = floor(k × 1.2)
        return min(adjusted, maxK)
    
    return k
```

This validates that the first K items have similar compression characteristics
to the full set. If the zlib compression ratio of the subset differs from the
full set by more than 15%, the subset is not representative — K is expanded by
20% to capture more diversity.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `bias` | 1.0 | `number` | **No — code constant** (passed by caller) | Multiplier applied to resolved K |
| `minK` | 1 | `number` | **No — code constant** (passed by caller) | Absolute minimum K |
| `maxK` | `undefined` (no cap) | `number?` | **No — code constant** (passed by caller) | Absolute maximum K |
| SimHash threshold | 3 | `number` | ⚠️ **No — code constant** | Hamming distance threshold for "same" items |
| Knee threshold | 0.05 | `number` | ⚠️ **No — code constant** | Minimum `diff` to recognize a knee |
| Diversity floor formula | `0.3 + 0.7 × ratio` | formula | **No — code constant** | Floor fraction when no knee or high diversity |
| Zlib tolerance | 0.15 | `number` | ⚠️ **No — code constant** | Maximum acceptable compression ratio difference |
| Zlib expansion factor | 1.2 | `number` | ⚠️ **No — code constant** | Multiplier when subset is not representative |
| Zlib min text length | 200 | `number` | ⚠️ **No — code constant** | Minimum chars to attempt zlib validation |
| Fast-path max items | 8 | `number` | **No — code constant** | Arrays ≤ this size always kept in full |
| Fast-path unique threshold | 3 | `number` | **No — code constant** | Max unique SimHash clusters for fast-path reduction |

⚠️ These are marked as "could be configurable" but are not exposed in the current plugin.

### Example

**Input: 100 JSON items representing API error logs, some with repeated error messages**

```
computeOptimalK(items, bias=1.0, minK=1, maxK=30)
```

**Intermediate values:**
- `n = 100`
- `uniqueCount = countUniqueSimhash(items) = 45` (out of 100, 45 unique by SimHash clustering)
- `curve = computeUniqueBigramCurve(items)` → plateaus around index 22
- `knee = findKnee(curve) = 22`
- `diversityRatio = 45/100 = 0.45`
- `resolvedKnee = 22` (diversityRatio ≤ 0.7, use knee directly)
- `K = max(1, floor(22 × 1.0)) = 22`
- `K = min(22, 30) = 22`
- `validateWithZlib(items, 22, 30, 0.15)` → ratioDiff = 0.08 (≤ 0.15) → K stays 22

**Output: `K = 22`**

### Edge Cases

- **≤ 8 items →** return `n` (Tier 1 fast path)
- **All items similar (uniqueCount ≤ 3) →** return `min(maxK, max(minK, uniqueCount))` → keep just the unique clusters
- **No knee detected (maxDiff < 0.05) →** fall back to `keepFraction = 0.3 + 0.7 × diversityRatio`
- **Very high diversity (> 0.7) →** K is floored at `n × (0.3 + 0.7 × diversityRatio)` even if knee says fewer
- **zlib validation fails (ratioDiff > 0.15) →** K expanded by 1.2×, capped at maxK
- **Full text < 200 chars →** skip zlib validation, could be misleading on tiny text
- **Flat bigram curve (yMax ≈ yMin) →** knee returns 1 (keep 1 representative item)
- **Overflow: knee > effectiveMax →** clipped to effectiveMax in resolution step

### Token-Monotone Guarantee

Kneedle is a select-*how-many* algorithm, not a compressor itself. The token-monotone
check is in the caller (SmartCrusher line 152 and Pipeline line 155). Kneedle's
own `bias` and `maxK` parameters provide guardrails: the caller sets `maxK` low
enough that the K items + omission footer will always be smaller than the original.

---

## 4. Relevance

**Source:** `src/compress/relevance.ts:1-148`

### Overview

Relevance scoring ranks items against a conversation context using a hybrid of
BM25 (keyword-based) and cosine similarity (embedding-based). An adaptive alpha
automatically weights the two scorers based on the presence of exact-match
patterns (UUIDs, numeric IDs, hostnames, email addresses) in the context.

Two functions are exported:
- `bm25Score(item, context)` — pure BM25 (0.0–1.0)
- `hybridScore(item, context, baseAlpha)` — BM25 + embedding blend (0.0–1.0)

### Headroom Reference

- `headroom-core/src/relevance/bm25.rs:1-180` — BM25 scoring (exact port)
- `headroom-core/src/relevance/hybrid.rs:1-200` — Hybrid scorer with adaptive alpha
- `headroom/transforms/smart_crusher.py:335-370` — Python relevance integration

### Algorithm

#### BM25 Tokenizer (lines 13-26)

```
TOKEN_RE = /[0-9a-fA-F]{8}-...{12}|\b\d{4,}\b|[a-zA-Z0-9_]+/g

function tokenize(text):
    lower = text.toLowerCase()
    tokens = []
    while match = TOKEN_RE.exec(lower):
        tokens.push(match[0])
    return tokens
```

The regex cascade prioritizes:
1. UUIDs (`8-4-4-4-12` hex format) — prevents splitting `a1b2c3d4-...` into fragments
2. Long numeric IDs (≥ 4 digits) — preserves `12345` as one token
3. Alphanumeric tokens — standard word-like tokens

#### BM25 Scoring (lines 40-80)

BM25 formula:

$$\text{score} = \sum_{t \in Q} \text{IDF}(t) \cdot \frac{f_t \cdot (k_1 + 1)}{f_t + k_1 \cdot (1 - b + b \cdot \frac{|D|}{\text{avgdl}})} \cdot qf_t$$

Where:
- $f_t$ = term frequency in the document (item)
- $qf_t$ = term frequency in the query (context)
- $|D|$ = document length in tokens
- $\text{avgdl}$ = average document length (single-doc: $|D|$ itself)
- $k_1 = 1.5$, $b = 0.75$

Since we score single documents against a query (no corpus), IDF is fixed to
$\ln(2.0) \approx 0.693$ — a neutral default.

```
function bm25Score(item, context):
    itemTokens = tokenize(item)
    contextTokens = tokenize(context)
    
    if no tokens on either side: return 0.0
    
    docLen = itemTokens.length
    avgdl = docLen  // single-doc scoring
    
    docFreq = freqMap(itemTokens)
    queryFreq = freqMap(contextTokens)
    idf = Math.log(2.0)
    
    score = 0.0, matched = []
    for term in sorted(contextTokens unique):
        f = docFreq[term] ?? 0
        if f == 0: continue
        matched.push(term)
        
        numerator = f * (K1 + 1)
        denominator = f + K1 * (1 - B + B * docLen / avgdl)
        score += idf * (numerator / denominator) * queryFreq[term]
    
    normalized = min(1.0, score / MAX_SCORE)   // MAX_SCORE = 10.0
    
    // Long-token bonus: ≥ 8 char match (UUIDs, long identifiers)
    if matched.some(t => t.length >= 8):
        normalized = min(1.0, normalized + 0.3)
    
    return normalized
```

The long-token bonus (+0.3) rewards matching UUIDs and long identifiers — these
are precise signals that an item is highly relevant.

#### Adaptive Alpha (lines 95-115)

The alpha controls the BM25/embedding blend weight:

$$\text{combined} = \alpha \cdot \text{BM25} + (1 - \alpha) \cdot \text{embedding}$$

Alpha adjusts based on pattern presence in the context:

```
function computeAlpha(context, baseAlpha):
    contextLower = context.toLowerCase()
    
    uuidCount = count(UUID_RE matches)
    idCount   = count(NUMERIC_ID_RE matches)
    hostCount = count(HOSTNAME_RE matches)
    emailCount = count(EMAIL_RE matches)
    
    alpha = baseAlpha
    
    if uuidCount > 0:       alpha = max(alpha, 0.85)   // UUIDs → exact match dominates
    else if idCount >= 2:   alpha = max(alpha, 0.75)   // multiple IDs → exact match strong
    else if idCount == 1:   alpha = max(alpha, 0.65)   // single ID → moderate exact
    else if hostCount > 0
         or emailCount > 0: alpha = max(alpha, 0.60)   // hostnames/emails → slight BM25 boost
    
    return clamp(alpha, 0.3, 0.9)
```

Protected range: $\alpha \in [0.3, 0.9]$. Never goes to 0.0 (skip BM25 completely)
or 1.0 (skip embedding completely).

#### Hybrid Scoring (lines 125-148)

```
async function hybridScore(item, context, baseAlpha=0.5):
    model = getEmbeddingModel()     // see §9 Embedding
    bm25 = bm25Score(item, context)
    
    if not model.ready:
        // BM25-fallback boost (lines 134-142)
        contextTokens = tokenize(context)
        itemTokens = tokenize(item)
        matchedCount = count(contextTokens in itemTokens)
        
        score = bm25
        if matchedCount >= 1: score = max(score, 0.3)   // floor
        if matchedCount >= 2: score = min(1.0, score + 0.2)  // extra boost
        return score
    
    alpha = computeAlpha(context, baseAlpha)
    embedding = await model.similarity(item, context)  // cosine similarity
    return alpha × bm25 + (1 - alpha) × embedding
```

When the embedding model is unavailable:
- ≥ 1 matched term → score forced to at least 0.3
- ≥ 2 matched terms → +0.2 boost, capped at 1.0

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| BM25 k1 | 1.5 | `number` | **No — code constant** | Term saturation parameter |
| BM25 b | 0.75 | `number` | **No — code constant** | Length normalization parameter |
| MAX_SCORE | 10.0 | `number` | **No — code constant** | Divisor for score normalization |
| Long-token bonus | 0.3 | `number` | **No — code constant** | Added when ≥ 8-char token matches |
| Long-token min length | 8 | `number` | **No — code constant** | Minimum token length for bonus |
| IDF | ln(2.0) ≈ 0.693 | `number` | **No — code constant** | Single-doc IDF |
| Alpha base | 0.5 | `number` | **No — code constant** | Default alpha for hybrid blend |
| Alpha UUID threshold | 0.85 | `number` | **No — code constant** | Alpha when UUIDs present |
| Alpha multi-ID threshold | 0.75 | `number` | **No — code constant** | Alpha when ≥ 2 numeric IDs |
| Alpha single-ID threshold | 0.65 | `number` | **No — code constant** | Alpha when exactly 1 numeric ID |
| Alpha host/email threshold | 0.6 | `number` | **No — code constant** | Alpha when hostname/email present |
| Alpha clamp range | [0.3, 0.9] | `[number, number]` | **No — code constant** | Allowed alpha range |
| BM25-fallback floor | 0.3 | `number` | **No — code constant** | Min score when ≥ 1 match, no embedding |
| BM25-fallback boost | 0.2 | `number` | **No — code constant** | Extra score for ≥ 2 matches, no embedding |

### Example

**Input:**
```
item:    "error: failed to connect to database 'users' at 10.0.1.5:5432"
context: "database connection error in production"
```

**Output (hybrid, embedding available):**
```
bm25Score    = 0.42  (matched: "database", "error", "connect"?)
embedding    = 0.55  (cosine sim with context)
alpha        = 0.50  (no UUIDs/IDs/hostnames in context)
hybridScore  = 0.50 × 0.42 + 0.50 × 0.55 = 0.485
```

### Edge Cases

- **Empty item or context →** return 0.0 (no tokens to match)
- **No embedding model →** fallback with BM25 boosts (≥1 match floor 0.3, ≥2 +0.2)
- **Context is a UUID `"a1b2c3d4-e5f6-..."` →** alpha boosted to 0.85
- **Context has no matches against item →** BM25 = 0.0, embedding still contributes
- **All tokens are < 8 chars →** no long-token bonus

### Token-Monotone Guarantee

Relevance scoring is a helper, not a compressor. Token monotonicity is handled by
SmartCrusher (which calls `hybridScore`) and Pipeline.

---

## 5. LogCompressor

**Source:** `src/compress/log-compressor.ts:1-380`

### Overview

LogCompressor compresses build, test, and error logs by selecting the most
informative lines. It uses a 5-stage pipeline: parse → score → select →
add-context → format. The output preserves error lines, first/last error, stack
traces, and summary lines, with omission markers for dropped content.

### Headroom Reference

- `headroom-core/src/transforms/log_compressor.rs:1-420` — Rust implementation
- `headroom/transforms/log_compressor.py:1-380` — Python fallback

### Algorithm

#### Stage 1: Parse (lines 113-180)

Each line is classified into a `LogLine` with:
- **level:** error, fail, warn, info, debug, trace, or unknown (via `LEVEL_PATTERNS` regex cascade)
- **isStackTrace:** true if line matches one of 6 stack-trace patterns
- **isSummary:** true if line matches one of 5 summary patterns
- **score:** computed from level + modifiers (see Stage 2)

Stack-trace detection uses a state machine:

```
inStackTrace = false, stackTraceLines = 0

for each line:
    test 6 STACK_TRACE_PATTERNS:
        Traceback (most recent call last)  → python
        File "...", line N                 → python
        at ...(...:N:N)                    → JS/V8
        at [\w.$]+\(                       → JS indented
        --> ...:N:N                        → Rust
        N: 0x[0-9a-f]+                     → native/Swift
    
    if matched: inStackTrace = true, stackTraceLines = 0
    if inStackTrace:
        ll.isStackTrace = true
        stackTraceLines++
        if stackTraceLines > 20: inStackTrace = false  // bailout
        else if blank line:
            peek ahead: if next non-blank is continuation → keep in trace
            else: inStackTrace = false
```

The peek-ahead on blank lines handles multi-section stack traces where a blank
line separates "Caused by:" sections but the trace continues.

#### Stage 2: Score (lines 68-82)

```
function scoreLine(ll):
    levelScores = { error: 1.0, fail: 1.0, warn: 0.5, info: 0.1, debug: 0.05, trace: 0.02, unknown: 0.1 }
    score = levelScores[ll.level]
    if ll.isStackTrace: score += 0.3
    if ll.isSummary: score += 0.4
    return min(1.0, score)
```

#### Stage 3: Select (lines 184-249)

Selection follows a priority hierarchy:

1. **Errors:** first + last kept, remaining slots filled by highest-score errors up to `max_errors`
2. **Warnings:** deduplicated by normalized prefix, top `max_warnings` by score
3. **Stack traces:** up to `max_stack_traces` traces, each truncated to `stack_trace_max_lines`
4. **Summaries:** all kept if `keep_summary_lines`
5. **Context lines:** `error_context_lines` lines around each selected error/fail line

After selection, lines are sorted by original line number for readability. If
the count exceeds `max_total_lines`, Kneedle is used to adaptively reduce:

```
adaptiveMax = computeOptimalK(allLineStrings, bias=1.0, minK=10, maxK=max_total_lines)
if selected.length > adaptiveMax:
    selected = top adaptiveMax by score, then sorted by line number
```

#### Stage 4: Deduplication (lines 282-309)

Warning deduplication normalizes the variable portions of warning lines:

```
function dedupeSimilar(lines):
    for each ll:
        content = ll.content
        splitAt = first ":" or "=" position
        prefix = content.slice(0, splitAt)
        suffix = content.slice(splitAt)
            .replace(/\d+/g, "N")           // numbers → N
            .replace(/0x[0-9a-fA-F]+/g, "ADDR")  // hex → ADDR
            .replace(/\/[\w/]+\//g, "/PATH/")    // paths → /PATH/
        normalized = prefix + suffix
        if not seen: seen.add(normalized), result.push(ll)
    return result
```

This collapses variations like:
```
Error connecting to database users at 10.0.1.5:5432
Error connecting to database analytics at 10.0.1.9:5432
```
into one representative warning.

#### Stage 5: Format (lines 334-380)

```
function formatOutput(selected, totalLines, allLines, ccrHash):
    selectedIndices = Set(selected indices)
    retrieveHint = ccrHash ? " — retrieve with <<ccr:HASH>>" : ""
    
    resultLines = []
    omitted = 0
    for i in 0..allLines.length:
        if selectedIndices.has(i):
            if omitted > 0:
                resultLines.push("[... N lines omitted{retrieveHint}]")
                omitted = 0
            resultLines.push(allLines[i].content)
        else:
            omitted++
    
    if omitted > 0:
        resultLines.push("[... N lines omitted{retrieveHint}]")
    
    // Summary footer
    resultLines.push("[N lines omitted: X ERROR, Y WARN, Z INFO{retrieveHint}]")
    
    return resultLines.join("\n")
```

Omitted sections are marked inline at their position in the log. A summary footer
at the end provides aggregate statistics.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `max_errors` | 10 | `number` | **Yes** (via `config` arg) | Maximum error/fail lines kept |
| `error_context_lines` | 3 | `number` | **Yes** | Context lines around each kept error |
| `keep_first_error` | true | `boolean` | **Yes** | Always keep the first error in the log |
| `keep_last_error` | true | `boolean` | **Yes** | Always keep the last error in the log |
| `max_stack_traces` | 3 | `number` | **Yes** | Maximum stack trace blocks kept |
| `stack_trace_max_lines` | 20 | `number` | **Yes** | Max lines per kept stack trace block |
| `max_warnings` | 5 | `number` | **Yes** | Maximum warning lines kept |
| `dedupe_warnings` | true | `boolean` | **Yes** | Enable warning deduplication |
| `keep_summary_lines` | true | `boolean` | **Yes** | Keep test-result summary lines |
| `max_total_lines` | 100 | `number` | **Yes** | Hard cap on total output lines (used as Kneedle maxK) |
| `log` toggle | `true` | `boolean` | **Yes (toggle only)** (`compressors.log` in `opencode.json`) | Enable/disable log compression |
| Stack trace bailout | 20 | `number` | **No — code constant** | Max consecutive stack-trace lines before state reset |
| Kneedle minK for log | 10 | `number` | **No — code constant** | Minimum lines when using Kneedle to cap |

### Example

**Input (60 lines, truncated here):**
```
[INFO] Starting build...
[INFO] Compiling 45 source files...
[WARN] src/user.ts:52: Deprecated API call at line 52
[INFO] src/user.ts compiled successfully
[ERROR] src/db.ts:128: Type 'any' is not assignable to type 'Connection'
  at TypeScript.checker.ts:5421
  at Object.compile (tsc.js:211)
[ERROR] src/db.ts:130: 'pool' is possibly undefined
  at TypeScript.checker.ts:5428
  at Object.compile (tsc.js:211)
... (many more lines)
[INFO] Build complete with 2 errors and 1 warning
```

**Output:**
```
[WARN] src/user.ts:52: Deprecated API call at line 52
[ERROR] src/db.ts:128: Type 'any' is not assignable to type 'Connection'
  at TypeScript.checker.ts:5421
  at Object.compile (tsc.js:211)
[ERROR] src/db.ts:130: 'pool' is possibly undefined
  at TypeScript.checker.ts:5428
[... 45 lines omitted — retrieve with <<ccr:a1b2c3...>>]
[INFO] Build complete with 2 errors and 1 warning
```

### Edge Cases

- **< 10 lines →** returned unchanged (line 95)
- **No error/warn lines →** only summaries and context lines selected
- **Stack trace > 20 lines →** cut off at 20, rest dropped
- **Blank line in stack trace followed by non-continuation →** inStackTrace resets
- **All warnings are identical (after dedup) →** only 1 kept
- **max_total_lines exceeded →** Kneedle adaptive reduction applied
- **Compressed output longer than original →** returned unchanged (line 105)
- **No CCR store →** omission markers without `<<ccr:...>>`, no retrieval possible

### Token-Monotone Guarantee

Enforced at line 105: `if (result.length >= content.length) return content`.
Uses string length, not token count, since all selected lines are preserved
verbatim — length faithfully approximates token count for same-language text.

---

## 6. SearchCompressor

**Source:** `src/compress/search-compressor.ts:1-210`

### Overview

SearchCompressor compresses grep/ripgrep output by selecting the most informative
matches per file. It parses `file:line:content` lines, groups by file, applies a
per-file budget with first/last anchors, and uses relevance scoring to fill
remaining slots.

### Headroom Reference

- `headroom-core/src/transforms/search_compressor.rs:1-280` — Rust implementation
- `headroom/transforms/search_compressor.py:1-240` — Python fallback

### Algorithm

#### Step 1: Parse (lines 65-97)

```
GREP_LINE_RE = /^(.+?)([:-])(\d+)\2(.*)$/
// Captures: file (group 1), separator (group 2: : or -), line number (group 3), content (group 4)
// \2 backreference ensures matching separators: "file:42:content" or "file-42-content"

for each non-blank line:
    // Handle Windows paths: C:\Users\... → detect drive letter, skip prefix
    if /^[A-Za-z]:\\/.test(line):
        skipPrefix = 2, adjusted = line.slice(2)
    
    match = GREP_LINE_RE.exec(adjusted)
    if match:
        file = (prefix if Windows) + match[1]
        separator = match[2]
        lineNum = parseInt(match[3])
        content = match[4]
        context_type = separator === "-" ? "context" : "match"  // ripgrep context lines use -
        
        matches[file].push({ file, line: lineNum, content, raw: line, context_type })
```

Ripgrep uses `-` separators for context lines (lines surrounding the actual match)
and `:` separators for match lines. The parser distinguishes them so context lines
can be deprioritized during selection.

#### Step 2: File ranking + capping (lines 118-129)

```
sortedFiles = Object.entries(matches)
    .sort(([, a], [, b]) => b.length - a.length)  // most matches first
    .slice(0, max_files)
```

Files are ranked by total match count. The most active files get priority.

#### Step 3: Per-file match selection (lines 130-174)

```
for each [file, fileMatches] in sortedFiles:
    if totalSelected >= max_total_matches: break
    
    sorted = [...fileMatches].sort by line number
    fileSelected = []
    remaining = min(max_matches_per_file, max_total_matches - totalSelected)
    
    // First/last anchors
    if keep_first_match and sorted.length > 0:
        fileSelected.push(sorted[0])
        remaining--
    if keep_last_match and sorted.length > 1 and sorted[last] ≠ sorted[0]:
        fileSelected.push(sorted[last])
        remaining--
    
    // Fill remaining slots from middle
    if remaining > 0 and sorted.length > 2:
        middle = sorted.slice(1, -1)
        middle.sort((a, b) => {
            if a.context_type !== b.context_type:
                return a.context_type === "match" ? -1 : 1   // prefer actual matches
            // Relevance-scored tiebreaker
            return scoreMatch(b...) - scoreMatch(a...)
        })
        for each m in middle while remaining > 0:
            fileSelected.push(m)
            remaining--
    
    fileSelected.sort by line number
    selected[file] = fileSelected
    totalSelected += fileSelected.length
```

#### Step 4: Relevance scoring (lines 101-114)

```
function scoreMatch(line, context?):
    score = 0.5  // baseline
    if /\b(error|err|fail|exception|panic|fatal)\b/i.test(line): score += 0.5
    if /\b(warn|warning)\b/i.test(line): score += 0.4
    if context:
        ctxTokens = context tokens with length > 3
        overlap = count(ctxTokens present in line)
        score += min(0.3, overlap × 0.1)
    return min(1.0, score)
```

#### Step 5: Output formatting (lines 181-210)

```
resultLines = []
retrieveHint = ccrHash ? " — retrieve with <<ccr:HASH>>" : ""

for file in sorted(selected keys):
    for match in selected[file]:
        resultLines.push(match.raw)
    omitted = original[file].length - selected[file].length
    if omitted > 0:
        resultLines.push("[... N more matches in {file}{retrieveHint}]")

omittedFiles = original files not in selected
if omittedFiles.length > 0:
    resultLines.push("[... N more files with matches omitted{retrieveHint}]")

return resultLines.join("\n")
```

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `max_matches_per_file` | 5 | `number` | **Yes** (via `config` arg) | Maximum matches kept per file |
| `max_files` | 20 | `number` | **Yes** | Maximum files kept in output |
| `max_total_matches` | 100 | `number` | **Yes** | Hard cap on total matches across all files |
| `keep_first_match` | true | `boolean` | **Yes** | Always keep the first match in each file |
| `keep_last_match` | true | `boolean` | **Yes** | Always keep the last match in each file |
| `search` toggle | `true` | `boolean` | **Yes (toggle only)** (`compressors.search` in `opencode.json`) | Enable/disable search compression |
| Baseline score | 0.5 | `number` | **No — code constant** | Baseline relevance score |
| Error pattern boost | +0.5 | `number` | **No — code constant** | Score boost for error-like lines |
| Warning pattern boost | +0.4 | `number` | **No — code constant** | Score boost for warning-like lines |
| Context overlap max | 0.3 | `number` | **No — code constant** | Maximum context-overlap boost |
| Context overlap coefficient | 0.1 | `number` | **No — code constant** | Per-overlapping-token boost |

### Example

**Input:**
```
src/db.ts:15:import { Pool } from 'pg'
src/db.ts:42:const pool = new Pool(config)
src/db.ts:128:  pool.query('SELECT * FROM users')  // Type 'any' is not assignable
src/db.ts:130:  pool.end()  // Property 'end' does not exist
src/user.ts:52:  const user = await getUser(id)
src/user.ts:89:  return user.name  // 'user' is possibly null
```

**Output (max_matches_per_file=3):**
```
src/db.ts:15:import { Pool } from 'pg'
src/db.ts:128:  pool.query('SELECT * FROM users')  // Type 'any' is not assignable
src/db.ts:130:  pool.end()  // Property 'end' does not exist
[... 1 more match in src/db.ts — retrieve with <<ccr:HASH>>]
src/user.ts:52:  const user = await getUser(id)
src/user.ts:89:  return user.name  // 'user' is possibly null
```

### Edge Cases

- **No grep-parseable lines →** returned unchanged (line 39)
- **All lines parse as one file →** single file, first + last + scored middle
- **Single match in a file →** kept (first = last = same line, guarded on line 144)
- **All context lines (no matches) →** all lines have `context_type: "context"`, scored on content alone
- **Windows paths →** drive letter preserved in file name
- **max_total_matches reached mid-file →** file processing stops, remaining files omitted
- **Compressed output longer than original →** returned unchanged (line 49)

### Token-Monotone Guarantee

Enforced at line 49: `if (result.length >= content.length) return content`.
String-length comparison since the output is a subset of the original lines.

---

## 7. DiffCompressor

**Source:** `src/compress/diff-compressor.ts:1-364`

### Overview

DiffCompressor compresses git diff output by preserving file headers, selecting
the most significant hunks, and trimming context lines around changes. It has
two code paths: a structured parser (preferred) and a line-scan fallback.

### Headroom Reference

- `headroom-core/src/transforms/diff_compressor.rs:1-350` — Rust implementation (structured parser)
- `headroom/transforms/diff_compressor.py:1-310` — Python fallback

### Algorithm

#### Step 1: Guard (lines 41-59)

```
if lines.length < 5: return content

ccrHash = store ? deriveKey(content) : undefined
result = compressDiffLines(lines, cfg, ccrHash)  // try structured

if (result.length >= content.length) return content  // token monotone
if (store && ccrHash) store.put(ccrHash, content)
return result
```

#### Step 2: Structured Parser (lines 63-127)

The parser builds a tree: `DiffFile[] → DiffHunk[] → lines`

```
for each line:
    if /^diff --git /.test(line):
        flushHunk(), push currentFile, start new file
    if not seenFirstHunk and /^(---|\+\+\+) /.test(line):
        currentFile.header.push(line)     // combined diff headers
    if HUNK_HEADER_RE.test(line):         // @@ -a,b +c,d @@
        flushHunk(), start new hunk
    if not seenFirstHunk:
        currentFile.header.push(line)     // pre-hunk metadata (index, mode, etc.)
    if inside hunk:
        currentHunkLines.push(line)
        if +line (not +++): addCount++
        if -line (not ---): delCount++
```

Each `DiffFile` has:
- `header: string[]` — lines from `diff --git` to first `@@`
- `hunks: DiffHunk[]` — each with `header`, `lines`, `addCount`, `delCount`

#### Step 3: File Selection (lines 210-229)

```
if files.length > max_files:
    selectedFiles = files sorted by (total add+del changes) descending
    selectedFiles = selectedFiles.slice(0, max_files)
```

Files with the most changes get priority.

#### Step 4: Hunk Selection (lines 233-243)

```
for each file in selectedFiles:
    if fileHunks.length > max_hunks_per_file:
        fileHunks = hunks sorted by (addCount + delCount) descending
        fileHunks = fileHunks.slice(0, max_hunks_per_file)
```

#### Step 5: Hunk Compression (lines 131-206)

Within each hunk, context lines beyond `max_context_lines` from the nearest change
are dropped and replaced with omission markers:

```
function compressHunk(hunk, maxContextLines):
    result = [hunk.header]
    find firstChange, lastChange indices
    
    if no changes: return [header, "[... N context-only lines dropped]"]
    
    contextDropped = 0
    for each line:
        if change line (+ or -):
            flush contextDropped marker if any
            result.push(line)
        
        if before firstChange:
            if firstChange - i ≤ maxContextLines: keep with preceding flush
            else: contextDropped++
        
        if after lastChange:
            if i - lastChange ≤ maxContextLines: keep with preceding flush
            else: contextDropped++
        
        if between changes: always keep
    
    flush remaining contextDropped
    return result
```

#### Step 6: Output Assembly (lines 231-269)

```
for each file:
    output file header lines
    for each selected hunk:
        output compressed hunk lines
        // Append CCR retrieve hint to omission markers
        for lines starting with "[... ":
            replace "]" with "{retrieveHint}]"
    output "[... N hunks omitted{retrieveHint}]" if any

output "[... N files omitted{retrieveHint}]" if any

return output.join("\n")
```

#### Step 7: Fallback (lines 274-364)

If the structured parser produces no files (unparseable diff), the fallback
operates on raw lines using the same regex patterns but without the file/hunk
tree. It tracks `hunksInFile` to cap per-file and uses a context-window buffer
(`currentHunkContext`) to limit context lines around changes.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `max_context_lines` | 3 | `number` | **Yes** (via `config` arg) | Max context lines kept around each change |
| `max_hunks_per_file` | 10 | `number` | **Yes** | Maximum hunks kept per file |
| `max_files` | 10 | `number` | **Yes** | Maximum files kept in output |
| `keep_file_headers` | true | `boolean` | **Yes** | Always include file headers |
| `diff` toggle | `true` | `boolean` | **Yes (toggle only)** (`compressors.diff` in `opencode.json`) | Enable/disable diff compression |

### Example

**Input:**
```diff
diff --git a/src/db.ts b/src/db.ts
index a1b2c3d..e4f5g6h 100644
--- a/src/db.ts
+++ b/src/db.ts
@@ -10,20 +10,25 @@
 import { Pool } from 'pg'
+import { retry } from './retry'
 
-const pool = new Pool({
-  host: 'localhost',
-  port: 5432,
-})
+const pool = new Pool({
+  host: process.env.DB_HOST,
+  port: parseInt(process.env.DB_PORT || '5432'),
+})
 
-export function query(sql: string) {
-  return pool.query(sql)
+export async function query(sql: string, retries = 3) {
+  return retry(async () => pool.query(sql), { retries })
 }
```

**Output (max_context_lines=2):**
```diff
diff --git a/src/db.ts b/src/db.ts
index a1b2c3d..e4f5g6h 100644
--- a/src/db.ts
+++ b/src/db.ts
@@ -10,20 +10,25 @@
 import { Pool } from 'pg'
+import { retry } from './retry'
 
-const pool = new Pool({
-  host: 'localhost',
-  port: 5432,
-})
+const pool = new Pool({
+  host: process.env.DB_HOST,
+  port: parseInt(process.env.DB_PORT || '5432'),
+})
 
-export function query(sql: string) {
-  return pool.query(sql)
+export async function query(sql: string, retries = 3) {
+  return retry(async () => pool.query(sql), { retries })
 }
```

(In this small example, all context lines fall within max_context_lines=3 so nothing is dropped.)

### Edge Cases

- **< 5 lines →** returned unchanged (line 49)
- **No hunk headers →** returns via fallback path (line 214)
- **All context, no changes in a hunk →** hunk header + `[... N context-only lines dropped]`
- **Combined diff (merge conflict, `diff --cc`) →** parsed by `DIFF_HEADER_RE` in content detector, three-way `@@@` hunk headers handled
- **Empty diff →** structured parser returns no files → fallback (line 214)
- **Hunk with only + lines (new file) →** firstChange=0, no "before" context, lastChange at end
- **Hunk with only - lines (deleted file) →** same, no additions
- **`\ No newline at end of file` →** collected as normal hunk line, not special-cased
- **Compressed longer than original →** returned unchanged (line 55)

### Token-Monotone Guarantee

Enforced at line 55: `if (result.length >= content.length) return content`.
Using string length. For diffs, this is conservative: dropped context lines
always make the output strictly shorter unless the omission markers and
commentary (omitted-hunks/files footer) offset the savings.

---

## 8. KompressCompressor

**Source:** `src/compress/kompress-compressor.ts:1-239`

### Overview

KompressCompressor uses an ONNX-based ML model (ModernBERT + dual-head classifier)
to perform extractive text compression. It scores each word in the input, keeping
only those the model deems essential. Requires `onnxruntime-node` and
`@xenova/transformers` — both are optional dependencies; if unavailable,
compression degrades gracefully (returns `null`, pipeline passes through).

### Headroom Reference

- `headroom/transforms/kompress_compressor.py:1-770` — Python implementation (exact port)
- Model: `chopratejas/kompress-base` on HuggingFace → `onnx/kompress-int8.onnx` (quantized int8 ONNX)
- Tokenizer: `answerdotai/ModernBERT-base`

### Algorithm

#### Step 1: Model Loading (lines 62-124)

Model loading is lazy and cached per-process:

```
if _cache !== undefined: return _cache   // already tried

try:
    ort = await import("onnxruntime-node")
    { AutoTokenizer } = await import("@xenova/transformers")
    
    cacheDir = ~/.cache/opencode-headroom/kompress/
    download "chopratejas/kompress-base" → onnx/kompress-int8.onnx if not cached
    
    session = ort.InferenceSession.create(onnxPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
    })
    
    tokenizer = AutoTokenizer.from_pretrained("answerdotai/ModernBERT-base")
    _cache = { model, tokenizer }
    return _cache
catch:
    _cache = null    // tried and failed — won't retry
    return null
```

The model is quantized int8 for CPU inference. No GPU required.

#### Step 2: ONNX Inference (lines 89-108)

```
model.get_scores(input_ids, attention_mask):
    flatIds = input_ids.flat().map(BigInt)   // int64 tensors
    flatMask = attention_mask.flat().map(BigInt)
    
    feeds = {
        input_ids: Tensor("int64", flatIds, [batchSize, seqLen]),
        attention_mask: Tensor("int64", flatMask, [batchSize, seqLen]),
    }
    results = session.run(feeds)
    scores = results.final_scores   // Float32Array, shape [batchSize, seqLen]
    
    // One score per input token, value in [0, 1]
    return scores

model.get_keep_mask(input_ids, attention_mask):
    scores = this.get_scores(...)
    return scores.map(row => row.map(s => s > 0.5))   // boolean mask
```

The ONNX model has a dual-head architecture:
- **Score head:** outputs a continuous score [0, 1] per token
- **Mask head:** produces the boolean keep-mask (internally `score > 0.5`)

#### Step 3: Chunked Processing (lines 155-205)

Text is split into chunks of `chunk_words` (default 350) to stay within the
tokenizer's `max_length=512`:

```
words = content.split(/\s+/)
n_words = words.length

if n_words < 10: return null   // passthrough for very short text

kept_ids = Set()

for chunk_start in 0..n_words step max_chunk_words:
    chunk_words = words[chunk_start .. chunk_start + max_chunk_words]
    
    encoding = tokenizer(chunk_words, {
        is_split_into_words: true,   // words already split
        truncation: true,
        max_length: 512,
        padding: true,
    })
    
    word_ids = encoding.word_ids()   // maps token index → word index (null for special tokens)
    
    if target_ratio defined:
        // Top-K mode: keep top (ratio × word_count) words by score
        scores = model.get_scores(...)[0]
        word_scores = Map<wordIndex, maxScore>
        sorted = word_scores entries sorted by score descending
        num_keep = max(1, floor(sorted.length × target_ratio))
        kept_ids add sorted[0..num_keep].wordIndex + chunk_start
    else:
        // Threshold mode: keep words with score > 0.5
        keep_mask = model.get_keep_mask(...)[0]
        for each word:
            if keep_mask[tokenIndex]:
                kept_ids.add(wordIndex + chunk_start)
```

The `word_ids()` mapping is critical: the tokenizer may produce multiple
subword tokens per word (e.g., "compression" → ["comp", "##ression"]).
Only the first subword's score is used (max-aggregation).

#### Step 4: Output Assembly (lines 207-232)

```
compressed_words = [...kept_ids].sort().map(w => words[w])
compressed = compressed_words.join(" ")
ratio = compressed_words.length / n_words

result = {
    compressed,
    original: content,
    original_tokens: n_words,
    compressed_tokens: compressed_words.length,
    compression_ratio: ratio,
    model_used: "chopratejas/kompress-base",
}

// CCR injection if ratio < 0.8 (significant compression)
if enable_ccr and ratio < 0.8 and store:
    cache_key = deriveKey(content)
    store.put(cache_key, content)
    result.cache_key = cache_key
    result.compressed += "\n[N items compressed to M. Retrieve more: hash=KEY]"
```

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `model_id` | `"chopratejas/kompress-base"` | `string` | **Yes** | HuggingFace model repo for ONNX file |
| `chunk_words` | 350 | `number` | **Yes** | Max words per inference chunk (must leave room for special tokens in 512 max_length) |
| `enable_ccr` | true | `boolean` | **Yes** | Inject CCR hash when compression ratio < 0.8 |
| `target_ratio` | `undefined` | `number?` | **Yes** | If set, use top-K mode; else threshold mode |
| `score_threshold` | 0.5 | `number` | **Yes** | Minimum score to keep a word (threshold mode only) |
| `kompress` toggle | `true` | `boolean` | **Yes (toggle only)** (`compressors.kompress` in `opencode.json`) | Enable/disable ML compression |
| Tokenizer max_length | 512 | `number` | **No — code constant** | ModernBERT max input length |
| Passthrough min words | 10 | `number` | **No — code constant** | Text shorter than this bypasses ML entirely |
| CCR injection threshold | 0.8 | `number` | **No — code constant** | Only inject CCR hint if ratio is below this |

### Example

**Input:**
```
The authentication service experienced a critical failure at 14:32 UTC. 
Connection pool exhaustion caused cascading timeouts across all upstream 
services. The root cause was traced to a misconfigured connection limit 
of 5 in the production environment, while the development environment 
correctly used 50. The fix involves updating the Kubernetes ConfigMap 
and rolling out a new deployment.
```

**Output (target_ratio=0.5, 42 words → 21 kept):**
```
authentication critical failure 14:32 UTC. Connection pool exhaustion 
cascading timeouts upstream services. root cause misconfigured connection 
limit 5 production environment, development 50. fix updating Kubernetes 
ConfigMap rolling deployment.
```

### Edge Cases

- **onnxruntime-node / @xenova/transformers not installed →** `_loadModel` catches error, sets `_cache = null`, `compressText` returns `null`, pipeline passes through
- **Text < 10 words →** returned `null` (passthrough)
- **Model download fails (no network) →** `_cache = null`, graceful degradation
- **All words scored ≤ 0.5 (threshold mode) →** `kept_ids` is empty → returns `null`
- **Chunk boundary splits a sentence →** model processes words independently; sentence context lost at chunk boundaries
- **target_ratio with long text →** top-K across all chunks, effectively global ranking
- **Very long text (100K+ words) →** 100K/350 ≈ 286 chunks, inference time scales linearly

### Token-Monotone Guarantee

The Pipeline enforces this (line 54-56 in `pipeline.ts`):
```
if (result.compressed_tokens >= result.original_tokens || 
    result.compressed.length >= result.original.length):
    return { text, strategy: "passthrough" }
```

Both token count (word count) and string length are checked. If compression
doesn't actually shrink the text, the original is returned.

---

## 9. Embedding

**Source:** `src/compress/embedding.ts:1-103`

### Overview

Embedding provides a singleton BGE-small-en-v1.5 model for computing text
embeddings and cosine similarity. Used by the hybrid scorer to blend BM25
keyword matching with semantic similarity. The model loads lazily via
`@xenova/transformers` (optional dependency).

### Headroom Reference

- `headroom-core/src/relevance/embedding.rs:1-180` — Rust implementation using `fastembed-rs`
- Same model: `BAAI/bge-small-en-v1.5` (headroom) vs `Xenova/bge-small-en-v1.5` (port) — identical weights, 384 dimensions

### Algorithm

#### Model Loading (lines 20-31)

```
let _modelPromise = null   // cached promise

function loadModel():
    if _modelPromise !== null: return _modelPromise
    try:
        pipelinePromise = import("@xenova/transformers").then(
            ({ pipeline }) => pipeline("feature-extraction", "Xenova/bge-small-en-v1.5")
        )
        _modelPromise = pipelinePromise.catch(() => null)
    catch:
        _modelPromise = Promise.resolve(null)
    return _modelPromise
```

The model is a sentence-transformer using BGE-small architecture. The
`feature-extraction` pipeline returns raw embeddings; pooling and normalization
are configured at inference time.

#### Singleton (lines 35-46)

```
let _singleton = null

function getEmbeddingModel():
    if _singleton: return _singleton
    _singleton = createEmbeddingModel()
    return _singleton
```

#### Embed Method (lines 72-85)

```
async embed(text):
    cached = cache.get(text)
    if cached: return cached      // per-text cache, avoids re-embedding
    
    await ensureModel()           // lazy-init on first call
    if not ready: return new Float32Array(384)  // zero vector fallback
    
    result = await extractor(text, { pooling: "mean", normalize: true })
    vec = new Float32Array(result.data)   // 384-dimensional, L2-normalized
    cache.set(text, vec)
    return vec
```

Mean pooling aggregates token-level embeddings into a single sentence vector.
L2 normalization makes the vector unit-length, so cosine similarity = dot product.

#### Similarity Method (lines 87-99)

```
async similarity(a, b):
    if not ready:
        if not initDone: await ensureModel()
        if not ready: return 0.5   // neutral fallback
    
    [vecA, vecB] = await Promise.all([embed(a), embed(b)])
    dot = Σ(vecA[i] × vecB[i]) for i in 0..383
    return max(0, min(1, dot))
```

Both vectors are L2-normalized, so dot product ∈ [-1, 1]. Clamped to [0, 1]
for use as a relevance score.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| Model name | `"Xenova/bge-small-en-v1.5"` | `string` | **No — code constant** | HuggingFace model identifier |
| Dimensions | 384 | `number` | **No — code constant** | Output vector size (model property) |
| Pooling | `"mean"` | `string` | **No — code constant** | Token-to-sentence aggregation |
| Normalize | `true` | `boolean` | **No — code constant** | L2 normalization after pooling |
| Fallback similarity | 0.5 | `number` | **No — code constant** | Returned when model is unavailable |
| Zero vector | `Float32Array(384)` | `Float32Array` | **No — code constant** | Returned by `embed()` when model unavailable |

### Example

**Input:**
```
embed("database connection timeout error")
```

**Output:**
```
Float32Array(384) [
  0.0234, -0.0156, 0.0089, ..., 0.0312
]
// L2-normalized, ‖v‖₂ = 1.0
```

**Similarity example:**
```
similarity("database error", "db connection failed")
// ≈ 0.78  (high semantic similarity despite different words)
```

### Edge Cases

- **Model download fails / no network →** `ready = false`, returns zero vectors / 0.5 similarity
- **Empty string →** tokenizer produces only special tokens; mean pooling returns near-zero vector
- **Very long text →** truncated to model max length (512 tokens for BGE-small)
- **Cache hit →** same text returns identical Float32Array (by reference, not copy)
- **Concurrent calls before load finishes →** `ensureModel()` guards against duplicate initialization via `initStarted` flag

### Token-Monotone Guarantee

Embedding is a helper, not a compressor. Token monotonicity is handled by
callers (SmartCrusher via hybridScore, Pipeline via token comparison).

---

## 10. Outliers

**Source:** `src/compress/outliers.ts:1-144`

### Overview

Outliers detects structurally anomalous items in JSON arrays. Two detection
strategies operate independently: rare-field detection (items containing fields
present in < 20% of the array) and rare-status detection (items with uncommon
values in common categorical fields, using Pareto analysis). Outlier indices
are returned sorted and preserved separately in SmartCrusher output.

### Headroom Reference

- `headroom-core/src/transforms/smart_crusher/outliers.rs:1-200` — Rust implementation
- Bug #3 fixed in port: cardinality guard raised from `2..=10` (Python) to `2..=50`

### Algorithm

#### Rare-Field Detection (lines 39-47)

```
fieldCounts = Map<fieldName, count> across all object items
n = items.length

rareFields = { field: count < n × 0.2 }
commonFields = { field: count ≥ n × 0.8 }

for each item i:
    if item has any key in rareFields:
        outlierSet.add(i)
```

Items with fields present in fewer than 20% of the array are flagged. These
might represent optional metadata, error-specific fields, or schema violations.

#### Rare-Status Detection (lines 64-143)

Operates on common fields (≥ 80% presence). For each common field:

```
for fieldName in sorted(commonFields):
    // Collect values
    values = [item[fieldName] for item in items if fieldName in item]
    if values.length == 0: continue
    
    // Compute cardinality (unique non-null values)
    uniqueValues = Set(stringify(v) for v in values if v !== null)
    
    // Cardinality guard: skip if < 2 or > 50
    // (Bug #3 fix: was 2..=10 in Python headroom)
    if uniqueValues.size < 2 or uniqueValues.size > 50: continue
    
    // Frequency count
    valueCounts = Map<key, count>
    for v in values:
        key = v === null ? "__none__" : stringify(v)
        valueCounts[key]++
    
    total = values.length
    sorted = [...valueCounts].sort descending by count
    
    // Pareto check: smallest K where top-K covers ≥ 80% of items, with K ≤ 5
    threshold = Math.ceil(total × 0.8)
    cumulative = 0
    topKValues = Set()
    
    for [key, count] in sorted:
        cumulative += count
        topKValues.add(key)
        if cumulative >= threshold: break
    
    if topKValues.size > 5: continue    // too fragmented, not a meaningful categorical field
    
    // Items NOT in top-K → outliers
    for each item i with this field:
        if item[fieldName] not in topKValues:
            outlierIndices.push(i)
```

The Pareto check verifies that the field is categorical (few unique values
dominate the distribution). If the top-K values cover ≥ 80% of items and
K ≤ 5, the field is likely a status/enum/type field. Items with values
outside the dominant group are flagged.

#### Combining (line 54)

```
return [...outlierSet].sort((a, b) => a - b)
```

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| Min array size | 5 | `number` | **No — code constant** | Arrays smaller than this skip outlier detection |
| Rare-field threshold | 0.2 | `number` | **No — code constant** | Field presence fraction below which it's "rare" |
| Common-field threshold | 0.8 | `number` | **No — code constant** | Field presence fraction above which it's "common" |
| Cardinality min | 2 | `number` | **No — code constant** | Minimum unique values for rare-status detection |
| Cardinality max | 50 | `number` | **No — code constant** | Maximum unique values (Bug #3 fix: was 10 in Python) |
| Pareto coverage | 0.8 | `number` | **No — code constant** | Fraction of values the top-K must cover |
| Pareto max K | 5 | `number` | **No — code constant** | Maximum K for Pareto group to be considered categorical |

### Example

**Input:**
```json
[
  {"id": 1, "type": "user", "status": "active"},
  {"id": 2, "type": "user", "status": "active"},
  {"id": 3, "type": "user", "status": "active"},
  {"id": 4, "type": "user", "status": "suspended"},
  {"id": 5, "type": "admin", "status": "active", "permissions": ["*"]}
]
```

**Detection:**
- `commonFields`: `id` (100%), `type` (100%), `status` (100%)
- `rareFields`: `permissions` (20% < threshold) — only item 5 has it

**Rare-status on `status`:**
- values: active (4), suspended (1)
- cardinality: 2 → within [2, 50] guard
- sorted: active=4, suspended=1
- threshold: ceil(5 × 0.8) = 4
- cumulative: active=4 ≥ 4 → topKValues = {active}, K=1 ≤ 5 ✓
- items with status ∉ {active}: item 4 → flagged

**Result: `[3, 4]`** (0-indexed: item 4 has rare status, item 5 has rare field)

### Edge Cases

- **< 5 items →** returns `[]` (line 16)
- **All items identical →** no rare fields, no rare status → `[]`
- **Field with 1000 unique values →** skipped by cardinality guard (> 50)
- **Field present in exactly 20% of items →** NOT rare (threshold is strict `< 0.2`)
- **Field present in exactly 80% of items →** IS common (threshold is `≥ 0.8`)
- **All values in a field are unique →** cardinality = n, may exceed 50 → skipped
- **Null values →** excluded from cardinality count, mapped to `__none__` for status check
- **Non-object items in array →** skipped (only objects are analyzed)

### Token-Monotone Guarantee

Outliers is a detector, not a compressor. In SmartCrusher, outliers are
preserved outside the K budget and appended at the end of the output.
They do not reduce the non-outlier selection; they add to it. If including
outliers makes the output ≥ original, SmartCrusher's own token check reverts.

---

## 11. CacheAligner

**Source:** `src/compress/cache-aligner.ts:1-50`

### Overview

CacheAligner normalizes volatile tokens in system prompts to improve LLM
provider KV cache hit rates. It replaces UUIDs, ISO 8601 timestamps, dates,
and long hex session IDs with stable placeholder tokens. The normalization is
deterministic: the same system prompt with different UUIDs/timestamps will
produce the same normalized string.

### Headroom Reference

- `headroom/transforms/cache_aligner.py:1-80` — Python reference (detection-only mode in headroom)
- `headroom-core/src/cache_control.rs:1-200` — Rust cache control system
- **Note:** Headroom upstream is detection-only; this port actually mutates the prompt (see `docs/discrepancy.md` §7)

### Algorithm

#### Normalization Patterns (lines 7-12)

Four regex patterns in a fixed order:

```
NORMALIZATION_PATTERNS = {
    UUID:       /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi,
    TIMESTAMP:  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gi,
    DATE:       /\b\d{4}-\d{2}-\d{2}\b/gi,
    SESSION_ID: /\b[\da-f]{32,}\b/gi,
}
```

Order is critical:
1. UUID first — contains hyphens, won't overlap with session IDs
2. Timestamp before Date — timestamps contain date substrings
3. Date — standalone dates (may also match timestamp substrings, but order handles this)
4. Session ID last — 32+ hex chars, won't match UUIDs (which have hyphens)

#### Replacement (lines 16-22)

```
REPLACEMENT_ORDER = [
    { key: "UUID",       replacement: "<<UUID>>" },
    { key: "TIMESTAMP",  replacement: "<<TIMESTAMP>>" },
    { key: "DATE",       replacement: "<<DATE>>" },
    { key: "SESSION_ID", replacement: "<<SESSION_ID>>" },
]
```

Sequential replacement: each pass operates on the output of the previous pass.

#### Public API (lines 35-49)

```
function normalizeSystemPrompt(text):
    try:
        result = text
        for each { key, replacement } in REPLACEMENT_ORDER:
            result = result.replace(NORMALIZATION_PATTERNS[key], replacement)
        changed = result !== text
        return { normalized: result, changed }
    catch:
        return { normalized: text, changed: false }   // fail-open
```

Fail-open: if regex replacement throws (e.g., catastrophic backtracking on
pathological input), the original is returned unchanged.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `cache_align` | `true` | `boolean` | **Yes** (`cache_align` in `opencode.json`) | Enable/disable system prompt normalization |
| UUID replacement | `"<<UUID>>"` | `string` | **No — code constant** | Placeholder for UUIDs |
| TIMESTAMP replacement | `"<<TIMESTAMP>>"` | `string` | **No — code constant** | Placeholder for ISO timestamps |
| DATE replacement | `"<<DATE>>"` | `string` | **No — code constant** | Placeholder for ISO dates |
| SESSION_ID replacement | `"<<SESSION_ID>>"` | `string` | **No — code constant** | Placeholder for long hex session IDs |
| Regex patterns | See above | `RegExp` | **No — code constant** | Fixed module-level constants |

### Example

**Input:**
```
Session a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 — created at 2026-06-10T14:30:00Z.
Today's date is 2026-06-10. Request ID: 550e8400-e29b-41d4-a716-446655440000
```

**Output:**
```
Session <<SESSION_ID>> — created at <<TIMESTAMP>>.
Today's date is <<DATE>>. Request ID: <<UUID>>
```

### Edge Cases

- **No patterns match →** `changed = false`, returns original
- **Regex execution error →** caught, returns `{ normalized: text, changed: false }`
- **Multiple UUIDs in same text →** all replaced with `<<UUID>>`
- **Date inside longer text (e.g., filename) →** replaced if matches pattern (may be over-aggressive)
- **Timestamp + date on same line →** timestamp replaced first, date pattern then matches nothing new
- **Session ID is exactly 32 chars →** matches (pattern is `{32,}`)
- **31-char hex →** NOT matched as session ID (too short)

### Token-Monotone Guarantee

CacheAligner may increase or decrease token count slightly (e.g., UUID
`550e8400-e29b-41d4-a716-446655440000` [36 chars] → `<<UUID>>` [8 chars]).
The token effect is negligible and always accepted. The primary benefit is
KV cache hit rate improvement, not token savings.

---

## 12. CompressionCache

**Source:** `src/compress/compression-cache.ts:1-106`

### Overview

CompressionCache is a two-tier in-memory cache that avoids re-compressing content
that was previously processed. Tier 1 (skip set) tracks content known to be
non-compressible for instant rejection. Tier 2 (result cache) stores the
compressed output for content that DID compress. All entries expire after a
configurable TTL.

### Headroom Reference

- `headroom/transforms/content_router.py:191-295` — Python implementation (`CompressionCache` class)

### Algorithm

#### Key Derivation (lines 33-35)

```
private key(content): return deriveKey(content)
```

Uses SHA-256 truncated to 24 hex chars (same as CCR hash). The key is the
content hash — two identical text blocks produce the same key.

#### Tier 1: Skip Set (lines 38-49)

```
isSkipped(content):
    key = this.key(content)
    ts = this.skip.get(key)
    if ts === undefined: return false
    if Date.now() - ts < this.ttlMs:
        this.skipHits++
        return true
    // Expired
    this.skip.delete(key)
    this.evictions++
    return false
```

Known non-compressible content: the first time compression fails (passthrough),
the hash is added to the skip set. Subsequent identical content skips immediately.

#### Tier 2: Result Cache (lines 52-67)

```
get(content):
    key = this.key(content)
    entry = this.results.get(key)
    if entry === undefined: this.misses++; return null
    if Date.now() - entry.created_at < this.ttlMs:
        this.hits++
        return { compressed, ratio, strategy }
    // Expired
    this.results.delete(key)
    this.evictions++; this.misses++
    return null
```

Previously compressed content: returns the cached compressed text, compression
ratio, and strategy name. No re-detection, no re-compression.

#### Other Operations

```
put(content, compressed, ratio, strategy):     // store compressed result
markSkip(content):                              // mark as non-compressible
moveToSkip(content):                            // move from result cache to skip set
clear():                                        // wipe both tiers
```

#### Stats (lines 91-100)

```
get stats():
    return {
        cache_hits: this.hits,
        cache_skip_hits: this.skipHits,
        cache_misses: this.misses,
        cache_evictions: this.evictions,
        cache_size: this.results.size,
        cache_skip_size: this.skip.size,
    }
```

Stats are exposed by the `headroom_stats` tool tool for observability.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `ttlMs` | 1,800,000 (30 min) | `number` | **No — code constant** (constructor arg) | Entry expiry in milliseconds |

### Example

**Cache state after 3 compress calls:**
```
Call 1: "long json array"              → compressed (85% ratio) → added to results
Call 2: "same long json array"         → cache hit! (Tier 2)    → returns cached
Call 3: "short text"                   → not compressible       → added to skip
Call 4: "same short text"              → skip hit! (Tier 1)     → instant null
Call 5: "another long array"           → compressed             → added to results
Call 6: (30 min later) "short text"    → skip expired           → evicted, re-evaluated
```

### Edge Cases

- **Content hash collision →** SHA-256 truncated to 24 chars (96 bits). Birthday bound: ~2^48 entries before expected collision. Not a practical concern for in-memory cache.
- **Cache growing unbounded →** no size-based eviction, only TTL. Entries expire automatically. For very long sessions, the GC will eventually clean unreferenced Map entries.
- **`moveToSkip` called with content not in results →** no-op (Map.delete of missing key)
- **Concurrent access →** no locking. This runs single-threaded in Bun's event loop; no races.

### Token-Monotone Guarantee

Cache returns the original compressed output, which was already validated as
token-monotone when first created. The Pipeline still re-verifies token count
on cache hits (pipeline.ts line 96-97) as a defense-in-depth measure.

---

## 13. MixedContent

**Source:** `src/compress/mixed-content.ts:1-164`

### Overview

MixedContent detects when a text block contains two or more distinct content
types (e.g., Markdown with embedded JSON and code fences). When detected, the
text is split into typed sections, each compressed independently by its
type-specific compressor, and the results are reassembled.

### Headroom Reference

- `headroom/transforms/content_router.py:524-698` — Python implementation (`is_mixed_content` and `split_into_sections`)

### Algorithm

#### Detection: `isMixedContent` (lines 20-34)

```
function isMixedContent(content):
    lines = content.split("\n")
    indicators = 0
    
    if lines.some(l => CODE_FENCE_RE.test(l)): indicators++    // ```lang
    if lines.some(l => JSON_BLOCK_START.test(l)): indicators++  // [ or {
    if lines.some(l => SEARCH_RESULT_RE.test(l)): indicators++  // file:line:
    
    proseMatches = count(/.!?[\s\n]+[A-Z]/g in content)
    if proseMatches > 5: indicators++
    
    return indicators >= 2
```

At least 2 of 4 indicators must be present: code fences, JSON blocks, search
results, or prose (≥ 6 sentence boundaries).

#### Section Splitting: `splitIntoSections` (lines 40-130)

A state-machine parser that scans lines sequentially:

```
sections = []
i = 0

while i < lines.length:
    // 1. Code fence section
    if CODE_FENCE_RE.test(line):
        codeLines = []
        startLine = i
        i++
        while i < lines.length and not lines[i].startsWith("```"):
            codeLines.push(lines[i])
            i++
        sections.push({ content: codeLines.join("\n"), content_type: SourceCode, startLine, endLine: i })
        i++  // skip closing ```
    
    // 2. JSON block section
    else if JSON_BLOCK_START.test(line):
        result = extractJsonBlock(lines, i)   // bracket-balanced extraction
        if result:
            sections.push({ content: result.json, content_type: JsonArray, startLine: i, endLine: result.endLine })
            i = result.endLine + 1
    
    // 3. Search result section
    else if SEARCH_RESULT_RE.test(line):
        searchLines = []
        startLine = i
        while i < lines.length and SEARCH_RESULT_RE.test(lines[i]):
            searchLines.push(lines[i])
            i++
        sections.push({ content: searchLines.join("\n"), content_type: SearchResults, startLine, endLine: i-1 })
    
    // 4. Text section (catch-all)
    else:
        textLines = [line]
        startLine = i
        i++
        while i < lines.length and next line doesn't match any section start:
            textLines.push(lines[i])
            i++
        if text.join("\n").trim():
            sections.push({ content: text.join("\n"), content_type: PlainText, startLine, endLine: i-1 })
```

#### JSON Block Extraction (lines 136-164)

Extracts a complete JSON block by tracking bracket/brace balance with string
escaping awareness:

```
function extractJsonBlock(lines, start):
    bracketCount = 0, braceCount = 0
    jsonLines = []
    inString = false, escaped = false
    
    for i in start..lines.length-1:
        line = lines[i]
        jsonLines.push(line)
        
        for ch in line:
            if escaped: escaped = false; continue
            if ch == "\\": if inString: escaped = true; continue
            if ch == '"': inString = !inString; continue
            if inString: continue
            if ch == "[": bracketCount++
            if ch == "]": bracketCount--
            if ch == "{": braceCount++
            if ch == "}": braceCount--
        
        if bracketCount ≤ 0 and braceCount ≤ 0 and jsonLines.length > 0:
            return { json: jsonLines.join("\n"), endLine: i }
    
    return null   // unclosed block
```

This handles nested objects/arrays, escaped quotes in strings, and
multiline JSON. Only the balance check matters — the content isn't
validated as parseable JSON.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| Min indicators for mixed | 2 | `number` | **No — code constant** | Number of content-type indicators required |
| Prose indicator threshold | 6 | `number` | **No — code constant** | Minimum sentence boundary matches for prose indicator |
| Code fence regex | `/^```(\w*)$/` | `RegExp` | **No — code constant** | Matches opening code fences |
| JSON block start regex | `/^\s*[\[{]/` | `RegExp` | **No — code constant** | Matches potential JSON array/object starts |
| Search result regex | `/^(.+?)[:-](\d+)[:-]/` | `RegExp` | **No — code constant** | Matches search output lines |

### Example

**Input:**
```
Here are the results from the database query:

```json
[
  {"id": 1, "name": "Alice"},
  {"id": 2, "name": "Bob"},
  {"id": 3, "name": "Carol"}
]
```

I found these issues in the codebase:
src/db.ts:15:import { Pool } from 'pg'
src/db.ts:128:  pool.query('SELECT * FROM users')
src/user.ts:89:  return user.name
```

**Detection:** indicators = 3 (code fence + JSON block + search results) → `isMixedContent = true`

**Sections:**
```
Section 1: PlainText  — "Here are the results from the database query:\n\n"
Section 2: SourceCode — json array content (between ``` fences)
Section 3: PlainText  — "\nI found these issues in the codebase:\n"
Section 4: SearchResults — "src/db.ts:15:import ..." etc.
```

Each section is then dispatched to its type-specific compressor:
- Section 2 → SmartCrusher compresses the JSON
- Section 4 → SearchCompressor compresses the grep output
- Sections 1, 3 → PlainText, passthrough

### Edge Cases

- **Nested code fences →** the parser finds the first closing ```` ``` ```` — inner fences treated as code content
- **JSON block with `{` in strings →** escape handling prevents false balance
- **Unclosed JSON block →** `extractJsonBlock` returns null → treated as text
- **Empty text sections →** trimmed, not added to sections array
- **Single content type →** `isMixedContent` returns false → Pipeline uses normal dispatch
- **JSON followed immediately by code fence →** correctly split (JSON block ends at `bracketCount ≤ 0`)
- **Search results adjacent to text →** search scanner consumes all consecutive search lines

### Token-Monotone Guarantee

Enforced in Pipeline (lines 126-134): after all sections are compressed and
reassembled, the total length is compared to the original. If `totalAfter ≥ text.length`,
the cache marks it as skip and returns null.

---

## 14. Pipeline

**Source:** `src/compress/pipeline.ts:1-271`

### Overview

The Pipeline is the main orchestration layer of opencode-headroom. It wires
together content detection, mixed-content splitting, compressor dispatch, the
two-tier cache, CCR store integration, token-monotone enforcement, and fail-open.
It is invoked via two hooks:
- `chat.system.transform` — CacheAligner normalizes system prompts
- `tool.execute.after` — `compressBlock` compresses tool result text

### Headroom Reference

- `headroom-core/src/transforms/pipeline/orchestrator.rs:1-500` — Rust orchestrator
- `headroom/transforms/pipeline.py:1-350` — Python pipeline
- `headroom/transforms/content_router.py:1-700` — Python content routing + caching

### Algorithm

#### Hook: `chat.system.transform` (via plugin index.ts)

Calls `normalizeSystemPrompt()` on the system prompt if `cache_align` is enabled.
See §11 CacheAligner.

#### Hook: `tool.execute.after` (via plugin index.ts)

Captures tool result text, calls `compressBlock()`, and mutates the message
part in-place if compression succeeds.

#### `compressBlock()` — Single Block (lines 79-162)

```
async function compressBlock(text, store, cache, compressors):
    if !text: return null
    
    tokensBefore = countTokensSync(text)
    
    // Tier 1: known non-compressible — instant skip
    if cache?.isSkipped(text): return null
    
    // Tier 2: cached compressed result
    if cache:
        cached = cache.get(text)
        if cached:
            tokensAfter = countTokensSync(cached.compressed)
            return { compressed: cached.compressed, tokensBefore, tokensAfter, strategies: [cached.strategy] }
    
    // Mixed-content detection
    if isMixedContent(text):
        sections = splitIntoSections(text)
        compressedSections = []
        totalAfter = 0
        strategies = []
        
        for section in sections:
            if section.content_type in [PlainText, SourceCode]:
                compressedSections.push(section.content)
                totalAfter += section.content.length
                continue
            result = await dispatchCompressor(section.content, section.content_type, store, compressors)
            if result:
                compressedSections.push(result.text)
                totalAfter += result.text.length
                strategies.push(result.strategy)
            else:
                compressedSections.push(section.content)
                totalAfter += section.content.length
        
        // Token-monotone guard
        if totalAfter < text.length:
            compressed = compressedSections.join("\n")
            tokensAfter = countTokensSync(compressed)
            if cache: cache.put(text, compressed, compressed.length / text.length, "mixed," + strategies.join(","))
            return { compressed, tokensBefore, tokensAfter, strategies: ["mixed", ...strategies] }
        
        if cache: cache.markSkip(text)
        return null
    
    // Normal (non-mixed) dispatch
    detection = detectContentType(text)
    if detection.content_type === PlainText:
        if cache: cache.markSkip(text)
        return null
    
    dispatchResult = await dispatchCompressor(text, detection.content_type, store, compressors)
    if !dispatchResult:
        if cache: cache.markSkip(text)
        return null
    
    compressed = dispatchResult.text, strategy = dispatchResult.strategy
    if compressed === text:
        if cache: cache.markSkip(text)
        return null
    
    tokensAfter = countTokensSync(compressed)
    if tokensAfter >= tokensBefore:
        if cache: cache.markSkip(text)
        return null
    
    if cache: cache.put(text, compressed, compressed.length / text.length, strategy)
    return { compressed, tokensBefore, tokensAfter, strategies: [strategy] }
```

#### `dispatchCompressor()` — Type Dispatch (lines 37-71)

```
async function dispatchCompressor(text, contentType, store, compressors):
    switch contentType:
        case JsonArray:
            if compressors and not compressors.smart_crusher: return null
            result = await crushJsonArray(text, undefined, store, undefined)
            return { text: result, strategy: "smart_crusher" }
        
        case Prose:
            if compressors and not compressors.kompress: return null
            result = await compressText(text, undefined, store)
            if !result: return { text, strategy: "passthrough" }
            if result.compressed_tokens >= result.original_tokens 
               or result.compressed.length >= result.original.length:
                return { text, strategy: "passthrough" }
            return { text: result.compressed, strategy: "kompress" }
        
        case SearchResults:
            if compressors and not compressors.search: return null
            return { text: compressSearch(text, undefined, store), strategy: "search_compressor" }
        
        case BuildOutput:
            if compressors and not compressors.log: return null
            return { text: compressLog(text, undefined, store), strategy: "log_compressor" }
        
        case GitDiff:
            if compressors and not compressors.diff: return null
            return { text: compressDiff(text, undefined, store), strategy: "diff_compressor" }
        
        default:
            return { text, strategy: "passthrough" }
```

#### `compressPart()` — Used by `applyCompressionToMessages` (lines 224-271)

Adds `min_tokens_to_compress` check and catch-all error handling:

```
async function compressPart(text, cfg, store, cache, compressors):
    tokensBefore = countTokensSync(text)
    
    if tokensBefore < cfg.min_tokens_to_compress:
        return { text, strategy: "passthrough_small", tokens_before, tokens_after: tokens_before, didCompress: false }
    
    if cache?.isSkipped(text):
        return { text, strategy: "passthrough_skip_cache", ... }
    
    if cache:
        cached = cache.get(text)
        if cached: return { text: cached.compressed, strategy: cached.strategy, ..., didCompress: true }
    
    try:
        detection = detectContentType(text)
        dispatchResult = await dispatchCompressor(text, detection.content_type, store, compressors)
        tokensAfter = countTokensSync(compressed)
        
        if tokensAfter >= tokensBefore or compressed === text:
            if cache: cache.markSkip(text)
            return { text, strategy: "passthrough_revert", ..., didCompress: false }
        
        if cache: cache.put(text, compressed, ratio, strategy)
        return { text: compressed, strategy, ..., didCompress: true }
    catch:
        if cache: cache.markSkip(text)
        return { text, strategy: "passthrough_error", ..., didCompress: false }
```

#### `applyCompressionToMessages()` — Message Iterator (lines 181-222)

Iterates over all messages in the conversation, applying compression to
tool result outputs (`type: "tool"`) and large text parts (`type: "text"`).
Uses `findLiveZoneStart` to skip messages before the last user message
when `live_zone_only` is enabled.

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `enabled` | `true` | `boolean` | **Yes** (`enabled` in `opencode.json`) | Master on/off for the entire plugin |
| `min_tokens_to_compress` | 200 | `number` | **Yes** (`min_tokens_to_compress` in `opencode.json`) | Minimum estimated token count to attempt compression |
| `live_zone_only` | `true` | `boolean` | **Yes** (`live_zone_only` in `opencode.json`) | Only compress messages after the last user message |
| `real_time` | `true` | `boolean` | **Yes** (`real_time` in `opencode.json`) | Enable `tool.execute.after` real-time compression hook |
| `verbose` | `false` | `boolean` | **Yes** (`verbose` in `opencode.json`) | Enable verbose logging |
| `compressors.*` (5 toggles) | all `true` | `boolean` | **Yes (toggle only)** | Per-compressor enable/disable (see individual compressor sections) |

### Edge Cases

- **Empty text →** `compressBlock` returns `null` (line 85)
- **All compressors disabled for a type →** `dispatchCompressor` returns `null` → passthrough
- **Mixed-content compression partially fails →** failed sections passthrough, successful sections compress, total may still shrink → pass
- **Mixed-content total doesn't shrink →** `totalAfter >= text.length` → mark skip, return null
- **Compressed output identical to input →** `compressed === text` → mark skip, return null
- **Exception in any compressor →** caught by `compressPart` catch block → mark skip, passthrough_error
- **Cache hit returns stale compression →** token re-verified on cache hits (defense in depth)

### Token-Monotone Guarantee

This is the **central invariant of the entire plugin**, enforced in three places:

1. **`compressBlock` line 155:** `if (tokensAfter >= tokensBefore) { cache.markSkip(text); return null }`
2. **`compressPart` line 261:** `if (tokensAfter >= tokensBefore || compressed === text) { cache.markSkip(text); return passthrough_revert }`
3. **Each compressor internally** (SmartCrusher line 152, LogCompressor line 105, etc.) — double-checks that compressed output is shorter

The non-compressible content hash is added to the cache skip set so it never
attempts compression again within the TTL window.

---

## 15. CCR Store

**Source:** `src/ccr/store.ts:1-92` + `src/ccr/hash.ts:1-28`

### Overview

The CCR (Content-Centric Retrieval) Store provides reversibility: when content
is compressed, the original is stored keyed by a SHA-256 hash, and the compressed
output includes a `<<ccr:HASH>>` marker. The LLM can then call the
`headroom_retrieve` tool to fetch the full original content.

The store uses `bun:sqlite` with WAL mode and TTL-based automatic purging.

### Headroom Reference

- `headroom-core/src/ccr/backends/sqlite.rs:1-150` — Rust SQLite backend
- `headroom/ccr/batch_store.py:1-200` — Python batch store
- **Note:** Headroom uses BLAKE3; this port uses SHA-256 (see `docs/discrepancy.md` §1)

### Algorithm

#### Hash Derivation (`src/ccr/hash.ts`, lines 8-10)

```
HASH_ALGORITHM = "sha256"

function deriveKey(payload):
    return crypto.createHash("sha256")
        .update(payload, "utf8")
        .digest("hex")
        .slice(0, 24)
```

SHA-256 → first 24 hex chars = 96 bits. The hash is deterministic: same
content always produces the same key.

#### CCR Marker Parsing (lines 12-24)

```
function extractCcrHashes(text):
    hashes = []
    start = text.indexOf("<<ccr:")
    while start !== -1:
        end = text.indexOf(">>", start + 6)
        if end === -1: break
        hashes.push(text.slice(start + 6, end))
        start = text.indexOf("<<ccr:", end + 2)
    return hashes
```

#### Store Lifecycle (`src/ccr/store.ts`)

**Constructor (lines 37-48):**
```
constructor(config):
    resolved = resolveConfig(config)  // defaults: capacity=1000, ttl=300s, path=":memory:"
    db = new Database(resolved.path)
    db.run(CREATE TABLE IF NOT EXISTS ccr_entries (
        hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    ))
    db.run("PRAGMA journal_mode=WAL")
```

WAL mode for concurrent reads during writes. By default, uses `:memory:` — an
in-memory SQLite database. Set `ccr_db_path` in `opencode.json` for persistence.

**Put (lines 50-63):**
```
put(hash, payload):
    purge()  // remove expired entries
    count = size()
    if count >= capacity:
        toEvict = ceil(capacity × 0.1)   // evict oldest 10%
        db.run("DELETE FROM ccr_entries WHERE hash IN 
                (SELECT hash FROM ccr_entries ORDER BY created_at ASC LIMIT ?)", [toEvict])
    db.run("INSERT OR REPLACE INTO ccr_entries (hash, payload, created_at) 
            VALUES (?, ?, unixepoch())", [hash, payload])
```

When capacity is reached, the oldest 10% of entries are evicted before
inserting. This is a simple circular buffer strategy.

**Get (lines 66-73):**
```
get(hash):
    row = db.query(
        "SELECT payload FROM ccr_entries 
         WHERE hash = ? AND created_at > unixepoch() - ?",
        [hash, ttl_seconds]
    ).get(hash)
    return row?.payload ?? null
```

TTL check is in the SQL query itself — expired entries are invisible to `get()`
even before the next `purge()` call.

**Purge (lines 87-91):**
```
private purge():
    db.run("DELETE FROM ccr_entries WHERE created_at < unixepoch() - ?", [ttl_seconds])
```

### Parameters

| Parameter | Default | Type | Configurable? | Description |
|-----------|---------|------|---------------|-------------|
| `capacity` | 1000 | `number` | **Yes** (via `CcrStoreConfig` constructor arg) | Maximum number of entries before eviction |
| `ttl_seconds` | 300 (5 min) | `number` | **Yes** (via `ttl_seconds` or `ttlMs`) | Entry expiry in seconds |
| `path` | `":memory:"` | `string` | **Yes** (via `path` or `dbPath`) — maps to `ccr_db_path` in `opencode.json` | SQLite database path |
| Eviction fraction | 0.1 | `number` | **No — code constant** | Fraction of capacity evicted when full |
| Hash algorithm | SHA-256 | `string` | **No — code constant** | Hash function for key derivation |
| Hash length | 24 hex chars | `number` | **No — code constant** | Truncation of hash digest |

### Example

**Store flow:**
```
Step 1: SmartCrusher compresses a 5000-line JSON array to 28 items
        → deriveKey(full_json) = "a1b2c3d4e5f6a7b8c9d0e1f2"
        → store.put("a1b2c3d4e5f6a7b8c9d0e1f2", full_json_string)

Step 2: Compressed output includes:
        [... 4972 items omitted — retrieve with <<ccr:a1b2c3d4e5f6a7b8c9d0e1f2>>]

Step 3: LLM calls headroom_retrieve tool with hash "a1b2c3d4e5f6a7b8c9d0e1f2"
        → store.get("a1b2c3d4e5f6a7b8c9d0e1f2") returns full 5000-line JSON
```

### Edge Cases

- **`:memory:` database →** data lost on process exit; use `ccr_db_path` for persistence
- **Hash collision →** SHA-256 truncated to 24 chars. Security property: if we insert different
  content with the same hash, `INSERT OR REPLACE` overwrites the previous entry. Non-security
  impact: the LLM retrieves the wrong content. Probability negligible.
- **Store at capacity + 1 →** oldest 10% evicted, then insert
- **TTL expired between put and get →** `get()` returns null (expiry in query)
- **Purge called on empty store →** no-op
- **Concurrent get/put →** WAL mode handles concurrent readers; single event loop prevents
  write-write conflicts
- **Database file not writable →** constructor throws; plugin fails to load

### Token-Monotone Guarantee

The CCR Store does not compress — it stores originals. The token-monotone
invariant is enforced by the compressors that write to it. The `<<ccr:HASH>>`
marker is always shorter than the omitted content (24 chars vs thousands of
bytes), so the compressed output with marker is always token-monotone when
the compressor's own check passes.

---

## Appendix A: Token Counting

**Source:** `src/util/tokens.ts:1-33`

Headroom uses two token counting strategies:

| Method | Function | Accuracy | Performance |
|--------|----------|----------|-------------|
| **Async tiktoken** | `countTokens(text)` | Exact (cl100k_base) | Slow — lazy loads `js-tiktoken` |
| **Sync char/4** | `countTokensSync(text)` | ~±25% estimate | Instant |

The synchronous estimator is used for the token-monotone guard in the hot path
(`compressBlock`, `compressPart`). Formula:

$$T_{\text{est}} = \lceil \frac{\text{len}(text)}{4} \rceil$$

This is conservative: English text averages ~4 chars/token, so the estimate
overestimates tokens for code (which has more short tokens per char). Since we
compare `tokens_after < tokens_before` and overestimating the "after" count
makes the comparison stricter, the char/4 estimator is safe for the monotone
invariant.

The async tiktoken counter is used for the `headroom_stats` tool where accuracy
matters for reporting.

---

## Appendix B: Content Type Reference

| Type Constant | Value | Compressor | Description |
|---------------|-------|------------|-------------|
| `JsonArray` | `"json_array"` | SmartCrusher | JSON array of objects/values |
| `SourceCode` | `"source_code"` | None (passthrough) | Source code in any language |
| `SearchResults` | `"search"` | SearchCompressor | grep/ripgrep output |
| `BuildOutput` | `"build"` | LogCompressor | Build logs, test output, error logs |
| `GitDiff` | `"diff"` | DiffCompressor | Git unified/combined diffs |
| `Html` | `"html"` | None (passthrough) | HTML documents |
| `PlainText` | `"text"` | None (passthrough) | Unstructured text |
| `Prose` | `"prose"` | KompressCompressor | Multi-sentence natural language |

---

## Appendix C: opencode.json Configuration

All user-facing configuration lives in the plugin options under `opencode.json`:

```json
{
  "plugins": [
    {
      "name": "opencode-headroom",
      "options": {
        "enabled": true,
        "min_tokens_to_compress": 200,
        "live_zone_only": true,
        "real_time": true,
        "verbose": false,
        "cache_align": true,
        "ccr_db_path": "/path/to/persistent/ccr.db",
        "compressors": {
          "smart_crusher": true,
          "log": true,
          "search": true,
          "diff": true,
          "kompress": true
        }
      }
    }
  ]
}
```

---

*Document generated from source: `contrib/opencode-headroom/src/`. Last updated: 2026-06-10.*
