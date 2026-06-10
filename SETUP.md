# opencode-headroom — Setup Guide

Context compression plugin for [opencode](https://opencode.ai). Reduces token usage 60–95% on large tool outputs, logs, diffs, and search results by compressing them before they reach the LLM. Original content is cached locally (CCR) so the LLM can retrieve it on demand.

Port of [headroom v0.24.0](https://github.com/chopratejas/headroom) into the opencode plugin system.

---

## 1. Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| **Bun** | ≥1.0 | Bundled with opencode if installed via `curl` installer |
| **opencode** | ≥0.4.0 | Must support the plugin system (`plugin` field in config) |

If you run opencode via the local dev build (`bun dev` from the `opencode/` directory), Bun is already available — no separate install needed.

---

## 2. Installation

### Option A — Local path (development)

Clone the repo and wire it into your opencode config:

```bash
git clone <opencode-headroom-repo-url> /path/to/opencode-headroom
cd /path/to/opencode-headroom
bun install
```

Then add the absolute path to your opencode config:

```json
// opencode.json  or  .opencode/opencode.json
{
  "plugin": ["/absolute/path/to/opencode-headroom"]
}
```

The path must be **absolute** (starting with `/` on macOS/Linux). Relative paths are resolved against opencode's working directory and may fail silently if the CWD changes.

### Option B — npm (once published)

```bash
bun add opencode-headroom
```

Config:

```json
{
  "plugin": ["opencode-headroom"]
}
```

The plugin name matches the npm package name. opencode resolves it from `node_modules` in the current project.

### With options

Both installation methods support passing configuration inline:

```json
{
  "plugin": [
    ["/path/to/opencode-headroom", {
      "enabled": true,
      "min_tokens_to_compress": 200,
      "live_zone_only": true,
      "real_time": true,
      "cache_align": true,
      "verbose": false,
      "ccr_db_path": "~/.local/share/opencode/headroom-ccr.db"
    }]
  ]
}
```

When using npm, replace the path with the package name:
```json
{ "plugin": [["opencode-headroom", { "verbose": true }]] }
```

---

## 3. Verification

Confirm the plugin is loaded and active:

1. **Start an opencode session** with the plugin config in place.
2. **Call `headroom_stats`** from the session — it should return a valid JSON object:
   ```json
   {
     "messages_processed": 0,
     "tokens_consumed": 0,
     "tokens_saved": 0,
     "savings_pct": 0,
     "compressor_hits": {}
   }
   ```
   If the tool is not visible, the plugin is not loaded — see [Troubleshooting](#11-troubleshooting).
3. **Trigger compression** by running a tool that produces large output (e.g. `cat` a 500+ line JSON file, or `rg` against a large codebase). Then call `headroom_stats` again — `messages_processed` and `tokens_saved` should be non-zero.
4. **Verbose logging** — set `"verbose": true` in the plugin options. When compression occurs, you'll see console output like:
   ```
   [headroom] compressed 3200 tokens via: smart_crusher, log_compressor
   ```

---

## 4. Configuration Reference

All options are optional. Omitted options use their defaults.

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch. Set to `false` to disable all compression without removing the plugin from config. |
| `min_tokens_to_compress` | `number` | `200` | Skip compression for outputs smaller than this token count. Prevents overhead on small payloads. |
| `live_zone_only` | `boolean` | `true` | Only compress messages from the most recent user message onward. Older (cached) history is left untouched — safe for LLM provider KV caching. |
| `real_time` | `boolean` | `true` | Compress each tool result immediately via the `tool.execute.after` hook, before it enters the message history. |
| `cache_align` | `boolean` | `true` | Normalize dynamic tokens (UUIDs, timestamps, hex session IDs) in the system prompt to improve KV cache hit rates. |
| `verbose` | `boolean` | `false` | Log compression events to stdout: `[headroom] compressed N tokens via: strategy1, strategy2`. |
| `ccr_db_path` | `string` | *(in-memory)* | Path to a SQLite file for persistent CCR storage across sessions. Use an absolute path (e.g. `~/.local/share/opencode/headroom.db`). When unset, CCR entries live in `:memory:` and are lost on session end. |

### Full config example

```json
{
  "plugin": [
    ["opencode-headroom", {
      "enabled": true,
      "min_tokens_to_compress": 200,
      "live_zone_only": true,
      "real_time": true,
      "cache_align": true,
      "verbose": true,
      "ccr_db_path": "~/.local/share/opencode/headroom-ccr.db"
    }]
  ]
}
```

---

## 5. How It Works

The plugin hooks into three opencode extension points. Together they intercept tool output, batch-compress message history before each LLM call, and stabilize the system prompt prefix.

```
[Tool executes]
     │
     ├─ tool.execute.after → real-time single-result compression
     │   (if real_time: true)
     │
[Messages accumulate in session]
     │
     ├─ experimental.chat.messages.transform → batch compression
     │   of live-zone messages before each LLM call
     │
[System prompt]
     │
     └─ experimental.chat.system.transform → normalize
         UUIDs, timestamps, session IDs for KV cache stability
         (if cache_align: true)
```

### Hook 1: `tool.execute.after` (real-time)

Each time a tool completes, this hook inspects the output. If the output exceeds `min_tokens_to_compress` tokens:
1. The ContentDetector classifies the output type.
2. The matching compressor reduces the content.
3. The original is stored in the CCR cache with a `<<ccr:HASH>>` marker.
4. The compressed version replaces the tool output in-place before it enters the message history.

This is the lowest-latency path — compression happens once, immediately.

### Hook 2: `experimental.chat.messages.transform` (batch)

Before each LLM API call, this hook scans the message array:
1. Identifies the **live zone** — messages from the most recent user message onward (if `live_zone_only: true`).
2. For each tool result or large text part in the live zone, dispatches to ContentDetector → compressor.
3. Mutates `output.messages` in place.
4. Logs a summary line if `verbose: true`.

Token-monotone invariant: if compression doesn't actually reduce token count, the original is kept.

### Hook 3: `experimental.chat.system.transform` (cache alignment)

Before the system prompt reaches the LLM, this hook normalizes dynamic tokens that would otherwise break KV cache prefix stability:
- **UUIDs** → `<<UUID>>`
- **ISO 8601 timestamps** (e.g. `2026-06-10T14:30:00Z`) → `<<TIMESTAMP>>`
- **ISO dates** → `<<DATE>>`
- **Long hex session/request IDs** (≥32 hex chars) → `<<SESSION_ID>>`

The prompt content is modified so the LLM sees placeholders instead of every-request-unique tokens. This lets the provider's KV cache reuse the prefix across turns.

### Invariants

All three hooks maintain these guarantees:

1. **Fail-open** — any compression error falls back to the original content. The session never breaks because of a compression bug.
2. **Token-monotone** — if the compressed output has ≥ tokens as the original, the original is used instead.
3. **Live-zone-only** — when `live_zone_only: true`, only the latest user message and subsequent tool results are compressed. Cached history prefix is never modified.
4. **Append-only** — once a message enters the frozen zone (before the most recent user message), its content is immutable.

---

## 6. Compressor Overview

The ContentDetector classifies each text block into one of seven content types and routes it to the appropriate compressor. Detected types that have no compressor (PlainText, HTML, SourceCode) pass through unchanged.

| Compressor | Triggers on | Technique | Example output shape |
|---|---|---|---|
| **SmartCrusher** | JSON arrays (≥10 items) | Kneedle adaptive-K algorithm + BM25 relevance scoring. Keeps first 30%, last 15%, fills remainder with highest-diversity items. Dedup by identity. | `[{...}, {...}, ...]\n// [850 items omitted — retrieve with <<ccr:a1b2c3...>>]` |
| **LogCompressor** | Build / test / lint output | 5-stage: format detection → line parsing (ERROR/FAIL/WARN/INFO) → scoring → first/last error selection + top warnings + stack traces + summaries → adaptive K cap. Dedup normalizes variable suffixes (digits→N, hex→ADDR). | Error lines + stack traces + `[... 243 lines omitted: 45 ERROR, 12 WARN]` |
| **SearchCompressor** | grep / ripgrep output | Parse `file:line:match` triples. Per-file: keep first + last match, fill to `max_matches_per_file` (5) by relevance score. Global cap: 20 files, 100 total matches. Omits remaining with summary. | Select matches + `[... 42 more matches in src/index.ts]` + `[... 3 more files with matches omitted]` |
| **DiffCompressor** | Unified git diffs | Structured parser: files → hunks → lines. Keeps file headers, hunk markers, all `+`/`-` lines, and `max_context_lines` (3) of context around changes. Caps hunks/file (10) and files (10). Drops context-only lines. | Condensed diff with `[... 15 context lines dropped]` markers |
| **CacheAligner** | System prompt (every call) | Regex-based normalization: UUID → `<<UUID>>`, ISO 8601 → `<<TIMESTAMP>>`, hex session IDs → `<<SESSION_ID>>`. Order: UUIDs first, then timestamps, dates, session IDs. | System prompt with stable placeholder tokens |

### ContentDetector cascade

Detection runs in priority order — more distinctive formats checked first:

| Priority | Content type | Detection signal |
|---|---|---|
| 1 | JSON array | `JSON.parse` succeeds, result is array. Confidence 1.0 for object arrays, 0.8 for others. |
| 2 | Diff | `diff --git`, `@@` hunk headers, `+`/`-` change lines. Confidence from header+change counts. |
| 3 | HTML | `<!doctype html>`, `<html>`, structural tags. Confidence from weighted sum. |
| 4 | Search results | `file:line:` pattern on ≥30% of non-empty lines. |
| 5 | Build/log | ERROR/WARN/INFO keywords, timestamps, stack traces on ≥10% of lines. |
| 6 | Source code | Language-specific patterns (Python/JS/TS/Go/Rust/Java) on ≥3 matches. |
| 7 | PlainText | Fallback. Confidence 0.5. No compression applied. |

---

## 7. CCR (Compress-Cache-Retrieve)

CCR makes compression reversible. When a compressor drops data, the original is cached in a local SQLite store keyed by a SHA-256-derived hash. The LLM can retrieve it on demand.

### Lifecycle

1. **Compress**: SmartCrusher keeps 30 of 1000 JSON items.
2. **Cache**: Original 1000-item JSON stored in SQLite with hash `2519ab63b8962b3998425b08`.
3. **Marker**: `// [970 items omitted — retrieve with <<ccr:2519ab63b8962b3998425b08>>]` appended to output.
4. **LLM sees**: 30 items + the marker.
5. **Retrieve**: LLM calls `headroom_retrieve("2519ab63b8962b3998425b08")` → gets the full original.
6. **Decision**: Most of the time, the LLM solves the task without retrieval. CCR is the safety net.

### Store details

| Property | Value |
|---|---|
| **Backend** | `bun:sqlite` (built into Bun) |
| **Hash algorithm** | SHA-256, truncated to first 24 hex chars |
| **Default TTL** | 300 seconds (5 minutes) from insertion time |
| **Capacity** | 1000 entries |
| **Eviction** | 10% LRU when capacity exceeded + TTL purge on every write |
| **Journal mode** | WAL (Write-Ahead Logging) |
| **Default storage** | `:memory:` (in-process, lost on session end) |
| **Persistence** | Set `ccr_db_path` to a file path for cross-session storage |

### TTL behavior

Entries are checked on **read** (lazy expiry) and purged on **write** (proactive cleanup). An entry inserted at T+0s will be retrievable until T+300s. After that, `headroom_retrieve` returns:

> No cached content found for hash 2519ab63b8962b3998425b08. The entry may have expired (TTL: 5 minutes) or the hash is invalid.

For sessions longer than 5 minutes, use `ccr_db_path` to persist entries. Note: TTL still applies within a single session — the persistent store doesn't extend the 5-minute window unless the code is modified. For most coding sessions this is sufficient since CCR retrieval typically happens within seconds of compression.

---

## 8. Tools Reference

The plugin registers two tools available to the LLM in-session:

### `headroom_stats`

**Description**: Returns compression statistics for the current session.

**Arguments**: None.

**Example output**:

```json
{
  "messages_processed": 3,
  "tokens_consumed": 12500,
  "tokens_saved": 9200,
  "savings_pct": 73.6,
  "compressor_hits": {
    "smart_crusher": 2,
    "log_compressor": 1
  }
}
```

| Field | Description |
|---|---|
| `messages_processed` | Number of message parts that were inspected for compression. |
| `tokens_consumed` | Sum of original token counts across all inspected parts. |
| `tokens_saved` | Total tokens saved (original − compressed). |
| `savings_pct` | `(tokens_saved / tokens_consumed) × 100`, rounded to 2 decimal places. |
| `compressor_hits` | Per-compressor hit count. Keys are strategy names: `smart_crusher`, `log_compressor`, `search_compressor`, `diff_compressor`. |

If the session just started and no compression has occurred, all counters are zero.

### `headroom_retrieve`

**Description**: Retrieve the original (uncompressed) content for a `<<ccr:HASH>>` marker. Use when a compressed tool output has a CCR marker and the full content is needed.

**Arguments**:

| Argument | Type | Description |
|---|---|---|
| `hash` | `string` | 24-character hex hash from a `<<ccr:HASH>>` marker |

**Example call**:
```
headroom_retrieve(hash: "2519ab63b8962b3998425b08")
```

**Success output** (title):
> `CCR Retrieve: 2519ab63...`

The `output` field contains the original full content.

**Failure output** (title):
> `CCR Retrieve: 2519ab63... (not found)`

The `output` field contains:
> `No cached content found for hash 2519ab63b8962b3998425b08. The entry may have expired (TTL: 5 minutes) or the hash is invalid.`

---

## 9. Persistent CCR Storage

### When to use

- **Sessions longer than 5 minutes** — in-memory CCR entries expire after 5 minutes. A persistent store lets earlier compressions remain retrievable.
- **Multi-session continuity** — share the same DB file across sessions for cumulative retrieval (within the TTL window of each session).
- **Debugging** — inspect the SQLite file to see what was compressed and retrieved.

### How to configure

```json
{
  "plugin": [
    ["opencode-headroom", {
      "ccr_db_path": "~/.local/share/opencode/headroom.db"
    }]
  ]
}
```

The `.db` file is auto-created on first write. Bun creates the parent directories automatically.

### .gitignore

If you place the DB file inside a project directory, add it to `.gitignore`:

```gitignore
# headroom CCR database
headroom.db
headroom.db-wal
headroom.db-shm
*.db
*.db-wal
*.db-shm
```

The WAL and SHM files are SQLite WAL-mode companions created alongside the `.db` file.

---

## 10. Differences from headroom v0.24.0

This plugin is a **port**, not a 1:1 clone. Several features from the upstream headroom proxy/CLI are intentionally omitted or adapted for the opencode plugin model.

### Known gaps

| Feature | headroom v0.24.0 | opencode-headroom | Reason |
|---|---|---|---|
| **Hash algorithm** | BLAKE3 (Rust) or MD5 (Python) | SHA-256 (truncated to 24 hex) | Bun/Node.js ships SHA-256 natively. BLAKE3 requires an npm dependency. CCR markers are **not cross-compatible** between headroom and this plugin. |
| **CodeCompressor** | Tree-sitter–based code compression | Not implemented | Tree-sitter grammars add ~50 MB of native bindings. Source code currently passes through unchanged. |
| **KompressCompressor** | ML-based compression model | Not implemented | Requires model weights (~200 MB). Not practical for a Bun plugin. |
| **HTMLCompressor** | HTML-aware compressor | Pass-through | Added complexity for a content type rarely seen in coding-agent tool output. |
| **Relevance scoring** | BM25 only | BM25 only | No embedding model. The upstream proxy optionally uses embeddings for relevance; this plugin keeps BM25 for zero-dependency simplicity. |
| **HTTP proxy mode** | Full intercepting proxy (Rust `tokio` + `hyper`) | Not applicable | Plugin model doesn't need a proxy — hooks are native opencode extension points. |
| **`headroom learn`** | Cross-agent memory consolidation | Not implemented | Requires a separate service. Out of scope for a single-session compression plugin. |
| **Simulation mode** | `headroom simulate` for dry-run testing | Not implemented | Use `bun test` from the plugin directory for equivalent confidence checks. |
| **RTK (Realtime Token Kompress)** | wrap-CLI command rewriting | Not applicable | RTK rewrites shell commands at exec time (e.g. `git diff` → compact form). Plugin hooks don't intercept shell commands — they intercept tool output. |
| **Multi-backend CCR** | In-memory (DashMap), SQLite, Redis | SQLite only (`bun:sqlite`) | `bun:sqlite` is fast ~5 μs/read, synchronous, and zero-config. No Redis dependency needed for a single-user plugin. |

### What's preserved

- All four core compressors: SmartCrusher, LogCompressor, SearchCompressor, DiffCompressor
- Kneedle adaptive-K algorithm (SimHash, bigram curve, knee detection, zlib validation)
- BM25 relevance scoring for SmartCrusher middle-fill
- CCR with SQLite backend, capacity eviction, 5-min TTL, fail-open retrieval
- CacheAligner system prompt normalization
- Token-monotone invariant
- Fail-open invariant
- Live-zone-only invariant

---

## 11. Troubleshooting

### Plugin not loading

**Symptom**: `headroom_stats` is not available in the opencode session.

**Causes and fixes**:

1. **Path is not absolute.** Use an absolute path in the `plugin` array:
   ```json
   // Wrong — relative path
   { "plugin": ["./contrib/opencode-headroom"] }
   // Correct — absolute path
   { "plugin": ["/Users/you/opencode-learn/contrib/opencode-headroom"] }
   ```

2. **Dependencies not installed.** Run `bun install` in the plugin directory:
   ```bash
   cd /path/to/opencode-headroom && bun install
   ```

3. **Plugin exports missing.** The plugin must export `server` from its entry point. Verify `package.json` has:
   ```json
   { "exports": { ".": "./src/index.ts" } }
   ```

4. **opencode version too old.** The plugin system was stabilized around opencode v0.4.0. Run `opencode --version` to check.

5. **Config file location.** opencode reads config from:
   - `opencode.json` (project root)
   - `.opencode/opencode.json` (project-local)
   - `~/.config/opencode/opencode.json` (global)

   Ensure your `plugin` field is in the file opencode is actually reading.

### Compression not triggering

**Symptom**: `headroom_stats` shows zero compression after running large tools.

**Causes and fixes**:

1. **`enabled` is `false`.** Check your plugin options:
   ```json
   { "plugin": [["opencode-headroom", { "enabled": true }]] }
   ```

2. **Output below threshold.** The `min_tokens_to_compress` default is 200. Outputs smaller than this pass through. Try lowering it for testing:
   ```json
   { "min_tokens_to_compress": 50 }
   ```

3. **Content type is PlainText.** The ContentDetector may classify the output as PlainText, which has no compressor. Check `verbose` mode to see what's being detected.

4. **Live zone is empty.** If `live_zone_only: true` and there's no recent user message, the live zone is empty — nothing to compress. Call a tool after a user message.

### CCR entries expiring

**Symptom**: `headroom_retrieve` returns "not found" even though compression occurred recently.

**Causes and fixes**:

1. **TTL expired.** Default TTL is 5 minutes. For sessions where retrieval may happen later, use `ccr_db_path` for persistent storage:
   ```json
   { "ccr_db_path": "~/.local/share/opencode/headroom.db" }
   ```

2. **In-memory store lost.** Without `ccr_db_path`, CCR entries are stored in `:memory:` and lost when the opencode process restarts.

3. **Hash mismatch.** The LLM might be passing a hash from a different session or a malformed marker. Check that the hash is exactly 24 hex characters.

### High memory usage for in-memory CCR

**Symptom**: Bun process memory grows over long sessions.

**Fix**: Use a file-backed SQLite store instead of `:memory:`:
```json
{ "ccr_db_path": "~/.local/share/opencode/headroom.db" }
```

This offloads CCR entries to disk. SQLite reads are ~5 μs — negligible overhead.

### Verbose logging is noisy

**Symptom**: Too many `[headroom]` lines in console output.

**Fix**: Set `verbose: false` (the default) and call `headroom_stats` periodically to check compression statistics instead.

---

## 12. Development

For contributors working on the plugin itself:

```bash
cd /path/to/opencode-headroom
bun install          # Install dependencies (js-tiktoken)
bun test             # Run 115 unit tests
bun run typecheck    # Typecheck (via tsc --noEmit)
```

Project structure:

```
src/
  index.ts              ← Plugin entrypoint (server export)
  config.ts             ← HeadroomOptions, parseOptions()
  compress/
    content-detector.ts ← 7-type cascade (JSON→Diff→HTML→Search→Log→Code→Text)
    log-compressor.ts   ← Build/test log compression
    search-compressor.ts← grep/ripgrep compression
    diff-compressor.ts  ← Unified diff compression
    smart-crusher.ts    ← JSON array compression with Kneedle + BM25
    pipeline.ts         ← Orchestrator (history + per-block)
    kneedle.ts          ← Kneedle adaptive-K + SimHash + zlib validation
    relevance.ts        ← BM25 relevance scoring
    cache-aligner.ts    ← System prompt normalization
    types.ts
  ccr/
    hash.ts             ← SHA-256 key derivation, CCR marker helpers
    store.ts            ← CcrStore (bun:sqlite, capacity eviction, TTL)
  tool/
    retrieve.ts         ← headroom_retrieve tool
    stats.ts            ← headroom_stats tool, SessionStats
  util/
    tokens.ts           ← js-tiktoken async counter + char/4 fallback
  test/                 ← 115 unit tests
```

---

*Last updated: 2026-06-10*
