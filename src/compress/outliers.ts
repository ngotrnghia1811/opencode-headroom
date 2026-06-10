// ─── Structural outlier detection for JSON arrays ──────────────────
// Exact port of headroom-core/src/transforms/smart_crusher/outliers.rs
// (detect_structural_outliers + detect_rare_status_values with Bug #3 fix)
//
// Detection:
// 1. Rare-field outliers: items containing a field that appears in <20% of the array
// 2. Rare-status outliers: items with rare values in common fields (Pareto check)
//
// Returns sorted indices of outlier items.

/**
 * Detect structural outliers in an array of JSON items.
 * Port of detect_structural_outliers() — outliers.rs:61-109
 */
export function detectStructuralOutliers(items: unknown[]): number[] {
  if (items.length < 5) return []

  // Field counts across the whole array
  const fieldCounts = new Map<string, number>()
  for (const item of items) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      for (const key of Object.keys(item as Record<string, unknown>)) {
        fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1)
      }
    }
  }

  const n = items.length
  const commonFields = new Set<string>()
  const rareFields = new Set<string>()

  for (const [key, count] of fieldCounts) {
    if (count >= n * 0.8) commonFields.add(key)
    if (count < n * 0.2) rareFields.add(key)
  }

  const outlierSet = new Set<number>()

  // 1. Rare-field outliers
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>
      const hasRare = Object.keys(obj).some(k => rareFields.has(k))
      if (hasRare) outlierSet.add(i)
    }
  }

  // 2. Rare-status outliers
  for (const idx of detectRareStatusValues(items, commonFields)) {
    outlierSet.add(idx)
  }

  return [...outlierSet].sort((a, b) => a - b)
}

/**
 * Detect items with rare values in status-like categorical fields.
 * Port of detect_rare_status_values() — outliers.rs:122-200
 *
 * Bug #3 fix: cardinality guard 2..=50 (was 2..=10 in Python).
 * Pareto check: smallest K where top-K covers ≥80% of items, with K ≤ 5.
 */
function detectRareStatusValues(items: unknown[], commonFields: Set<string>): number[] {
  const outlierIndices: number[] = []
  const sortedFields = [...commonFields].sort()  // deterministic order

  for (const fieldName of sortedFields) {
    // Collect this field's values across all object items
    const values: unknown[] = []
    for (const item of items) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>
        if (fieldName in obj) values.push(obj[fieldName])
      }
    }

    if (values.length === 0) continue

    // Stringify non-null values for dedup + frequency counting
    const stringify = (v: unknown): string => {
      if (v === null) return ""
      if (typeof v === "boolean") return v.toString()
      if (typeof v === "number") return v.toString()
      if (typeof v === "string") return v
      return JSON.stringify(v)
    }

    // Dedup to get cardinality (null excluded — matching headroom)
    const uniqueValues = new Set<string>()
    for (const v of values) {
      if (v !== null) uniqueValues.add(stringify(v))
    }

    // Cardinality guard: 2..=50 (Bug #3 fix — was 2..=10 in Python)
    if (uniqueValues.size < 2 || uniqueValues.size > 50) continue

    // Frequency count
    const valueCounts = new Map<string, number>()
    for (const v of values) {
      const key = v === null ? "__none__" : stringify(v)
      valueCounts.set(key, (valueCounts.get(key) || 0) + 1)
    }
    if (valueCounts.size === 0) continue

    const total = values.length

    // Pareto check: sort by count descending, tiebreak by key ascending
    const sorted = [...valueCounts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    })

    const threshold = Math.ceil(total * 0.8)
    let cumulative = 0
    const topKValues = new Set<string>()

    for (const [key, count] of sorted) {
      cumulative += count
      topKValues.add(key)
      if (cumulative >= threshold) break
    }

    // Only flag if Pareto group is small enough (K ≤ 5)
    if (topKValues.size > 5) continue

    // Items NOT in top-K → outliers
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>
        if (fieldName in obj) {
          const val = obj[fieldName]
          const key = val === null ? "__none__" : stringify(val)
          if (!topKValues.has(key)) {
            outlierIndices.push(i)
          }
        }
      }
    }
  }

  return outlierIndices
}
