// ─── Regex patterns used for cache-alignment normalization ────────────────
//
// Order: UUIDs first (contain hyphens, won't overlap with session IDs).
// Timestamps before dates (timestamps contain date substrings).
// Session IDs last (≥32 hex chars, won't match UUIDs which have hyphens).

export const NORMALIZATION_PATTERNS: Record<string, RegExp> = {
  UUID: /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi,
  TIMESTAMP: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gi,
  DATE: /\b\d{4}-\d{2}-\d{2}\b/gi,
  SESSION_ID: /\b[\da-f]{32,}\b/gi,
} as const

// ─── Normalization order: UUID → TIMESTAMP → DATE → SESSION_ID ──────────

const REPLACEMENT_ORDER = [
  { key: "UUID", replacement: "<<UUID>>" },
  { key: "TIMESTAMP", replacement: "<<TIMESTAMP>>" },
  { key: "DATE", replacement: "<<DATE>>" },
  { key: "SESSION_ID", replacement: "<<SESSION_ID>>" },
] as const

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Normalize dynamic tokens in a system prompt string to improve
 * LLM provider KV cache hit rates.
 *
 * Replaces UUIDs, ISO 8601 timestamps, ISO dates, and long hex session/request
 * IDs with stable placeholder tokens.
 *
 * Fail-open: if normalization throws, the original string is returned unchanged
 * with `changed: false`.
 */
export function normalizeSystemPrompt(text: string): {
  normalized: string
  changed: boolean
} {
  try {
    let result = text
    for (const { key, replacement } of REPLACEMENT_ORDER) {
      const pattern = NORMALIZATION_PATTERNS[key]
      result = result.replace(pattern, replacement)
    }
    const changed = result !== text
    return { normalized: result, changed }
  } catch {
    return { normalized: text, changed: false }
  }
}
