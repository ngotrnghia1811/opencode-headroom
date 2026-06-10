import { describe, test, expect } from "bun:test"
import {
  createStatsTool,
  createSessionStats,
  recordCompression,
} from "../tool/stats"
import type { SessionStats } from "../tool/stats"

describe("stats-tool", () => {
  // ── 1. Empty stats return zeros ──────────────────────────────────
  test("empty stats return zeros and empty compressor_hits", async () => {
    const stats = createSessionStats()
    const tool = createStatsTool(() => stats)
    const result = await tool.execute({})

    expect(result.title).toBe("Headroom Stats")

    const parsed = JSON.parse(result.output)
    expect(parsed.tokens_consumed).toBe(0)
    expect(parsed.tokens_saved).toBe(0)
    expect(parsed.savings_pct).toBe(0)
    expect(parsed.messages_processed).toBe(0)
    expect(parsed.compressor_hits).toEqual({})
  })

  // ── 2. After incrementing stats, values reflect correctly ────────
  test("stats reflect recorded compression", async () => {
    const stats = createSessionStats()
    recordCompression(stats, 1000, 300, ["smart_crusher"])
    recordCompression(stats, 500, 100, ["log_compressor", "smart_crusher"])

    const tool = createStatsTool(() => stats)
    const result = await tool.execute({})
    const parsed = JSON.parse(result.output)

    expect(parsed.tokens_consumed).toBe(1500)
    expect(parsed.tokens_saved).toBe(400)
    expect(parsed.messages_processed).toBe(2)
    expect(parsed.compressor_hits).toEqual({
      smart_crusher: 2,
      log_compressor: 1,
    })
  })

  // ── 3. savings_pct computed correctly ────────────────────────────
  test("savings_pct computed as (tokensSaved / tokensConsumed * 100)", async () => {
    const stats = createSessionStats()
    recordCompression(stats, 1000, 250, ["diff_compressor"])

    const tool = createStatsTool(() => stats)
    const result = await tool.execute({})
    const parsed = JSON.parse(result.output)

    expect(parsed.savings_pct).toBe(25)
  })

  test("savings_pct is 0 when no tokens consumed", async () => {
    const stats = createSessionStats()
    const tool = createStatsTool(() => stats)
    const result = await tool.execute({})
    const parsed = JSON.parse(result.output)

    expect(parsed.savings_pct).toBe(0)
  })

  // ── 4. Returned output is valid JSON ─────────────────────────────
  test("execute returns valid JSON string output", async () => {
    const stats = createSessionStats()
    recordCompression(stats, 200, 50, ["search_compressor"])

    const tool = createStatsTool(() => stats)
    const result = await tool.execute({})

    expect(() => JSON.parse(result.output)).not.toThrow()
    expect(typeof result.output).toBe("string")
    expect(typeof result.title).toBe("string")
  })

  // ── 5. Compressor hits map records calls per compressor ──────────
  test("compressor_hits increments per distinct compressor", async () => {
    const stats = createSessionStats()
    recordCompression(stats, 100, 10, ["smart_crusher"])
    recordCompression(stats, 100, 20, ["smart_crusher"])
    recordCompression(stats, 100, 5, ["diff_compressor"])

    const tool = createStatsTool(() => stats)
    const result = await tool.execute({})
    const parsed = JSON.parse(result.output)

    expect(parsed.compressor_hits).toEqual({
      smart_crusher: 2,
      diff_compressor: 1,
    })
  })

  // ── 6. Tool description is non-empty string ──────────────────────
  test("tool has non-empty description", () => {
    const stats = createSessionStats()
    const tool = createStatsTool(() => stats)

    expect(typeof tool.description).toBe("string")
    expect(tool.description.length).toBeGreaterThan(0)
  })
})
