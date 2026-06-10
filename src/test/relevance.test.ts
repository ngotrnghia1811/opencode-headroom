import { describe, test, expect } from "bun:test"
import { bm25Score, hybridScore } from "../compress/relevance"

describe("BM25 Scorer (headroom exact port)", () => {
  // ─── Tokenization tests ────────────────────────────────────────────

  test("empty context returns 0", () => expect(bm25Score("hello world", "")).toBe(0))
  test("empty item returns 0", () => expect(bm25Score("", "hello")).toBe(0))
  test("exact match returns > 0", () => expect(bm25Score("hello world", "hello")).toBeGreaterThan(0))

  test("UUID match gets long-token bonus (≥8 chars → +0.3)", () => {
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

  // ─── BM25 formula ──────────────────────────────────────────────────

  test("higher term frequency increases score", () => {
    const single = bm25Score('{"name": "alice"}', "alice")
    const triple = bm25Score('{"a":"alice","b":"alice","c":"alice"}', "alice")
    expect(triple).toBeGreaterThanOrEqual(single)
  })

  test("long token bonus applies only for ≥8 char matches", () => {
    const short = bm25Score('{"x": "ab"}', "ab")
    const long = bm25Score('{"x": "abcdefgh"}', "abcdefgh")
    expect(long).toBeGreaterThanOrEqual(short)
  })

  // ─── Tokenizer: UUID as single token ───────────────────────────────

  test("tokenizer treats UUID as single token", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000"
    const score = bm25Score(`find ${uuid}`, uuid)
    expect(score).toBeGreaterThan(0.3)
  })

  // ─── Tokenizer: numeric IDs (4+ digits) ────────────────────────────

  test("tokenizer captures 4+ digit numeric IDs", () => {
    const score = bm25Score("user 12345 logged in", "12345")
    expect(score).toBeGreaterThan(0)
  })

  // ─── Tokenizer: alphanumeric/underscore fallback ───────────────────

  test("tokenizer captures alphanumeric tokens with underscores", () => {
    const score = bm25Score("const user_name = 'alice'", "user_name")
    expect(score).toBeGreaterThan(0)
  })
})

describe("Hybrid Scorer (BM25 + Embedding, adaptive alpha)", () => {
  // ─── hybridScore returns number in [0, 1] ──────────────────────────

  test("hybridScore returns value between 0 and 1", async () => {
    const score = await hybridScore("test text about programming", "programming test")
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  // ─── hybridScore with matching tokens returns non-zero ─────────────

  test("hybridScore with matching tokens returns non-zero", async () => {
    const score = await hybridScore("hello world foo bar", "hello foo")
    expect(score).toBeGreaterThan(0)
  })

  // ─── hybridScore no match returns 0 ────────────────────────────────

  test("hybridScore with no matching tokens returns 0", async () => {
    const score = await hybridScore("apple orange", "zephyr quantum")
    expect(score).toBe(0)
  })

  // ─── Adaptive alpha: UUID context increases BM25 weight ────────────

  test("UUID context triggers higher BM25 weight (alpha ≥ 0.85)", async () => {
    // UUID in context → alpha pushed to ≥ 0.85
    // With BM25 fallback, the boost logic applies
    const score = await hybridScore(
      '{"id": "550e8400-e29b-41d4-a716-446655440000"}',
      "find 550e8400-e29b-41d4-a716-446655440000",
    )
    // Long token bonus + matched terms → score should be significant
    expect(score).toBeGreaterThan(0.3)
  })

  // ─── BM25 fallback boost: ≥1 match → floor 0.3 ────────────────────

  test("BM25 fallback gives boost floor for single match", async () => {
    // Single match "alice" — BM25 alone ~0.07, fallback pushes to ≥0.3
    const score = await hybridScore('{"name": "alice"}', "alice")
    expect(score).toBeGreaterThanOrEqual(0.3)
  })

  // ─── BM25 fallback boost: ≥2 matches → +0.2 extra ─────────────────

  test("BM25 fallback gives extra boost for 2+ matches", async () => {
    const score = await hybridScore(
      '{"name": "alice", "role": "admin", "team": "engineering"}',
      "alice admin engineering",
    )
    expect(score).toBeGreaterThanOrEqual(0.5)
  })
})
