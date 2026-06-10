import { describe, test, expect } from "bun:test"
import { detectStructuralOutliers } from "../compress/outliers"

describe("Structural Outlier Detection (exact headroom port)", () => {
  // ─── 1. Rare-field outlier: item with field in <20% of items flagged ──

  test("flags item with rare field (<20% frequency)", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 9; i++) {
      items.push({ id: i, name: `item-${i}` })
    }
    // Add one item with an extra field no one else has (10% frequency → rare)
    items.push({ id: 999, name: "outlier", extraField: "only_me" })

    const outliers = detectStructuralOutliers(items)
    expect(outliers).toContain(9)
  })

  // ─── 2. All items with same schema → empty set ─────────────────────

  test("returns empty array when all items have identical schema", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 20; i++) {
      items.push({ id: i, name: `item-${i}`, value: i * 10, active: i % 2 === 0 })
    }

    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBe(0)
  })

  // ─── 3. Fewer than 5 items → empty array ───────────────────────────

  test("returns empty array when fewer than 5 items", () => {
    const items = [
      { id: 1, name: "a" },
      { id: 2, name: "b", extra: true },
      { id: 3, name: "c" },
      { id: 4, name: "d" },
    ]

    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBe(0)
  })

  // ─── 4. Rare status: 95×"ok" + 5×"error" → error items flagged ─────

  test("flags items with rare status values (Pareto check)", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 95; i++) {
      items.push({ status: "ok" })
    }
    items.push({ status: "error" })
    items.push({ status: "timeout" })
    items.push({ status: "error" })
    items.push({ status: "timeout" })
    items.push({ status: "fail" })

    const outliers = detectStructuralOutliers(items)
    // 5 non-"ok" items should be flagged
    expect(outliers.length).toBe(5)
    expect(outliers).toContain(95)
    expect(outliers).toContain(96)
    expect(outliers).toContain(97)
    expect(outliers).toContain(98)
    expect(outliers).toContain(99)
  })

  // ─── 5. Field with >50 unique values → skipped (not categorical) ───

  test("skips fields with >50 unique values (cardinality guard)", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 60; i++) {
      items.push({ code: `VAL_${i}` })
    }

    const outliers = detectStructuralOutliers(items)
    // Cardinality 60 > 50 → field skipped, no rare-status outliers
    // No rare-field outliers either since all items have {"code"}
    expect(outliers.length).toBe(0)
  })

  // ─── 6. Field with 1 unique value → skipped (cardinality < 2) ──────

  test("skips fields with only 1 unique value (cardinality guard)", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 100; i++) {
      items.push({ status: "ok" })
    }

    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBe(0)
  })

  // ─── 7. Bug #3: high cardinality bimodal (60 INFO + 25 WARN + 15 ERR) ──

  test("Bug #3 fix: flags rare values in high-cardinality bimodal distribution", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 60; i++) {
      items.push({ code: "INFO" })
    }
    for (let i = 0; i < 25; i++) {
      items.push({ code: "WARN" })
    }
    for (let i = 0; i < 15; i++) {
      items.push({ code: `ERR_${i}` })
    }
    // Cardinality 17, top-2 (INFO 60 + WARN 25) covers 85%
    // K=2 ≤ 5 → 15 rare ERR_* items flagged

    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBe(15)
  })

  // ─── 8. Uniform distribution → no outliers ─────────────────────────

  test("uniform distribution produces no rare-status outliers", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 50; i++) {
      items.push({ code: `CAT_${i}` })
    }

    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBe(0)
  })

  // ─── 9. Mixed array with non-objects → handled gracefully ──────────

  test("mixed arrays with non-object items are handled gracefully", () => {
    const items: unknown[] = [
      { status: "ok" },
      "plain string",
      { status: "ok" },
      42,
      { status: "ok" },
      { status: "ok" },
    ]
    // Should not throw; only 4 dict items → < 5 → empty
    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBe(0)
  })

  // ─── 10. Outlier indices are sorted ascending ──────────────────────

  test("outlier indices are returned in sorted ascending order", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 9; i++) {
      items.push({ id: i, name: `item-${i}` })
    }
    items.push({ id: 999, name: "outlier", rare: true })

    const outliers = detectStructuralOutliers(items)
    expect(outliers.length).toBeGreaterThan(0)
    // Verify sorted
    for (let i = 1; i < outliers.length; i++) {
      expect(outliers[i]).toBeGreaterThan(outliers[i - 1])
    }
  })
})
