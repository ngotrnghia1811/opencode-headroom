import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"

// ─── SimHash ────────────────────────────────────────────────────────

/**
 * 64-bit SimHash fingerprint of a text string.
 * Uses 4-char sliding bigram MD5 hashes, per adaptive_sizer.rs:192-232.
 * Returns a BigInt to retain full 64-bit precision.
 */
export function simhash(text: string): bigint {
  const lower = text.toLowerCase()
  const chars = [...lower]
  const n = chars.length
  const iterCount = n <= 3 ? 1 : n - 3

  const votes = new Int32Array(64)
  for (let i = 0; i < iterCount; i++) {
    const gram = chars.slice(i, i + 4).join("")
    const hash = createHash("md5").update(gram).digest()
    // First 8 bytes as big-endian u64
    let h = 0n
    for (let b = 0; b < 8; b++) {
      h = (h << 8n) | BigInt(hash[b])
    }
    for (let j = 0; j < 64; j++) {
      if ((h >> BigInt(j)) & 1n) {
        votes[j]++
      } else {
        votes[j]--
      }
    }
  }

  let fingerprint = 0n
  for (let j = 0; j < 64; j++) {
    if (votes[j] > 0) {
      fingerprint |= 1n << BigInt(j)
    }
  }
  return fingerprint
}

// ─── Hamming Distance ───────────────────────────────────────────────

export function hammingDistance(a: bigint, b: bigint): number {
  const xor = a ^ b
  // BigInt doesn't have a built-in popcount; count bit by bit
  let count = 0
  let remaining = xor
  while (remaining !== 0n) {
    if (remaining & 1n) count++
    remaining >>= 1n
  }
  return count
}

// ─── countUniqueSimhash ─────────────────────────────────────────────

/**
 * Estimate unique content count via SimHash clustering.
 * Two items are considered "same" if their Hamming distance ≤ threshold.
 * Returns the number of clusters (≈ unique items). Per adaptive_sizer.rs:245-267.
 */
export function countUniqueSimhash(items: string[], threshold: number = 3): number {
  const fingerprints = items.map(simhash)
  const clusters: bigint[] = []

  for (const fp of fingerprints) {
    let found = false
    for (const cluster of clusters) {
      if (hammingDistance(fp, cluster) <= threshold) {
        found = true
        break
      }
    }
    if (!found) {
      clusters.push(fp)
    }
  }

  return clusters.length
}

// ─── Bigram Curve ───────────────────────────────────────────────────

/**
 * Compute the cumulative unique bigram count curve.
 * Each step shows how many unique word-pair bigrams we've seen so far.
 * Per adaptive_sizer.rs:158-178.
 */
export function computeUniqueBigramCurve(items: string[]): number[] {
  const seen = new Set<string>()
  const curve: number[] = []

  for (const item of items) {
    const words = item.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length < 2) {
      seen.add(JSON.stringify([words[0] ?? "", ""]))
    } else {
      for (let j = 0; j < words.length - 1; j++) {
        seen.add(JSON.stringify([words[j], words[j + 1]]))
      }
    }
    curve.push(seen.size)
  }

  return curve
}

// ─── Knee Detection ─────────────────────────────────────────────────

/**
 * Find the knee (point of diminishing returns) in a cumulative curve.
 * Uses normalized distance from the diagonal (xNorm, yNorm plane).
 * Returns 1-indexed count of items at the knee, or null if no knee exists.
 * Per adaptive_sizer.rs:111-149.
 */
export function findKnee(curve: number[]): number | null {
  const n = curve.length
  if (n < 3) return null

  const yMin = curve[0]
  const yMax = curve[n - 1]

  if (Math.abs(yMax - yMin) < 1e-10) return 1 // flat curve → keep 1

  const xRange = n - 1
  const yRange = yMax - yMin

  let maxDiff = -Infinity
  let kneeIdx: number | null = null

  for (let i = 0; i < n; i++) {
    const xNorm = i / xRange
    const yNorm = (curve[i] - yMin) / yRange
    const diff = yNorm - xNorm
    if (diff > maxDiff) {
      maxDiff = diff
      kneeIdx = i
    }
  }

  if (maxDiff < 0.05) return null
  return kneeIdx! + 1 // 1-indexed
}

// ─── Zlib Validation ────────────────────────────────────────────────

/**
 * Validate that the proposed K captures compression characteristics
 * close enough to the full set. If the compression ratio differs by
 * more than `tolerance`, expand K by 1.2x. Per adaptive_sizer.rs:277-313.
 */
export function validateWithZlib(
  items: string[],
  k: number,
  maxK: number,
  tolerance: number = 0.15,
): number {
  if (k >= items.length || k >= maxK) return k

  const fullText = items.join("\n")
  const subsetText = items.slice(0, k).join("\n")

  if (fullText.length < 200) return k

  const fullCompressed = deflateSync(Buffer.from(fullText))
  const subsetCompressed = deflateSync(Buffer.from(subsetText))

  const fullRatio = fullText.length > 0 ? fullCompressed.length / fullText.length : 1.0
  const subsetRatio = subsetText.length > 0 ? subsetCompressed.length / subsetText.length : 1.0

  const ratioDiff = Math.abs(fullRatio - subsetRatio)

  if (ratioDiff > tolerance) {
    const adjusted = Math.floor(k * 1.2)
    return Math.min(adjusted, maxK)
  }

  return k
}

// ─── computeOptimalK ────────────────────────────────────────────────

/**
 * Three-tier algorithm to determine the optimal number of items to keep
 * from a collection. Balances diversity preservation with compression.
 * Per adaptive_sizer.rs:54-104.
 *
 * Tier 1: fast path for very small or highly redundant arrays
 * Tier 2: Kneedle bigram curve knee detection + diversity ratio
 * Tier 3: zlib compression ratio validation
 */
export function computeOptimalK(
  items: string[],
  bias: number = 1.0,
  minK: number = 1,
  maxK?: number,
): number {
  const n = items.length
  const effectiveMax = maxK ?? n

  // Tier 1: fast path
  if (n <= 8) return n

  const uniqueCount = countUniqueSimhash(items, 3)
  if (uniqueCount <= 3) {
    return Math.min(effectiveMax, Math.max(minK, uniqueCount))
  }

  // Tier 2: Kneedle
  const curve = computeUniqueBigramCurve(items)
  const knee = findKnee(curve)
  const diversityRatio = uniqueCount / n

  let resolvedKnee: number
  if (knee === null) {
    const keepFraction = 0.3 + 0.7 * diversityRatio
    resolvedKnee = Math.max(minK, Math.floor(n * keepFraction))
  } else if (diversityRatio > 0.7) {
    const floor = Math.max(minK, Math.floor(n * (0.3 + 0.7 * diversityRatio)))
    resolvedKnee = Math.max(knee, floor)
  } else {
    resolvedKnee = knee
  }

  let k = Math.max(minK, Math.floor(resolvedKnee * bias))
  k = Math.min(k, effectiveMax)

  // Tier 3: zlib validation
  k = validateWithZlib(items, k, effectiveMax, 0.15)

  return Math.max(minK, Math.min(k, effectiveMax))
}
