import { describe, test, expect } from "bun:test"
import { detectContentType, ContentType } from "../compress/content-detector"

describe("ContentDetector", () => {
  test("detects JSON array of objects", () => {
    const content = '[{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]'
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.JsonArray)
    expect(result.confidence).toBe(1.0)
    expect(result.metadata.is_dict_array).toBe(true)
  })

  test("detects JSON array of primitives", () => {
    const content = "[1, 2, 3, 4, 5]"
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.JsonArray)
    expect(result.confidence).toBe(0.8)
    expect(result.metadata.is_dict_array).toBe(false)
  })

  test("detects git diff format", () => {
    const content = `diff --git a/src/index.ts b/src/index.ts
index 123456..7890ab 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
-import { foo } from "./foo"
+import { bar } from "./bar"
+import { baz } from "./baz"
 const x = 1
 const y = 2
`
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.GitDiff)
    expect(result.confidence).toBeGreaterThanOrEqual(0.7)
  })

  test("detects HTML content", () => {
    const content = `<!DOCTYPE html>
<html lang="en">
<head><title>Test</title></head>
<body>
<div class="main">
<p>Hello World</p>
<span>test</span>
<script>console.log("hi")</script>
<link rel="stylesheet" href="style.css">
<meta charset="utf-8">
<nav><a href="/">Home</a></nav>
</div>
</body>
</html>`
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.Html)
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
  })

  test("detects search results", () => {
    const content = `src/main.ts:42:function doStuff() {
src/main.ts:55:const x = 123
src/main.ts:99:export default app
src/helper.ts:10:import { foo } from "./main"
src/helper.ts:15:return foo()
src/helper.ts:20:}
src/utils/string.ts:3:export function trim(s: string) {
src/utils/string.ts:4:return s.trim()
src/utils/string.ts:5:}
`
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.SearchResults)
    expect(result.confidence).toBeGreaterThanOrEqual(0.6)
  })

  test("detects build/log output", () => {
    const content = `2024-01-01 12:00:00 ERROR Something went wrong
2024-01-01 12:00:01 WARN This is a warning
2024-01-01 12:00:02 INFO Starting process
2024-01-01 12:00:03 FAILED to connect
ERROR: Critical failure
[12:00:04] DEBUG processing request
Traceback (most recent call last):
  File "test.py", line 10, in run
ValueError: invalid value
npm ERR! code ENOENT
npm ERR! path /missing
  at Object.<anonymous> (/app/index.js:10:5)
`
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.BuildOutput)
    expect(result.confidence).toBeGreaterThanOrEqual(0.3)
  })

  test("detects source code (Python)", () => {
    const content = `import os
import sys

def main():
    args = sys.argv[1:]
    if not args:
        print("Usage: ...")
        return
    # Process arguments
    for arg in args:
        print(f"Processing {arg}")

if __name__ == "__main__":
    main()
`
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.SourceCode)
    expect(result.confidence).toBeGreaterThanOrEqual(0.4)
  })

  test("detects source code (TypeScript)", () => {
    const content = `import { type Plugin } from "@opencode-ai/plugin"

export interface Config {
  enabled: boolean
  minTokens: number
}

const DEFAULT_CONFIG: Config = {
  enabled: true,
  minTokens: 200,
}

export function parseConfig(raw: unknown): Config {
  const opts = raw as Record<string, unknown>
  return {
    enabled: opts.enabled !== false,
    minTokens: typeof opts.minTokens === "number" ? opts.minTokens : 200,
  }
}
`
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.SourceCode)
    expect(result.confidence).toBeGreaterThanOrEqual(0.4)
  })

  test("falls back to plain text for unrecognized content", () => {
    const content = "This is just some plain text. Nothing special here."
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.PlainText)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
  })

  test("handles empty string", () => {
    const result = detectContentType("")
    expect(result.content_type).toBe(ContentType.PlainText)
    expect(result.confidence).toBe(0)
  })

  test("detects merge-commit diff format (@@@ headers)", () => {
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
    const result = detectContentType(content)
    expect(result.content_type).toBe(ContentType.GitDiff)
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
  })
})
