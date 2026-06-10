import { describe, test, expect } from "bun:test"
import { compressSearch } from "../compress/search-compressor"

const makeSearchResults = (files: number, matchesPerFile: number) => {
  const lines: string[] = []
  for (let f = 0; f < files; f++) {
    for (let m = 0; m < matchesPerFile; m++) {
      lines.push(`src/file${f}.ts:${m * 10 + 1}:export function func${f}_${m}() { return ${m}; }`)
    }
  }
  return lines.join("\n")
}

describe("SearchCompressor", () => {
  test("keeps first and last match per file", () => {
    const content = `src/main.ts:10:import { foo } from "./foo"
src/main.ts:20:const x = foo()
src/main.ts:30:export default x
src/main.ts:40:function helper() {}
src/main.ts:50:helper()
`
    const result = compressSearch(content, { max_matches_per_file: 5, max_files: 20, max_total_matches: 100 })
    expect(result).toContain("src/main.ts:10:")
    expect(result).toContain("src/main.ts:50:")
  })

  test("emits ... N more matches ... marker", () => {
    const content = makeSearchResults(1, 50)
    const result = compressSearch(content, { max_matches_per_file: 3, max_files: 20, max_total_matches: 100 })
    expect(result).toContain("more matches")
  })

  test("handles Windows paths with drive letters", () => {
    const content = `C:\\Users\\foo\\bar.ts:42:const x = 1
C:\\Users\\foo\\bar.ts:55:const y = 2
C:\\Users\\foo\\bar.ts:99:export default x
D:\\Projects\\src\\main.ts:10:import { baz } from "./baz"
D:\\Projects\\src\\main.ts:20:baz()
`
    const result = compressSearch(content, { max_matches_per_file: 5, max_files: 20, max_total_matches: 100 })
    expect(result).toContain("C:\\Users\\foo\\bar.ts")
    expect(result).toContain("D:\\Projects\\src\\main.ts")
  })

  test("falls through unchanged for small content", () => {
    const content = `src/a.ts:1:one\nsrc/a.ts:2:two`
    const result = compressSearch(content)
    expect(result).toBe(content)
  })

  test("caps at max_total_matches", () => {
    const content = makeSearchResults(10, 20)
    const result = compressSearch(content, { max_matches_per_file: 5, max_total_matches: 15, max_files: 20 })

    // Count actual match lines (excluding marker lines)
    const lines = result.split("\n").filter((l) => /:\d+:.+/.test(l))
    expect(lines.length).toBeLessThanOrEqual(15)
  })

  test("caps at max_files", () => {
    const content = makeSearchResults(30, 3)
    const result = compressSearch(content, { max_files: 5, max_total_matches: 200 })

    const uniqueFiles = new Set<string>()
    const lines = result.split("\n")
    for (const line of lines) {
      const match = /^([^:]+(?:\\[^:]+)*):\d+:/.exec(line)
      if (match) uniqueFiles.add(match[1])
    }
    expect(uniqueFiles.size).toBeLessThanOrEqual(5)
  })

  test("handles empty content gracefully", () => {
    const result = compressSearch("")
    expect(result).toBe("")
  })

  test("handles content with no search matches", () => {
    const result = compressSearch("This is just some plain text\nNo file:line:match patterns\n")
    expect(result).toBe("This is just some plain text\nNo file:line:match patterns\n")
  })

  test("parses ripgrep output with context lines (dash separator)", () => {
    const content = `src/main.rs:10:fn main() {
src/main.rs-9-use std::io;
src/main.rs-8-
src/main.rs:15:    println!("hello");
src/main.rs-14-    // setup
src/main.rs:42:    let x = compute();
src/main.rs-41-    // after setup
`
    const result = compressSearch(content, { max_matches_per_file: 10, max_files: 20, max_total_matches: 100 })
    // All 3 match lines (:) should appear; context lines (-) may be dropped
    expect(result).toContain("src/main.rs:10:")
    expect(result).toContain("src/main.rs:15:")
    expect(result).toContain("src/main.rs:42:")
    // Match lines must be present; context lines optional but the parser must not crash
    const lines = result.split("\n")
    const matchLines = lines.filter((l) => /:\d+:/.test(l))
    expect(matchLines.length).toBe(3)
  })

  test("relevance-scored middle selection prefers error lines", () => {
    const lines: string[] = []
    // 15 info lines
    for (let i = 0; i < 15; i++) {
      lines.push(`src/main.ts:${i * 2 + 10}:INFO processing item ${i}`)
    }
    // 5 error lines scattered through middle positions
    lines.push("src/main.ts:20:ERROR database connection failed")
    lines.push("src/main.ts:25:ERROR null pointer exception")
    lines.push("src/main.ts:30:ERROR timeout exceeded")
    lines.push("src/main.ts:35:ERROR fatal disk full")
    lines.push("src/main.ts:40:ERROR panic in worker thread")
    const content = lines.join("\n")

    const result = compressSearch(content, {
      max_matches_per_file: 10,
      max_files: 20,
      max_total_matches: 8,
      keep_first_match: true,
      keep_last_match: true,
    })

    // With 8 slots, first and last take 2, leaving 6 for middle.
    // Error lines should be preferred over info lines.
    const errorMatches = (result.match(/ERROR/g) || []).length
    // At least 3 of the 5 error lines should appear
    expect(errorMatches).toBeGreaterThanOrEqual(3)
  })
})
