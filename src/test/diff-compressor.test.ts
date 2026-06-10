import { describe, test, expect } from "bun:test"
import { compressDiff } from "../compress/diff-compressor"

const makeDiff = (numHunks: number) => {
  const lines: string[] = ["diff --git a/src/main.ts b/src/main.ts", "index abc123..def456 100644", "--- a/src/main.ts", "+++ b/src/main.ts"]
  for (let h = 0; h < numHunks; h++) {
    lines.push(`@@ -${h * 10},7 +${h * 10},8 @@`)
    for (let k = 0; k < 3; k++) lines.push(" context line")
    lines.push(`-removed line ${h}`)
    lines.push(`+added line ${h}`)
    for (let i = 0; i < 5; i++) lines.push(" context line")
  }
  lines.push("-- ", "2.40.1")
  return lines.join("\n")
}

describe("DiffCompressor", () => {
  test("drops context lines, keeps additions and deletions", () => {
    const content = `diff --git a/foo.ts b/foo.ts
index 123..456 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,5 +1,6 @@
 import { bar } from "./bar"
+import { baz } from "./baz"
 const x = 1
 const y = 2
-const old = removeThis
+const renewed = keepThis
 function main() {
   return x + y
 }
`
    const result = compressDiff(content, { max_context_lines: 2 })
    expect(result).toContain("+import { baz }")
    expect(result).toContain("-const old = removeThis")
    expect(result).toContain("+const renewed = keepThis")
    // Should keep file headers
    expect(result).toContain("--- a/foo.ts")
    expect(result).toContain("+++ b/foo.ts")
  })

  test("keeps file headers", () => {
    const content = `diff --git a/src/index.ts b/src/index.ts
index 123456..7890ab 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 context
+new line
 context
 context
`
    const result = compressDiff(content, { keep_file_headers: true })
    expect(result).toContain("diff --git a/src/index.ts")
    expect(result).toContain("--- a/src/index.ts")
    expect(result).toContain("+++ b/src/index.ts")
  })

  test("handles merge-commit @@@ headers", () => {
    const content = `diff --combined src/merge.ts
index 123..456 100644
--- a/src/merge.ts
+++ b/src/merge.ts
@@@ -1,5 -1,5 +1,7 @@@
-import { foo } from "./foo"
 +import { bar } from "./bar"
 +import { baz } from "./baz"
  const x = 1
  const y = 2
`
    const result = compressDiff(content)
    expect(result).toContain("@@@")
    expect(result).toContain("-import { foo }")
  })

  test("falls through unchanged for small diffs", () => {
    const content = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"
    const result = compressDiff(content)
    expect(result).toBe(content)
  })

  test("emits context line drop markers", () => {
    const content = makeDiff(3)
    const result = compressDiff(content, { max_context_lines: 1 })
    // Should have markers about dropped context lines
    expect(result).toContain("context lines dropped")
  })

  test("caps hunks per file", () => {
    const content = makeDiff(15)
    const result = compressDiff(content, { max_hunks_per_file: 3 })
    // Only the first 3 @@ headers should be present
    const hunkMatches = result.match(/@@/g)
    // Each hunk has @@ at start and end, so 3 hunks = 6 @@ sequences... wait no
    // Each hunk header has @@ -N,N +N,N @@ so it's just two @@ per header
    // Actually the regex counts the literal string "@@"
    // Each header: "@@ -A,B +C,D @@" → contains "@@" twice (once at start, once at end)
    // With 3 hunks, that's 6 occurrences of "@@"
    // But we may also have context line dropped markers between hunks
    if (hunkMatches) {
      expect(hunkMatches.length).toBeLessThanOrEqual(6)
    }
  })

  test("handles empty diff content", () => {
    const result = compressDiff("")
    expect(result).toBe("")
  })

  test("parser extracts file count correctly", () => {
    const content = `diff --git a/src/f1.ts b/src/f1.ts
index 111..222 100644
--- a/src/f1.ts
+++ b/src/f1.ts
@@ -1,3 +1,4 @@
  context
+new line in f1
  context
  context
diff --git a/src/f2.ts b/src/f2.ts
index 333..444 100644
--- a/src/f2.ts
+++ b/src/f2.ts
@@ -1,3 +1,4 @@
  context
+new line in f2
  context
  context
diff --git a/src/f3.ts b/src/f3.ts
index 555..666 100644
--- a/src/f3.ts
+++ b/src/f3.ts
@@ -1,3 +1,4 @@
  context
+new line in f3
  context
  context
`
    const result = compressDiff(content, { max_files: 10, max_hunks_per_file: 10 })
    // All 3 files should appear
    expect(result).toContain("diff --git a/src/f1.ts")
    expect(result).toContain("diff --git a/src/f2.ts")
    expect(result).toContain("diff --git a/src/f3.ts")
    expect(result).toContain("new line in f1")
    expect(result).toContain("new line in f2")
    expect(result).toContain("new line in f3")
  })

  test("per-hunk context trimming respects max_context_lines", () => {
    // Build a hunk with exactly 5 context lines before first change and 5 after last change
    const lines: string[] = [
      "diff --git a/foo.ts b/foo.ts",
      "index 123..456 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,11 +1,11 @@",
    ]
    for (let i = 0; i < 5; i++) lines.push(" context before")
    lines.push("+added line")
    lines.push("-removed line")
    for (let i = 0; i < 5; i++) lines.push(" context after")

    const content = lines.join("\n")
    const result = compressDiff(content, { max_context_lines: 2 })

    // With max_context_lines=2, we keep only 2 context lines before change and 2 after.
    // Check that "context lines dropped" marker appears
    expect(result).toContain("context lines dropped")
    // The add/del lines must still be present
    expect(result).toContain("+added line")
    expect(result).toContain("-removed line")
  })

  test("file cap respects max_files", () => {
    // Generate 15-file diff
    const fileBlocks: string[] = []
    for (let f = 0; f < 15; f++) {
      fileBlocks.push(`diff --git a/file${f}.ts b/file${f}.ts
index ${f}00..${f}ff 100644
--- a/file${f}.ts
+++ b/file${f}.ts
@@ -1,3 +1,4 @@
  context
+new line in file ${f}
  context
  context`)
    }
    const content = fileBlocks.join("\n")

    const result = compressDiff(content, { max_files: 5, max_hunks_per_file: 10 })

    // Count file headers in output
    const fileHeaders = result.match(/^diff --git a\/file/gm)
    const headerCount = fileHeaders ? fileHeaders.length : 0
    expect(headerCount).toBeLessThanOrEqual(5)
    // Should mention omitted files
    expect(result).toContain("files omitted")
  })

  test("hunk selection by change density", () => {
    // One file with 3 hunks: 1 change, 5 changes, 2 changes
    const content = `diff --git a/src/main.ts b/src/main.ts
index abc..def 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
  context
+small change 1
  context
  context
@@ -5,10 +6,15 @@
  context
+big change 1
+big change 2
+big change 3
+big change 4
+big change 5
  context
  context
@@ -15,5 +20,7 @@
  context
+medium change 1
+medium change 2
  context
  context
`
    // max_hunks_per_file=1: only the hunk with most changes (5) should appear
    const result = compressDiff(content, { max_hunks_per_file: 1, max_context_lines: 10 })

    // The 5-change hunk should be present
    expect(result).toContain("+big change 1")
    expect(result).toContain("+big change 5")
    // The 1-change and 2-change hunks should be omitted
    expect(result).toContain("hunks omitted")
  })
})
