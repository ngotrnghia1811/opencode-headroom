// Token pattern: UUIDs, numeric IDs (4+ digits), alphanumeric tokens
const TOKEN_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b\d{4,}\b|[a-zA-Z0-9_]+/g

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(TOKEN_RE)].map(m => m[0])
}

/**
 * BM25 relevance score for a single item against a context query string.
 * Returns 0.0–1.0. 1.0 = high relevance, 0.0 = no match.
 *
 * Tokenizes both item and context, computes BM25 weighting with
 * k1=1.5, b=0.75, neutral IDF, and a bonus for long-token matches (UUIDs etc).
 * Normalized by max_score=10.0.
 */
export function bm25Score(item: string, context: string): number {
  const itemTokens = tokenize(item)
  const contextTokens = tokenize(context)
  if (!itemTokens.length || !contextTokens.length) return 0.0

  const docLen = itemTokens.length
  const avgdl = docLen // single-doc scoring — use doc's own length as avgdl

  const k1 = 1.5
  const b = 0.75
  const maxScore = 10.0

  const docFreq = new Map<string, number>()
  for (const t of itemTokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)

  const queryFreq = new Map<string, number>()
  for (const t of contextTokens) queryFreq.set(t, (queryFreq.get(t) ?? 0) + 1)

  const idf = Math.log(2.0) // neutral single-doc IDF
  let score = 0.0
  const matched: string[] = []

  for (const [term, qf] of queryFreq) {
    const f = docFreq.get(term) ?? 0
    if (f === 0) continue
    matched.push(term)
    const numerator = f * (k1 + 1)
    const denominator = f + k1 * (1 - b + b * docLen / avgdl)
    score += idf * (numerator / denominator) * qf
  }

  let normalized = Math.min(1.0, score / maxScore)

  // Bonus for long-token matches (UUIDs, long IDs)
  const longMatches = matched.filter(t => t.length >= 8)
  if (longMatches.length > 0) normalized = Math.min(1.0, normalized + 0.3)

  return normalized
}
