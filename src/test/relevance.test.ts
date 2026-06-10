import { describe, test, expect } from "bun:test"
import { bm25Score } from "../compress/relevance"

describe("bm25Score", () => {
  test("empty context returns 0", () => expect(bm25Score("hello world", "")).toBe(0))
  test("empty item returns 0", () => expect(bm25Score("", "hello")).toBe(0))
  test("exact match returns > 0", () => expect(bm25Score("hello world", "hello")).toBeGreaterThan(0))
  test("UUID match gets bonus", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000"
    const score = bm25Score(`{"id": "${uuid}"}`, uuid)
    expect(score).toBeGreaterThan(0.3)
  })
  test("unrelated text returns 0", () => expect(bm25Score("apple orange banana", "zephyr quantum")).toBe(0))
  test("score is 0..1", () => {
    const s = bm25Score("hello world foo bar baz", "hello foo qux")
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
  })
})
