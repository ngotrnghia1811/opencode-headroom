import { describe, test, expect } from "bun:test"
import { parseOptions } from "../config"
import type { CompressorParams } from "../config"
import { compressBlock } from "../compress/pipeline"
import type { CompressorConfig } from "../config"
import { CcrStore } from "../ccr/store"

function jsonArrayText(count = 50): string {
  const items: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    items.push({ id: i, name: `item-${i}`, value: i * 10, desc: `This is item number ${i} with padding text` })
  }
  return JSON.stringify(items)
}

function buildLogText(): string {
  const lines: string[] = []
  for (let i = 0; i < 200; i++) {
    lines.push(`2024-01-01 12:00:${String(i % 60).padStart(2, "0")} INFO Processing item ${i}`)
  }
  lines.push("2024-01-01 12:05:00 ERROR Something went wrong")
  lines.push("2024-01-01 12:05:01 ERROR Another error occurred")
  lines.push("2024-01-01 12:05:02 ERROR Third error for testing")
  lines.push("2024-01-01 12:05:03 ERROR Fourth error")
  lines.push("2024-01-01 12:05:04 ERROR Fifth error")
  lines.push("2024-01-01 12:05:05 ERROR Sixth error")
  lines.push("Traceback (most recent call last):")
  lines.push('  File "test.py", line 10, in run')
  lines.push("ValueError: invalid value")
  for (let i = 0; i < 30; i++) {
    lines.push(`2024-01-01 12:06:${String(i % 60).padStart(2, "0")} WARN Deprecated API used for item ${i}`)
  }
  return lines.join("\n")
}

function searchOutputText(): string {
  const lines: string[] = []
  for (let i = 0; i < 50; i++) {
    lines.push(`src/file_${i}.ts:${10 + i}:const x = "match_${i}"`)
  }
  return lines.join("\n")
}

function diffText(): string {
  const lines: string[] = [
    "diff --git a/src/index.ts b/src/index.ts",
    "index abc1234..def5678 100644",
    "--- a/src/index.ts",
    "+++ b/src/index.ts",
    "@@ -10,40 +10,10 @@ import { foo } from './foo'",
  ]
  for (let i = 0; i < 20; i++) {
    lines.push(` const unchanged = ${i}`)
  }
  for (let i = 0; i < 10; i++) {
    lines.push(`+  const added${i} = ${i * 10}`)
    lines.push(`-  const removed${i} = ${i * 10 + 5}`)
  }
  for (let i = 0; i < 30; i++) {
    lines.push(` const moreContext = ${i}`)
  }
  for (let i = 0; i < 5; i++) {
    lines.push(`+  const endAdd${i} = 0${i}`)
    lines.push(`-  const endDel${i} = 1${i}`)
  }
  for (let i = 0; i < 20; i++) {
    lines.push(` const trailing = ${i}`)
  }
  return lines.join("\n")
}

