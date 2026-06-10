# opencode-headroom

Context compression plugin for [opencode](https://opencode.ai). Reduces token usage 60–95% on large tool outputs, logs, diffs, and search results — without losing the information the LLM needs.

Port of [headroom v0.24.0](https://github.com/chopratejas/headroom) into the opencode plugin system.

---

## What it does

When opencode tools return large outputs (file reads, grep results, build logs, git diffs, JSON arrays), this plugin compresses them before they reach the LLM. The original content is cached locally so the LLM can retrieve it on demand via `headroom_retrieve`.

```
tool output (10 000 tokens)
  │
  ├─ ContentDetector: "this is a build log"
  ├─ LogCompressor: keep errors + first/last lines, deduplicate repeats
  │    → 800 tokens + <<ccr:2519ab63b8962b3998425b08>> marker
  │
  └─ LLM sees 800 tokens instead of 10 000
       If LLM needs more: headroom_retrieve("2519ab63b8962b3998425b08") → full log
```

---

## Compression components

| Compressor | Triggers on | Technique |
|---|---|---|
| **SmartCrusher** | JSON arrays | Adaptive K via Kneedle algorithm + BM25 relevance scoring; keeps first/last anchors |
| **LogCompressor** | Build / test output | Deduplication, keep errors/warnings/first/last lines |
| **SearchCompressor** | grep / ripgrep output | Per-file collapse, sampled middle lines |
| **DiffCompressor** | Unified git diffs | Keeps headers + change lines, drops context beyond threshold |
| **CacheAligner** | System prompt (every LLM call) | Normalizes UUIDs / timestamps / session IDs to stabilize KV cache prefix |

---

## Installation

Add the plugin path (or npm package name once published) to your opencode config:

```json
// opencode.json  or  .opencode/opencode.json
{
  "plugin": ["/path/to/contrib/opencode-headroom"]
}
```

Or with options:

```json
{
  "plugin": [
    ["/path/to/contrib/opencode-headroom", {
      "enabled": true,
      "min_tokens_to_compress": 200,
      "live_zone_only": true,
      "real_time": true,
      "cache_align": true,
      "verbose": false,
      "ccr_db_path": "/tmp/headroom-ccr.db"
    }]
  ]
}
```

---

## Configuration options

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch — set `false` to disable all compression |
| `min_tokens_to_compress` | `200` | Skip compression for outputs smaller than this token count |
| `live_zone_only` | `true` | Only compress the latest user message + tool results (safe for provider KV cache) |
| `real_time` | `true` | Compress each tool result immediately via `tool.execute.after` hook |
| `cache_align` | `true` | Normalize system prompt dynamic tokens for KV cache stability |
| `verbose` | `false` | Log compression events to stdout |
| `ccr_db_path` | *(in-memory)* | Path to SQLite file for persistent CCR storage across sessions |

---

## Tools provided

### `headroom_retrieve`

Retrieves the original (uncompressed) content for a CCR hash marker.

The LLM automatically receives instructions to call this tool when it sees a `<<ccr:HASH>>` marker in a compressed output.

```
headroom_retrieve(hash: "2519ab63b8962b3998425b08")
→ [original full content]
```

### `headroom_stats`

Returns compression statistics for the current session.

```
headroom_stats()
→ {
    "messages_processed": 12,
    "tokens_consumed": 45000,
    "tokens_saved": 38000,
    "savings_pct": 84.4,
    "compressor_hits": {
      "log": 5,
      "json_array": 3,
      "diff": 2,
      "search": 2
    }
  }
```

---

## How CCR (Compress-Cache-Retrieve) works

1. **Compress**: content is reduced (e.g. 1000-item JSON array → 30 items)
2. **Cache**: original bytes stored in SQLite with SHA-256 derived 24-hex key; TTL 5 min
3. **Marker**: `<<ccr:HASH>>` injected into the compressed output
4. **Retrieve**: LLM calls `headroom_retrieve(hash)` → gets original back
5. **Feedback**: retrieval patterns improve future compression decisions

The CCR store is fail-open: if a hash expires or the store is cleared, `headroom_retrieve` returns a helpful "content expired" message rather than throwing.

---

## Invariants (always maintained)

1. **Fail-open** — any compression error falls back to original content; never an exception
2. **Token-monotone** — if compressed output ≥ original tokens, the original is used instead
3. **Live-zone-only** — only the latest user message + latest tool results are compressed; cached message history is never modified (safe for provider KV cache)
4. **Append-only** — once a message enters history, its bytes are frozen

---

## Project structure

```
src/
  index.ts              ← Plugin entrypoint (server export)
  config.ts             ← HeadroomOptions, parseOptions()
  compress/
    content-detector.ts ← 7-type cascade (JSON→Diff→HTML→Search→Log→Code→Text)
    log-compressor.ts
    search-compressor.ts
    diff-compressor.ts
    smart-crusher.ts     ← JSON array compression with Kneedle + BM25
    pipeline.ts          ← Orchestrator (history + per-block)
    kneedle.ts           ← Kneedle adaptive-K algorithm + SimHash + zlib validation
    relevance.ts         ← BM25 relevance scoring for middle-item selection
    cache-aligner.ts     ← System prompt normalization (UUIDs, timestamps, session IDs)
    types.ts
  ccr/
    hash.ts              ← SHA-256 key derivation, CCR marker helpers
    store.ts             ← CcrStore (bun:sqlite, capacity eviction, TTL)
  tool/
    retrieve.ts          ← headroom_retrieve tool
    stats.ts             ← headroom_stats tool, SessionStats, recordCompression()
  util/
    tokens.ts            ← js-tiktoken async counter + char/4 fallback
  test/                  ← 115 unit tests
```

---

## Development

```bash
# Run all tests
bun test

# Typecheck
bun run typecheck

# Build check
bun build src/index.ts --target=bun --outfile=/dev/null
```

---

## Reference

Based on [headroom v0.24.0](https://github.com/chopratejas/headroom) — Apache 2.0 license.
The algorithms ported:
- SmartCrusher with Kneedle adaptive-K (from `headroom-core/src/transforms/smart_crusher/`)
- SimHash bigram diversity (from `headroom-core/src/transforms/smart_crusher/adaptive_sizer.rs`)
- ContentDetector cascade (from `headroom-core/src/transforms/content_detector.rs`)
- LogCompressor, SearchCompressor, DiffCompressor (from `headroom-core/src/transforms/`)
- CacheAligner (from `headroom/transforms/cache_aligner.py`)
- CCR with SQLite backend (from `headroom-core/src/ccr/`)
