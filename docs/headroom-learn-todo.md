# headroom-learn — Design & Implementation TODO

Deferred feature from headroom v0.24.0: a **failure-mining and prompt-correction**
system that analyzes completed agent sessions, identifies failure patterns, and
writes structured corrections to project agent files (`AGENTS.md`, `CLAUDE.md`).

---

## 1. What headroom-learn does (reference)

From `headroom/learn/` (Python, ~1200 LOC):

1. **Session ingestion:** Reads completed agent session logs (Claude Code session JSON,
   Codex session traces, opencode session directory).
2. **Failure mining:** Scans for specific failure patterns:
   - Tool permission errors (missing `allowedTools`, denied patterns)
   - Repeated retries on the same operation (>3 attempts)
   - Tool call loops (>10 calls without user message)
   - Compression feedback signals (CCR retrieval patterns → tune the compressor)
   - Manual user corrections ("no, do X instead" → extract the correction)
3. **Correction writing:** Appends structured entries to the project's agent file:
   ```markdown
   <!-- HEADROOM-LEARN: 2026-06-10T14:30:00Z -->
   - When reading package.json, always use `Schema.parseJson` not `JSON.parse`
   - Never call `rm -rf node_modules` without user confirmation
   <!-- /HEADROOM-LEARN -->
   ```
4. **Plugin system:** Per-agent plugins (one for each supported agent) that know each
   agent's session format and idiom.

---

## 2. Why it matters for opencode

openCode sessions accumulate in `.opencode-workspace/sessions/` with full message
history, tool call traces, and session metadata. A post-hoc analysis could:

- **Detect recurring mistakes** the LLM makes with particular tools (e.g., forgetting
  `--target=bun` when building, using `cat` instead of `read`).
- **Tune headroom's compression** based on what the LLM actually retrieves via CCR
  (if the LLM never retrieves search results, compress them more aggressively).
- **Write corrections** to `AGENTS.md` in the project directory, making the next
  session smarter without human intervention.

---

## 3. opencode Integration Points

### 3.1 Session data available

| Source | What's in it |
|---|---|
| `.opencode-workspace/sessions/<id>/` | Full message array (JSON), tool call history, model responses |
| `.opencode-workspace/data/opencode/` | SQLite session DBs with metadata |
| Project `AGENTS.md` | Instructions the LLM already reads |

### 3.2 Plugin approach

Standalone plugin (`@ngotrnghia1811/opencode-headroom-learn`) or a mode within
`opencode-headroom` (gated by `learn.enabled: true`):

```
opencode-headroom (session)
    │
    ├─ compress (real-time + batch)
    ├─ CCR store
    │
    └─ learn subsystem ── POST-SESSION ──► AGENTS.md
         │
         ├─ Mine .opencode-workspace/sessions/latest/
         ├─ Check headroom_stats for compression patterns
         └─ Write structured corrections if needed
```

### 3.3 Hook: `event` hook for session lifecycle

```ts
"event": async (input: { event: Event }) => {
  if (event.type === "session.end") {
    await mineSession(event.sessionID)
  }
}
```

---

## 4. Failure Taxonomy (to implement)

### 4.1 Permission failures

Pattern: `Tool.execute` returns "permission denied" or `context.ask()` was denied.

Correction: `AGENTS.md` entry recommending the necessary permission.

### 4.2 Retry loops

Pattern: Same tool with identical args called >3 times in a row without user message.

Correction: `AGENTS.md` entry with the correct invocation pattern.

### 4.3 Compression feedback

Pattern: `headroom_retrieve` called on a CCR hash → the LLM actually needed the
compressed content. Record the content type and ratio for tuning.

Correction: Adjust `min_tokens_to_compress` or compressor thresholds.

### 4.4 User corrections

Pattern: User message contains "no, ...", "actually ...", "correct: ...", "wrong",
"fix that" with no code changes — just directive language.

Correction: Extract the semantic correction and add to `AGENTS.md`.

---

## 5. Implementation Plan

### Phase 1: Session Reader

- `src/learn/session-reader.ts` — read `.opencode-workspace/sessions/<id>/` directory
- Parse message JSON, tool call history, extract timestamps + tool name + args + result
- Return structured `SessionTrace`

### Phase 2: Failure Miners (4 miners)

Each miner is a `(trace: SessionTrace) => Finding[]` function:

| Miner | Detects | Priority |
|---|---|---|
| `PermissionMiner` | Denied tool calls | High |
| `RetryMiner` | 3+ identical calls without user intervention | Medium |
| `CompressionMiner` | CCR retrieval patterns | Low |
| `CorrectionMiner` | User directive messages | Medium |

### Phase 3: AGENTS.md Writer

- `src/learn/writer.ts` — append/merge HEADROOM-LEARN sections into `AGENTS.md`
- Respect existing structure (don't rewrite unrelated content)
- Deduplicate: if the same correction already exists, update timestamp only
- Format: `<!-- HEADROOM-LEARN: ISO_TS -->` markers with bullet entries

### Phase 4: Integration

- Wire into the `event` hook in the plugin index
- Gate with `learn.enabled: true` config option
- Add `headroom_learn_stats` tool for the LLM to check what was learned

---

## 6. Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Standalone plugin or mode? | Mode (within opencode-headroom) | Shares CCR store and stats; no separate package needed |
| AGENTS.md format | `<!-- HEADROOM-LEARN: ... -->` comments | Non-intrusive — doesn't break existing markdown |
| Dedup strategy | Hash the correction text; if exists, skip | Avoids accumulating the same advice |

---

## 7. Open Questions

1. **Session JSON format** — the exact structure of opencode session files needs
   reverse-engineering. A session dump tool (`opencode session dump <id>`) would help.

2. **When does `session.end` fire?** — Need to verify this event exists in the opencode
   plugin system and fires reliably on session termination (including crashes).

3. **Correction quality** — extracting semantic intent from "no, do X instead" is an
   NLP problem. A simple regex approach may have high false-positive rates. Consider
   using the LLM itself to summarize corrections (meta-loop).

4. **Scope of AGENTS.md edits** — should corrections be written into the project's
   `AGENTS.md` or into a separate `.opencode/learned-corrections.md`? The project file
   has higher impact but risks cluttering it.

---

## 8. Reference

- `headroom/learn/` (Python) — `core.py`, `plugins/claude.py`, `plugins/codex.py`
- `headroom/learn/writer.py` — AGENTS.md/CLAUDE.md writing logic
- `headroom/learn/miners/` — failure pattern detectors

---

*Created: 2026-06-10*
