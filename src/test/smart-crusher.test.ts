import { describe, test, expect } from "bun:test"
import { crushJsonArray } from "../compress/smart-crusher"
import { CcrStore } from "../ccr/store"
import { deriveKey, extractCcrHashes } from "../ccr/hash"

describe("SmartCrusher", () => {
  test("reduces a 50-item array using Kneedle adaptive K", async () => {
    const items = []
    for (let i = 0; i < 50; i++) {
      items.push({ id: i, name: `item-${i}`, value: i * 10 })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10, max_items: 30 })
    expect(result).not.toBe(content)
    const parsed = JSON.parse(result.split("\n//")[0])
    expect(Array.isArray(parsed)).toBe(true)
    // Kneedle may keep more items than sqrt(n) for diverse arrays
    expect(parsed.length).toBeLessThan(50)
    expect(parsed.length).toBeGreaterThan(2)
  })

  test("passthrough for arrays smaller than min_items_to_analyze", async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 })
    expect(result).toBe(content)
  })

  test("keeps first and last items", async () => {
    const items = []
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, value: `item${i}` })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 })
    const parsed = JSON.parse(result.split("\n//")[0])
    expect(parsed[0].id).toBe(0)
    expect(parsed[parsed.length - 1].id).toBe(99)
  })

  test("falls through for non-JSON content", async () => {
    const content = "This is not json at all"
    const result = await crushJsonArray(content)
    expect(result).toBe(content)
  })

  test("falls through for non-array JSON", async () => {
    const content = '{"key": "value"}'
    const result = await crushJsonArray(content)
    expect(result).toBe(content)
  })

  test("appends omitted items comment", async () => {
    const items = []
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, data: `value-${i}` })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 })
    expect(result).toContain("items omitted")
  })

  test("does not compress when item count = min_items_to_analyze", async () => {
    const items = []
    for (let i = 0; i < 10; i++) {
      items.push({ id: i })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 })
    expect(result.length).toBeGreaterThanOrEqual(content.length)
  })

  test("handles empty array", async () => {
    const result = await crushJsonArray("[]")
    expect(result).toBe("[]")
  })

  test("token monotone: does not expand small content when there's no value", async () => {
    const items = []
    for (let i = 0; i < 20; i++) {
      items.push({ id: i })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 })
    if (result !== content) {
      expect(result.length).toBeLessThan(content.length)
    }
  })

  test("CCR: injects marker and stores original when store is provided", async () => {
    const items = []
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, name: `item-${i}`, value: i * 10, padding: "x".repeat(40) })
    }
    const content = JSON.stringify(items)
    const store = new CcrStore()
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 }, store)

    expect(result).not.toBe(content)

    const hashes = extractCcrHashes(result)
    expect(hashes.length).toBeGreaterThanOrEqual(1)

    const expectedHash = deriveKey(content)
    expect(hashes).toContain(expectedHash)

    const retrieved = store.get(expectedHash)
    expect(retrieved).toBe(content)
  })

  test("CCR: no marker when store is not provided", async () => {
    const items = []
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, name: `item-${i}`, value: i * 10, padding: "x".repeat(40) })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 })
    const hashes = extractCcrHashes(result)
    expect(hashes.length).toBe(0)
  })

  test("BM25 context: prioritizes context-relevant items in middle", async () => {
    const items: { id: number; name: string }[] = []
    for (let i = 0; i < 50; i++) {
      items.push({ id: i, name: `item-${i}` })
    }
    // Insert a special matching item in the middle
    items[25] = { id: 25, name: "needle-in-haystack" }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 }, undefined, "needle haystack")
    const parsed = JSON.parse(result.split("\n//")[0])
    // The "needle-in-haystack" item should be included
    const hasNeedle = parsed.some((i: { name: string }) => i.name === "needle-in-haystack")
    expect(hasNeedle).toBe(true)
  })

  test("BM25 context: falls back to even sampling when no context match", async () => {
    const items: { id: number; name: string }[] = []
    for (let i = 0; i < 50; i++) {
      items.push({ id: i, name: `item-${i}` })
    }
    const content = JSON.stringify(items)
    const result = await crushJsonArray(content, { min_items_to_analyze: 10 }, undefined, "zephyr quantum")
    // Should still produce valid output even with no matches
    const parsed = JSON.parse(result.split("\n//")[0])
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(2)
  })
})
