import { describe, test, expect } from "bun:test"
import { compressLog } from "../compress/log-compressor"

describe("LogCompressor", () => {
  const makeLog = (count: number) => {
    const lines: string[] = []
    for (let i = 0; i < count; i++) {
      lines.push(`2024-01-01 12:00:${String(i).padStart(2, "0")} INFO Processing item ${i}`)
    }
    lines.push("2024-01-01 12:00:50 ERROR Something went wrong")
    lines.push("Traceback (most recent call last):")
    lines.push(`  File "test.py", line 10, in run`)
    lines.push("ValueError: invalid value")
    for (let i = 0; i < 20; i++) {
      lines.push(`2024-01-01 12:01:${String(i).padStart(2, "0")} WARN Deprecated API used for item ${i}`)
    }
    lines.push("2024-01-01 12:02:00 ERROR Last error occurred")
    lines.push("====================================")
    lines.push("10 passed, 2 failed, 1 skipped")
    return lines.join("\n")
  }

  test("deduplicates repeated warnings", () => {
    const log = `2024-01-01 12:00:00 WARN Connection timeout for user 1
2024-01-01 12:00:01 WARN Connection timeout for user 2
2024-01-01 12:00:02 WARN Connection timeout for user 3
2024-01-01 12:00:03 WARN Connection timeout for user 4
2024-01-01 12:00:04 WARN Connection timeout for user 5
2024-01-01 12:00:05 WARN Connection timeout for user 6
2024-01-01 12:00:06 WARN Connection timeout for user 7
2024-01-01 12:00:07 WARN Connection timeout for user 8
2024-01-01 12:00:08 WARN Connection timeout for user 9
2024-01-01 12:00:09 WARN Connection timeout for user 10
`
    const result = compressLog(log, { max_warnings: 5, max_total_lines: 100 })
    // After deduplication, the warnings should be collapsed (all normalize to similar form)
    const warnMatches = (result.match(/WARN/g) || []).length
    expect(warnMatches).toBeLessThanOrEqual(5)
  })

  test("keeps first and last errors", () => {
    const log = `2024-01-01 12:00:00 INFO Starting
2024-01-01 12:00:01 ERROR First error
2024-01-01 12:00:02 INFO Middle
2024-01-01 12:00:03 ERROR Middle error
2024-01-01 12:00:04 INFO More middle
2024-01-01 12:00:05 ERROR Last error
2024-01-01 12:00:06 INFO Done
`
    const result = compressLog(log, { max_total_lines: 100 })
    expect(result).toContain("First error")
    expect(result).toContain("Last error")
  })

  test("preserves Python-style stack traces", () => {
    const log = `2024-01-01 12:00:00 INFO Starting
2024-01-01 12:00:01 ERROR Something went wrong
Traceback (most recent call last):
  File "/app/main.py", line 10, in <module>
    run()
  File "/app/main.py", line 5, in run
    process(data)
  File "/app/main.py", line 2, in process
    raise ValueError("invalid data")
ValueError: invalid data
2024-01-01 12:00:02 INFO Done
`
    const result = compressLog(log, { max_total_lines: 100 })
    expect(result).toContain("Traceback")
    expect(result).toContain("ValueError")
  })

  test("preserves JS-style stack traces", () => {
    const log = `[12:00:00] INFO Starting
[12:00:01] ERROR: something broke
  at processData (/app/src/processor.ts:42:15)
  at run (/app/src/main.ts:10:5)
  at Object.<anonymous> (/app/src/index.ts:1:1)
[12:00:02] INFO Done
`
    const result = compressLog(log, { max_total_lines: 100 })
    expect(result).toContain("at processData")
    expect(result).toContain("ERROR")
  })

  test("respects max_total_lines", () => {
    const log = makeLog(200)
    const result = compressLog(log, { max_total_lines: 30 })
    const lines = result.split("\n")
    // Output should be constrained (allow some overhead for markers)
    expect(lines.length).toBeLessThanOrEqual(50)
  })

  test("falls through unchanged for short content", () => {
    const content = "Just a few lines\nNothing to compress\nReally nothing"
    const result = compressLog(content)
    // max_total_lines default is 100, but the character length is still the same
    // since there are only 3 lines, nothing should change
    expect(result).toBe(content)
  })

  test("preserves summary lines (test results)", () => {
    const log = `2024-01-01 12:00:00 INFO Starting tests
test_foo.py::test_one PASSED
test_foo.py::test_two PASSED
test_foo.py::test_three FAILED
====================================
10 passed, 1 failed, 0 skipped
2024-01-01 12:01:00 INFO Done
`
    const result = compressLog(log, { keep_summary_lines: true, max_total_lines: 100 })
    expect(result).toContain("10 passed")
    expect(result).toContain("FAILED")
  })

  test("emits omission markers when lines are dropped", () => {
    const log = makeLog(200)
    const result = compressLog(log, { max_total_lines: 20 })
    // Should have omission markers
    expect(result).toContain("lines omitted")
  })
})
