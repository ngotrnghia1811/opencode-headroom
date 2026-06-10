import { describe, test, expect } from "bun:test"
import { simhash, hammingDistance, countUniqueSimhash, computeUniqueBigramCurve, findKnee, computeOptimalK } from "../compress/kneedle"

describe("simhash", () => {
  test("empty string", () => expect(simhash("")).toBe(0xd41d8cd98f00b204n))
  test("'a'", () => expect(simhash("a")).toBe(0x0cc175b9c0f1b6a8n))
  test("'abc'", () => expect(simhash("abc")).toBe(0x900150983cd24fb0n))
  test("lowercases", () => expect(simhash("ABC")).toBe(simhash("abc")))
})

describe("hammingDistance", () => {
  test("identical", () => expect(hammingDistance(0n, 0n)).toBe(0))
  test("all bits differ", () => expect(hammingDistance(0n, 0xffffffffffffffffn)).toBe(64))
  test("one bit difference", () => expect(hammingDistance(0n, 1n)).toBe(1))
})

describe("countUniqueSimhash", () => {
  test("all unique", () => {
    const items = Array.from({ length: 5 }, (_, i) => `item ${i}`)
    const c = countUniqueSimhash(items)
    expect(c).toBeGreaterThanOrEqual(1)
    expect(c).toBeLessThanOrEqual(5)
  })
  test("identical items count as 1", () => {
    const items = ["hello world", "hello world", "hello world"]
    expect(countUniqueSimhash(items)).toBe(1)
  })
})

describe("computeUniqueBigramCurve", () => {
  test("single item", () => {
    const curve = computeUniqueBigramCurve(["hello world"])
    expect(curve).toHaveLength(1)
    expect(curve[0]).toBe(1) // one bigram: (hello, world)
  })
  test("curve is monotonically non-decreasing", () => {
    const items = ["hello world foo", "bar baz qux", "hello world again"]
    const curve = computeUniqueBigramCurve(items)
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
  })
})

describe("findKnee", () => {
  test("too short", () => expect(findKnee([1, 2])).toBeNull())
  test("flat curve returns 1", () => expect(findKnee([5, 5, 5, 5])).toBe(1))
  test("linear curve (no saturation)", () => {
    const linear = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    expect(findKnee(linear)).toBeNull()
  })
  test("saturating curve", () => {
    const saturating = [10, 15, 17, 18, 18, 19, 19, 19, 19, 20]
    const knee = findKnee(saturating)
    expect(knee).not.toBeNull()
    expect(knee!).toBeLessThanOrEqual(5)
  })
})

describe("computeOptimalK", () => {
  test("fast path: n <= 8", () => {
    const items = Array.from({ length: 6 }, (_, i) => `item ${i}`)
    expect(computeOptimalK(items)).toBe(6)
  })
  test("highly redundant: returns low K", () => {
    const items = Array.from({ length: 50 }, () => '{"status": "ok", "code": 200}')
    const k = computeOptimalK(items)
    expect(k).toBeLessThan(10)
  })
  test("diverse items: returns higher K", () => {
    const items = Array.from({ length: 50 }, (_, i) => `{"id": "${i}", "name": "item-${i}", "value": ${i * 7}}`)
    const k = computeOptimalK(items)
    expect(k).toBeGreaterThan(5)
  })
  test("maxK is respected", () => {
    const items = Array.from({ length: 100 }, (_, i) => `{"id": "${i}"}`)
    expect(computeOptimalK(items, 1.0, 1, 20)).toBeLessThanOrEqual(20)
  })
})
