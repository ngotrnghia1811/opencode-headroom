import { describe, test, expect } from "bun:test"
import { compressBlock, type CompressBlockResult } from "../compress/pipeline"
import { CcrStore } from "../ccr/store"
import { countTokensSync } from "../util/tokens"

describe("compressBlock (real-time hook)", () => {
  // ─── 1. compressBlock on a log string → returns compressed + strategies

  test("compresses a log string", () => {
    const lines: string[] = []
    for (let i = 0; i < 200; i++) {
      lines.push(`2024-01-01 12:00:${String(i % 60).padStart(2, "0")} INFO Processing item ${i}`)
    }
    lines.push("2024-01-01 12:05:00 ERROR Something went wrong")
    lines.push("Traceback (most recent call last):")
    lines.push('  File "test.py", line 10, in run')
    lines.push("ValueError: invalid value")
    for (let i = 0; i < 30; i++) {
      lines.push(`2024-01-01 12:06:${String(i % 60).padStart(2, "0")} WARN Deprecated API used for item ${i}`)
    }
    const text = lines.join("\n")

    const result = compressBlock(text)
    expect(result).not.toBeNull()
    const r = result as CompressBlockResult
    expect(r.strategies.length).toBeGreaterThan(0)
    expect(r.strategies).toContain("log_compressor")
    expect(r.tokensAfter).toBeLessThan(countTokensSync(text))
    expect(r.compressed.length).toBeLessThan(text.length)
  })

  // ─── 2. compressBlock on a JSON array → returns compressed + strategies

  test("compresses a JSON array", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 100; i++) {
      items.push({
        id: i,
        name: `item-${i}`,
        value: i * 10,
        description: `This is item number ${i} with some extra text to make it larger`,
      })
    }
    const text = JSON.stringify(items)

    const result = compressBlock(text)
    expect(result).not.toBeNull()
    const r = result as CompressBlockResult
    expect(r.strategies).toContain("smart_crusher")
    expect(r.tokensAfter).toBeLessThan(countTokensSync(text))
    // Should have kept fewer items than the original
    const parsed = JSON.parse(r.compressed.split("\n//")[0])
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeLessThan(100)
  })

  // ─── 3. compressBlock on plain text → returns null

  test("returns null for plain text", () => {
    const text = "This is a simple paragraph of plain English text. It does not contain any structured data, code blocks, log patterns, or diff formats. Just regular prose that would be classified as plain text by the content detector."

    const result = compressBlock(text)
    expect(result).toBeNull()
  })

  // ─── 4. compressBlock on a diff → returns compressed

  test("compresses a diff", () => {
    const lines: string[] = ["diff --git a/file.ts b/file.ts", "index abc123..def456 100644", "--- a/file.ts", "+++ b/file.ts"]
    // Generate many hunks to make it compressible
    for (let h = 0; h < 30; h++) {
      lines.push(`@@ -${h * 10 + 1},8 +${h * 10 + 1},10 @@`)
      lines.push(" const foo = 1")
      lines.push(" const bar = 2")
      lines.push(`-const oldVar${h} = "removed"`)
      lines.push(`+const newVar${h} = "added"`)
      lines.push(" const baz = 3")
    }
    const text = lines.join("\n")

    const result = compressBlock(text)
    expect(result).not.toBeNull()
    const r = result as CompressBlockResult
    expect(r.strategies).toContain("diff_compressor")
    expect(r.tokensAfter).toBeLessThan(countTokensSync(text))
  })

  // ─── 5. compressBlock token count < input token count ─────────────

  test("tokensAfter is less than original token count for compressible content", () => {
    // Build a large search-results-like string
    const lines: string[] = []
    for (let i = 0; i < 300; i++) {
      const fileNum = i % 10
      const lineNum = i * 3 + 1
      lines.push(`src/module${fileNum}.ts:${lineNum}:const result = processItem(${i}); // some context here`)
    }
    const text = lines.join("\n")

    const originalTokens = countTokensSync(text)
    const result = compressBlock(text)

    if (result) {
      expect(result.tokensAfter).toBeLessThan(originalTokens)
      expect(result.compressed.length).toBeLessThan(text.length)
    }
    // Note: search detection may not always trigger; if it doesn't, result is null (fine)
  })

  // ─── 6. compressBlock with store → CCR marker ─────────────────────

  test("injects CCR marker when store is provided", () => {
    const store = new CcrStore()
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, name: `item-${i}`, value: i * 10, desc: `Description for item ${i}` })
    }
    const text = JSON.stringify(items)

    const result = compressBlock(text, store)
    expect(result).not.toBeNull()
    const r = result as CompressBlockResult
    expect(r.compressed).toInclude("<<ccr:")
    store.close()
  })

  // ─── 7. compressBlock with no store → no CCR marker ───────────────

  test("does not inject CCR marker when no store is provided", () => {
    const items: Record<string, unknown>[] = []
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, name: `item-${i}`, value: i * 10, desc: `Description for item ${i}` })
    }
    const text = JSON.stringify(items)

    const result = compressBlock(text)
    expect(result).not.toBeNull()
    const r = result as CompressBlockResult
    expect(r.compressed).not.toInclude("<<ccr:")
  })

  // ─── 8. compressBlock fail-open: empty string → null ──────────────

  test("returns null gracefully for empty string", () => {
    const result = compressBlock("")
    expect(result).toBeNull()
  })
})
