// ─── BM25 + Hybrid relevance scoring ──────────────────────────────
// Exact port of headroom-core/src/relevance/bm25.rs + hybrid.rs (v0.24.0)
//
// BM25: k1=1.5, b=0.75, max_score=10.0, long-token bonus (+0.3 for ≥8 char match)
// Hybrid: combined = alpha * BM25 + (1 - alpha) * Embedding
//   - Adaptive alpha: UUID/numeric ID/hostname/email patterns increase BM25 weight
//   - BM25 fallback when embedding unavailable: +0.3 floor, +0.2 extra for ≥2 matches

import { getEmbeddingModel } from "./embedding"

// ─── BM25 Tokenizer (exact headroom regex cascade) ───────────────────

// Headroom BM25 tokenizer regex (bm25.rs:34-36)
// Order matters: UUID first so hex IDs aren't broken into pieces
const TOKEN_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b\d{4,}\b|[a-zA-Z0-9_]+/g

function tokenize(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens: string[] = []
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(lower)) !== null) {
    tokens.push(match[0])
  }
  return tokens
}

// ─── BM25 Scoring ────────────────────────────────────────────────────

const K1 = 1.5
const B = 0.75
const MAX_SCORE = 10.0

/**
 * BM25 relevance score for a single item against a context query string.
 * Returns 0.0–1.0. 1.0 = high relevance, 0.0 = no match.
 *
 * Port of headroom bm25.rs BM25Scorer::score() + finalize_score().
 */
export function bm25Score(item: string, context: string): number {
  const itemTokens = tokenize(item)
  const contextTokens = tokenize(context)

  if (!itemTokens.length || !contextTokens.length) return 0.0

  const docLen = itemTokens.length
  const avgdl = docLen  // single-doc scoring — use doc's own length as avgdl

  const docFreq = new Map<string, number>()
  for (const t of itemTokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)

  const queryFreq = new Map<string, number>()
  for (const t of contextTokens) queryFreq.set(t, (queryFreq.get(t) ?? 0) + 1)

  const idf = Math.log(2.0)  // neutral single-doc IDF
  let score = 0.0
  const matched: string[] = []

  // Iterate query terms in sorted order for determinism (headroom bm25.rs:125-126)
  const keys = [...queryFreq.keys()].sort()
  for (const term of keys) {
    const qf = queryFreq.get(term)!
    const f = docFreq.get(term) ?? 0
    if (f === 0) continue
    matched.push(term)

    const numerator = f * (K1 + 1)
    const denominator = f + K1 * (1 - B + B * docLen / avgdl)
    score += idf * (numerator / denominator) * qf
  }

  let normalized = Math.min(1.0, score / MAX_SCORE)

  // Long-token bonus: ≥8 char match (UUIDs, long IDs)
  if (matched.some(t => t.length >= 8)) {
    normalized = Math.min(1.0, normalized + 0.3)
  }

  return normalized
}

// ─── Hybrid Scorer (BM25 + Embedding with adaptive alpha) ────────────

// Adaptive alpha patterns from headroom hybrid.rs:48-67
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
const NUMERIC_ID_RE = /\b\d{4,}\b/
const HOSTNAME_RE = /\b[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z]{2,})?\b/
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/

/**
 * Compute adaptive alpha: higher BM25 weight when exact-match patterns present.
 * Port of headroom hybrid.rs compute_alpha():129-152.
 * Returns alpha clamped to [0.3, 0.9].
 */
function computeAlpha(context: string, baseAlpha: number): number {
  const contextLower = context.toLowerCase()

  const uuidCount = (context.match(UUID_RE) || []).length
  const idCount = (contextLower.match(NUMERIC_ID_RE) || []).length
  const hostnameCount = (contextLower.match(HOSTNAME_RE) || []).length
  const emailCount = (contextLower.match(EMAIL_RE) || []).length

  let alpha = baseAlpha
  if (uuidCount > 0) {
    alpha = Math.max(alpha, 0.85)
  } else if (idCount >= 2) {
    alpha = Math.max(alpha, 0.75)
  } else if (idCount === 1) {
    alpha = Math.max(alpha, 0.65)
  } else if (hostnameCount > 0 || emailCount > 0) {
    alpha = Math.max(alpha, 0.6)
  }

  return Math.max(0.3, Math.min(0.9, alpha))
}

/**
 * Hybrid BM25 + Embedding scorer.
 * Port of headroom hybrid.rs HybridScorer::score().
 *
 * When embedding is unavailable, falls back to BM25 with boost:
 * - Items with ≥1 matched term: score ≥ 0.3
 * - Items with ≥2 matched terms: +0.2, capped at 1.0
 */
export async function hybridScore(
  item: string,
  context: string,
  baseAlpha: number = 0.5,
): Promise<number> {
  const model = getEmbeddingModel()
  const bm25 = bm25Score(item, context)

  if (!model.ready) {
    // BM25-fallback boost (headroom hybrid.rs:156-169)
    const contextTokens = tokenize(context)
    const itemTokens = tokenize(item)
    const matchedCount = contextTokens.filter(t => itemTokens.includes(t)).length

    let score = bm25
    if (matchedCount >= 1) score = Math.max(score, 0.3)
    if (matchedCount >= 2) score = Math.min(1.0, score + 0.2)
    return score
  }

  const alpha = computeAlpha(context, baseAlpha)
  const embedding = await model.similarity(item, context)
  return alpha * bm25 + (1 - alpha) * embedding
}
