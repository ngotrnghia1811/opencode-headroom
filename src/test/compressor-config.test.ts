import { describe, test, expect } from "bun:test"
import { compressBlock } from "../compress/pipeline"
import type { CompressorConfig } from "../config"

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
  // Start with 20 context lines (far from first change — will be dropped)
  for (let i = 0; i < 20; i++) {
    lines.push(` const unchanged = ${i}`)
  }
  // A block of 10 changes close together
  for (let i = 0; i < 10; i++) {
    lines.push(`+  const added${i} = ${i * 10}`)
    lines.push(`-  const removed${i} = ${i * 10 + 5}`)
  }
  // 30 context lines in the middle (far from changes — will be dropped)
  for (let i = 0; i < 30; i++) {
    lines.push(` const moreContext = ${i}`)
  }
  // More changes near the end
  for (let i = 0; i < 5; i++) {
    lines.push(`+  const endAdd${i} = 0${i}`)
    lines.push(`-  const endDel${i} = 1${i}`)
  }
  // 20 trailing context lines (far from last change — will be dropped)
  for (let i = 0; i < 20; i++) {
    lines.push(` const trailing = ${i}`)
  }
  return lines.join("\n")
}

function proseText(): string {
  return [
    "The system architecture was designed with scalability in mind. Each component communicates through a message broker, enabling loose coupling between services.",
    "This approach has proven effective in production environments. The team observed significant improvements in deployment velocity after adopting the new pattern.",
    "However, there are trade-offs to consider. The additional infrastructure complexity requires dedicated monitoring and operational expertise.",
    "Future iterations will focus on reducing the operational burden while maintaining the flexibility benefits. The roadmap includes automated failover and self-healing capabilities.",
  ].join("\n\n")
}

describe("compressor config", () => {
  // ─── 1. smart_crusher: false → JSON array passes through uncompressed

  test("smart_crusher: false → JSON array passes through uncompressed", async () => {
    const text = jsonArrayText(50)
    const cfg: CompressorConfig = { smart_crusher: false }
    const result = await compressBlock(text, undefined, undefined, undefined, cfg)
    expect(result).toBeNull()
  })

  // ─── 2. log: false → build log passes through uncompressed

  test("log: false → build log passes through uncompressed", async () => {
    const text = buildLogText()
    const cfg: CompressorConfig = { log: false }
    const result = await compressBlock(text, undefined, undefined, undefined, cfg)
    expect(result).toBeNull()
  })

  // ─── 3. search: false → grep output passes through uncompressed

  test("search: false → grep output passes through uncompressed", async () => {
    const text = searchOutputText()
    const cfg: CompressorConfig = { search: false }
    const result = await compressBlock(text, undefined, undefined, undefined, cfg)
    expect(result).toBeNull()
  })

  // ─── 4. diff: false → git diff passes through uncompressed

  test("diff: false → git diff passes through uncompressed", async () => {
    const text = diffText()
    const cfg: CompressorConfig = { diff: false }
    const result = await compressBlock(text, undefined, undefined, undefined, cfg)
    expect(result).toBeNull()
  })

  // ─── 5. kompress: false → prose text passes through uncompressed

  test("kompress: false → prose text passes through uncompressed", async () => {
    const text = proseText()
    const cfg: CompressorConfig = { kompress: false }
    const result = await compressBlock(text, undefined, undefined, undefined, cfg)
    expect(result).toBeNull()
  })

  // ─── 6. All true (default) → all compressors work

  test("all true (default) → compressors work", async () => {
    const cfg: CompressorConfig = {
      smart_crusher: true,
      log: true,
      search: true,
      diff: true,
      kompress: true,
    }

    const jsonResult = await compressBlock(jsonArrayText(50), undefined, undefined, cfg)
    expect(jsonResult).not.toBeNull()
    expect(jsonResult!.strategies).toContain("smart_crusher")

    const logResult = await compressBlock(buildLogText(), undefined, undefined, cfg)
    expect(logResult).not.toBeNull()
    expect(logResult!.strategies).toContain("log_compressor")

    const searchResult = await compressBlock(searchOutputText(), undefined, undefined, cfg)
    expect(searchResult).not.toBeNull()
    expect(searchResult!.strategies).toContain("search_compressor")

    const diffResult = await compressBlock(diffText(), undefined, undefined, cfg)
    expect(diffResult).not.toBeNull()
    expect(diffResult!.strategies).toContain("diff_compressor")
  })

  // ─── 7. Missing compressors key in config → all compressors enabled (default)

  test("missing compressors key → all compressors enabled", async () => {
    // undefined compressors = all enabled
    const jsonResult = await compressBlock(jsonArrayText(50), undefined, undefined, undefined)
    expect(jsonResult).not.toBeNull()
    expect(jsonResult!.strategies).toContain("smart_crusher")

    const logResult = await compressBlock(buildLogText(), undefined, undefined, undefined)
    expect(logResult).not.toBeNull()
    expect(logResult!.strategies).toContain("log_compressor")
  })

  // ─── 8. Unknown compressor key in config → silently ignored, no crash

  test("unknown compressor key → silently ignored, no crash", async () => {
    const cfg = { smart_crusher: true, nonexistent: false } as CompressorConfig
    const result = await compressBlock(jsonArrayText(50), undefined, undefined, cfg)
    expect(result).not.toBeNull()
    expect(result!.strategies).toContain("smart_crusher")
  })
})