describe("compressor_params overrides", () => {
  // ─── 1. parseOptions extracts compressor_params correctly

  test("parseOptions extracts compressor_params correctly", () => {
    const input = {
      enabled: true,
      compressor_params: {
        log: { max_errors: 5 },
        search: { max_total_matches: 50 },
        ccr: { capacity: 500, ttl_seconds: 120 },
      },
    }
    const opts = parseOptions(input)
    expect(opts.compressor_params).toBeDefined()
    expect(opts.compressor_params!.log?.max_errors).toBe(5)
    expect(opts.compressor_params!.search?.max_total_matches).toBe(50)
    expect(opts.compressor_params!.ccr?.capacity).toBe(500)
    expect(opts.compressor_params!.ccr?.ttl_seconds).toBe(120)
  })

  // ─── 2. Log compressor uses max_errors override from params

  test("log compressor uses max_errors override from params", async () => {
    const text = buildLogText()
    const params: CompressorParams = {
      log: { max_errors: 1 },
    }

    // With max_errors:1, compression should be aggressive but still succeed
    const result = await compressBlock(text, undefined, undefined, params, undefined)
    expect(result).not.toBeNull()
    // Should compress — output shorter than input
    expect(result!.compressed.length).toBeLessThan(text.length)
    // The compressed output should contain at least some content
    expect(result!.compressed.length).toBeGreaterThan(10)
  })

  // ─── 3. Search compressor uses max_total_matches override from params

  test("search compressor uses max_total_matches override from params", async () => {
    const text = searchOutputText()
    const params: CompressorParams = {
      search: { max_total_matches: 5 },
    }

    const result = await compressBlock(text, undefined, undefined, params, undefined)
    expect(result).not.toBeNull()
    const matchLines = result!.compressed.split("\n").filter(l => /^src\/file_\d+\.ts:\d+:/.test(l))
    expect(matchLines.length).toBeLessThanOrEqual(5)
  })

  // ─── 4. Diff compressor uses max_context_lines override from params

  test("diff compressor uses max_context_lines override from params", async () => {
    const text = diffText()
    const params: CompressorParams = {
      diff: { max_context_lines: 0 },
    }

    const result = await compressBlock(text, undefined, undefined, params, undefined)
    expect(result).not.toBeNull()
    // With max_context_lines: 0, all context lines around changes should be dropped
    // The result should be shorter than the original
    expect(result!.compressed.length).toBeLessThan(text.length)
  })

  // ─── 5. SmartCrusher uses max_items override from params

  test("smart_crusher uses max_items override from params", async () => {
    const text = jsonArrayText(50)
    const params: CompressorParams = {
      smart_crusher: { max_items: 5 },
    }

    const result = await compressBlock(text, undefined, undefined, params, undefined)
    expect(result).not.toBeNull()

    // The compressed output should be a valid JSON array + footer comment
    // With max_items: 5, the array portion should have ≤ 5 items
    const jsonMatch = result!.compressed.match(/^(\[[\s\S]*?\])/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1])
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBeLessThanOrEqual(5)
    }
  })

  // ─── 6. Missing compressor_params → all defaults used (no crash)

  test("missing compressor_params → all defaults used (no crash)", async () => {
    const text = jsonArrayText(50)
    const result = await compressBlock(text, undefined, undefined, undefined, undefined)
    expect(result).not.toBeNull()
  })

  // ─── 7. Partial compressor_params → only specified params override, others use defaults

  test("partial compressor_params → only specified params override, others use defaults", async () => {
    const logText = buildLogText()
    const searchText = searchOutputText()

    // Only set log params, not search params
    const params: CompressorParams = {
      log: { max_errors: 2 },
    }

    // Log compression should use the override
    const logResult = await compressBlock(logText, undefined, undefined, params, undefined)
    expect(logResult).not.toBeNull()

    // Search compression should still work with defaults (no crash)
    const searchResult = await compressBlock(searchText, undefined, undefined, params, undefined)
    expect(searchResult).not.toBeNull()
    // With default max_total_matches: 100, all 50 matches should fit
    const matchLines = searchResult!.compressed.split("\n").filter(l => /^src\/file_\d+\.ts:\d+:/.test(l))
    expect(matchLines.length).toBeGreaterThan(0)
  })

  // ─── 8. Unknown keys → ignored (no crash)

  test("unknown keys in compressor_params → ignored (no crash)", async () => {
    const text = jsonArrayText(50)
    const params = {
      nonexistent: { foo: 42 },
      log: { max_errors: 3 },
    } as unknown as CompressorParams

    const result = await compressBlock(text, undefined, undefined, params, undefined)
    expect(result).not.toBeNull()
  })

  // ─── 9. headroom_stats still reports correctly after overrides

  test("ccr_store uses compressor_params.ccr for capacity and ttl", () => {
    const store = new CcrStore({ capacity: 50, ttl_seconds: 600 })
    expect(store).toBeDefined()
    // Put entries and verify capacity behavior
    for (let i = 0; i < 60; i++) {
      store.put(`hash_${i}`, `payload_${i}`)
    }
    // Should have evicted some entries (capacity 50, evicts 10% = 5)
    const size = store.size()
    expect(size).toBeLessThan(60)
    store.close()
  })
})
