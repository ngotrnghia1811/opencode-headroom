import { countTokensSync } from "../util/tokens"
import { deriveKey } from "../ccr/hash"
import type { CcrStore } from "../ccr/store"
import { computeOptimalK } from "./kneedle"
import { bm25Score } from "./relevance"

export interface SmartCrusherConfig {
  min_items_to_analyze: number
  max_items: number
  first_fraction: number
  last_fraction: number
}

const DEFAULTS: SmartCrusherConfig = {
  min_items_to_analyze: 10,
  max_items: 30,
  first_fraction: 0.3,
  last_fraction: 0.15,
}

// ─── Public API ────────────────────────────────────────────────────

export function crushJsonArray(
  content: string,
  config?: Partial<SmartCrusherConfig>,
  store?: CcrStore,
  context?: string,
): string {
  const cfg = { ...DEFAULTS, ...config }

  let arr: unknown[]
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return content
    arr = parsed
  } catch {
    return content
  }

  if (arr.length < cfg.min_items_to_analyze) return content

  const n = arr.length

  // Serialize items for Kneedle analysis
  const items = arr.map(i => JSON.stringify(i))
  const K = computeOptimalK(items, 1.0, 1, cfg.max_items)

  const firstCount = Math.ceil(K * cfg.first_fraction)
  const lastCount = Math.ceil(K * cfg.last_fraction)
  const middleBudget = K - firstCount - lastCount

  const first = arr.slice(0, firstCount)
  const last = arr.slice(Math.max(0, arr.length - lastCount))

  // Fill middle from remaining items
  const middle: unknown[] = []
  if (middleBudget > 0) {
    const remainingStart = firstCount
    const remainingEnd = arr.length - lastCount
    if (remainingStart < remainingEnd) {
      const remaining = arr.slice(remainingStart, remainingEnd)

      if (context) {
        // BM25 relevance scoring: pick top middleBudget by score
        const scored = remaining
          .map((item, idx) => ({ item, idx: remainingStart + idx, score: bm25Score(JSON.stringify(item), context) }))
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)

        for (let i = 0; i < scored.length && middle.length < middleBudget; i++) {
          middle.push(scored[i].item)
        }

        // Fall back to even sampling for any remaining slots
        if (middle.length < middleBudget && remaining.length > 0) {
          const usedIndices = new Set(scored.map(s => s.idx))
          const unselected = remaining.filter((_, i) => !usedIndices.has(remainingStart + i))
          if (unselected.length > 0) {
            const step = Math.max(1, Math.floor(unselected.length / (middleBudget - middle.length)))
            for (let i = 0; i < unselected.length && middle.length < middleBudget; i += step) {
              middle.push(unselected[i])
            }
          }
        }
      } else {
        // Even sampling
        const step = Math.max(1, Math.floor(remaining.length / middleBudget))
        for (let i = 0; i < remaining.length && middle.length < middleBudget; i += step) {
          middle.push(remaining[i])
        }
      }
    }
  }

  // Combine, deduplicate by identity
  const combined: unknown[] = []
  const seen = new Set<string>()
  for (const item of [...first, ...middle, ...last]) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) {
      seen.add(key)
      combined.push(item)
    }
  }

  const output = JSON.stringify(combined, null, 2)
  const dropped = n - combined.length

  let result: string
  let ccrHash: string | undefined
  if (dropped > 0) {
    if (store) {
      ccrHash = deriveKey(content)
      result = output + `\n// [${dropped} items omitted — retrieve with <<ccr:${ccrHash}>>]`
    } else {
      result = output + `\n// [${dropped} items omitted]`
    }
  } else {
    result = output
  }

  // Token-monotone check
  if (countTokensSync(result) >= countTokensSync(content)) return content

  if (store && ccrHash) store.put(ccrHash, content)
  return result
}
