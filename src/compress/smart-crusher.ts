import { countTokensSync } from "../util/tokens"
import { deriveKey } from "../ccr/hash"
import type { CcrStore } from "../ccr/store"
import { computeOptimalK } from "./kneedle"
import { bm25Score, hybridScore } from "./relevance"
import { detectStructuralOutliers } from "./outliers"

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

// ─── Public API ──────────────────────────────────────────────────────

export async function crushJsonArray(
  content: string,
  config?: Partial<SmartCrusherConfig>,
  store?: CcrStore,
  context?: string,
): Promise<string> {
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

  // ── Structural outlier detection (returns sorted indices array) ────
  const outlierIndices = detectStructuralOutliers(arr)
  const outlierSet = new Set(outlierIndices)
  const outliers: unknown[] = []
  const nonOutlierItems: unknown[] = []

  for (let i = 0; i < n; i++) {
    if (outlierSet.has(i)) {
      outliers.push(arr[i])
    } else {
      nonOutlierItems.push(arr[i])
    }
  }

  // ── Kneedle K computation on non-outlier items ──────────────────────
  const noItems = nonOutlierItems.map(i => JSON.stringify(i))
  const K = computeOptimalK(noItems, 1.0, 1, cfg.max_items)

  const firstCount = Math.ceil(K * cfg.first_fraction)
  const lastCount = Math.ceil(K * cfg.last_fraction)
  const middleBudget = K - firstCount - lastCount

  const first = nonOutlierItems.slice(0, firstCount)
  const last = nonOutlierItems.slice(Math.max(0, nonOutlierItems.length - lastCount))

  // Fill middle from remaining non-outlier items
  const middle: unknown[] = []
  if (middleBudget > 0) {
    const remainingStart = firstCount
    const remainingEnd = nonOutlierItems.length - lastCount
    if (remainingStart < remainingEnd) {
      const remaining = nonOutlierItems.slice(remainingStart, remainingEnd)

      if (context) {
        // Use hybrid scoring with adaptive alpha
        const scoreEntries = remaining.map(async (it) => ({
          item: it,
          score: await hybridScore(JSON.stringify(it), context, 0.5),
        }))
        const scores = await Promise.all(scoreEntries)

        const filtered = scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score)

        for (let i = 0; i < filtered.length && middle.length < middleBudget; i++) {
          middle.push(filtered[i].item)
        }

        // Fall back to even sampling for remaining slots
        if (middle.length < middleBudget && remaining.length > 0) {
          const usedSeen = new Set(filtered.map(s => s.item))
          const unselected = remaining.filter(r => !usedSeen.has(r))
          if (unselected.length > 0) {
            const step = Math.max(1, Math.floor(unselected.length / (middleBudget - middle.length)))
            for (let i = 0; i < unselected.length && middle.length < middleBudget; i += step) {
              middle.push(unselected[i])
            }
          }
        }
      } else {
        // Even sampling (no context)
        const step = Math.max(1, Math.floor(remaining.length / middleBudget))
        for (let i = 0; i < remaining.length && middle.length < middleBudget; i += step) {
          middle.push(remaining[i])
        }
      }
    }
  }

  // ── Combine: first + middle + last + outliers at end ────────────────
  const combined: unknown[] = []
  const seen = new Set<string>()

  for (const item of first) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) { seen.add(key); combined.push(item) }
  }
  for (const item of middle) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) { seen.add(key); combined.push(item) }
  }
  for (const item of last) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) { seen.add(key); combined.push(item) }
  }
  for (const item of outliers) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) { seen.add(key); combined.push(item) }
  }

  const output = JSON.stringify(combined, null, 2)
  const dropped = n - combined.length

  let result: string
  let ccrHash: string | undefined
  if (dropped > 0) {
    const outlierNote = outliers.length > 0 ? ` [K non-outlier items] + [${outliers.length} structural outliers preserved]` : ""
    if (store) {
      ccrHash = deriveKey(content)
      result = output + `\n// [${dropped} items omitted${outlierNote} — retrieve with <<ccr:${ccrHash}>>]`
    } else {
      result = output + `\n// [${dropped} items omitted${outlierNote}]`
    }
  } else {
    result = output
  }

  // Token-monotone check
  if (countTokensSync(result) >= countTokensSync(content)) return content

  if (store && ccrHash) store.put(ccrHash, content)
  return result
}
