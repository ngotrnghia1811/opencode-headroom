import { describe, test, expect } from "bun:test"
import { isMixedContent, splitIntoSections } from "../compress/mixed-content"
import { ContentType } from "../compress/types"

describe("isMixedContent", () => {
  test("returns true for content with code fence + prose", () => {
    const content = `Here is some text with multiple sentences. This is another sentence that goes on.
And here is yet another sentence for good measure.
The quick brown fox jumps over the lazy dog. Then it went home. Now it sleeps.
Furthermore, the analysis continues. Another key finding emerges.
The final verdict is clear. All tests pass. Ready to ship.

\`\`\`typescript
const x = 1
const y = 2
\`\`\`
`
    expect(isMixedContent(content)).toBe(true)
  })

  test("returns false for single-type content (pure log)", () => {
    const content = `[INFO] Starting application
[INFO] Loading configuration
[INFO] Connecting to database
[INFO] Connection established
[WARN] High memory usage detected
[INFO] Server listening on port 3000
`
    expect(isMixedContent(content)).toBe(false)
  })

  test("returns false for simple text with few sentences", () => {
    const content = "Hello world. This is short."
    expect(isMixedContent(content)).toBe(false)
  })

  test("returns true for JSON block + prose markers", () => {
    const content = `Here is some analysis text. The results are below.

[
  {"name": "Alice", "score": 95},
  {"name": "Bob", "score": 87}
]

This shows the ranking. Another observation follows. Yet more commentary.
The data suggests a trend. Additional analysis confirms this. More sentences here.
`
    expect(isMixedContent(content)).toBe(true)
  })
})

describe("splitIntoSections", () => {
  test("splits code fence + search results correctly", () => {
    const content = `\`\`\`typescript
const x = 1
\`\`\`

src/foo.ts:12: some error
src/bar.ts:45: another error
`
    const sections = splitIntoSections(content)
    expect(sections.length).toBe(2) // code + search (blank line is whitespace-trimmed)

    const codeSection = sections[0]
    expect(codeSection.content_type).toBe(ContentType.SourceCode)
    expect(codeSection.content).toBe("const x = 1")
    expect(codeSection.start_line).toBe(0)
    expect(codeSection.end_line).toBe(2)

    const searchSection = sections[1]
    expect(searchSection.content_type).toBe(ContentType.SearchResults)
    expect(searchSection.content).toContain("src/foo.ts:12:")
    expect(searchSection.content).toContain("src/bar.ts:45:")
  })

  test("handles JSON block with nested braces/brackets", () => {
    const content = `[
  {"items": [1, 2, 3], "nested": {"a": 1}},
  {"items": [4, 5, 6], "nested": {"b": 2}}
]
`
    const sections = splitIntoSections(content)
    expect(sections.length).toBe(1)
    expect(sections[0].content_type).toBe(ContentType.JsonArray)
    expect(sections[0].content).toContain('"items": [1, 2, 3]')
    expect(sections[0].content).toContain('"nested": {"a": 1}')
  })

  test("handles string-escaped brackets in JSON", () => {
    // ] inside JSON string value should NOT break the block extraction
    const content = '{"path": "a]b", "name": "test[foo"}'
    const sections = splitIntoSections(content)
    expect(sections.length).toBe(1)
    expect(sections[0].content_type).toBe(ContentType.JsonArray)
  })

  test("returns empty array for empty content", () => {
    const sections = splitIntoSections("")
    expect(sections).toEqual([])
  })

  test("returns empty array for whitespace-only content", () => {
    const sections = splitIntoSections("   \n  \n  ")
    expect(sections).toEqual([])
  })

  test("preserves text between special sections", () => {
    const content = `Introductory text goes here.

\`\`\`python
print("hello")
\`\`\`

Conclusion text follows.`
    const sections = splitIntoSections(content)
    expect(sections.length).toBe(3)

    expect(sections[0].content_type).toBe(ContentType.PlainText)
    expect(sections[0].content).toContain("Introductory text goes here.")

    expect(sections[1].content_type).toBe(ContentType.SourceCode)
    expect(sections[1].content).toBe('print("hello")')

    expect(sections[2].content_type).toBe(ContentType.PlainText)
    expect(sections[2].content.trim()).toBe("Conclusion text follows.")
  })
})
