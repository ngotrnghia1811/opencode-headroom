import { describe, test, expect } from "bun:test"
import { normalizeSystemPrompt, NORMALIZATION_PATTERNS } from "../compress/cache-aligner"

describe("cache-aligner", () => {
  // ── 1. UUID replaced ────────────────────────────────────────────
  test("replaces UUID", () => {
    const result = normalizeSystemPrompt("trace-id: 550e8400-e29b-41d4-a716-446655440000")
    expect(result.normalized).toBe("trace-id: <<UUID>>")
    expect(result.changed).toBe(true)
  })

  // ── 2. ISO timestamp with Z replaced ────────────────────────────
  test("replaces ISO timestamp with Z and no ms", () => {
    const result = normalizeSystemPrompt("The time is 2026-06-10T14:30:00Z exactly.")
    expect(result.normalized).toBe("The time is <<TIMESTAMP>> exactly.")
    expect(result.changed).toBe(true)
  })

  // ── 3. ISO timestamp with ms replaced ────────────────────────────
  test("replaces ISO timestamp with milliseconds", () => {
    const result = normalizeSystemPrompt("2026-06-10T14:30:00.123Z")
    expect(result.normalized).toBe("<<TIMESTAMP>>")
    expect(result.changed).toBe(true)
  })

  // ── 4. ISO date-only replaced (not part of timestamp) ────────────
  test("replaces standalone ISO date", () => {
    const result = normalizeSystemPrompt("Today is 2026-06-10 and the build is ready.")
    expect(result.normalized).toBe("Today is <<DATE>> and the build is ready.")
    expect(result.changed).toBe(true)
  })

  // ── 5. Long hex session ID replaced ──────────────────────────────
  test("replaces 32-char hex session ID", () => {
    const result = normalizeSystemPrompt(
      "session: ab12cd34ef56ab12cd34ef56ab12cd34",
    )
    expect(result.normalized).toBe("session: <<SESSION_ID>>")
    expect(result.changed).toBe(true)
  })

  test("replaces longer hex session ID", () => {
    const hex64 =
      "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    const result = normalizeSystemPrompt(`id=${hex64}`)
    expect(result.normalized).toBe("id=<<SESSION_ID>>")
    expect(result.changed).toBe(true)
  })

  // ── 6. Short hex NOT replaced (< 32 chars) ──────────────────────
  test("does not replace short hex string (< 32 chars)", () => {
    const short = "deadbeefcafe"
    const result = normalizeSystemPrompt(`hash: ${short}`)
    expect(result.normalized).toBe(`hash: ${short}`)
    expect(result.changed).toBe(false)
  })

  // ── 7. Mixed text: only matched patterns replaced ────────────────
  test("preserves surrounding text and only replaces patterns", () => {
    const input =
      "User 550e8400-e29b-41d4-a716-446655440000 requested at 2026-06-10T12:00:00Z. Today is 2026-06-10. Keep this text."
    const result = normalizeSystemPrompt(input)
    expect(result.normalized).toBe(
      "User <<UUID>> requested at <<TIMESTAMP>>. Today is <<DATE>>. Keep this text.",
    )
    expect(result.changed).toBe(true)
  })

  // ── 8. No match: changed = false ─────────────────────────────────
  test("returns changed=false when no patterns match", () => {
    const result = normalizeSystemPrompt("Hello, this is a normal system prompt.")
    expect(result.normalized).toBe("Hello, this is a normal system prompt.")
    expect(result.changed).toBe(false)
  })

  // ── 9. Empty string: passthrough ─────────────────────────────────
  test("handles empty string", () => {
    const result = normalizeSystemPrompt("")
    expect(result.normalized).toBe("")
    expect(result.changed).toBe(false)
  })

  // ── 10. Multiple UUIDs: all replaced ─────────────────────────────
  test("replaces multiple UUIDs in one string", () => {
    const input =
      "uuid1: 11111111-2222-3333-4444-555555555555 and uuid2: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    const result = normalizeSystemPrompt(input)
    expect(result.normalized).toBe("uuid1: <<UUID>> and uuid2: <<UUID>>")
    expect(result.changed).toBe(true)
  })

  // ── 11. Fail-open: non-string gracefully handled ─────────────────
  test("fail-open: does not throw for any input", () => {
    // The function signature requires string; but if somehow misused,
    // it should not crash the plugin.  We test the try/catch path
    // by calling with a coercible value (the function expects string
    // per TS, but at runtime something odd could happen).
    const result = normalizeSystemPrompt(
      // @ts-expect-error – deliberately testing runtime resilience
      null,
    )
    expect(result.normalized).toBeDefined()
    expect(result.changed).toBe(false)
  })

  // ── 12. NORMALIZATION_PATTERNS exported ──────────────────────────
  test("NORMALIZATION_PATTERNS contains expected keys", () => {
    expect(Object.keys(NORMALIZATION_PATTERNS)).toContain("UUID")
    expect(Object.keys(NORMALIZATION_PATTERNS)).toContain("TIMESTAMP")
    expect(Object.keys(NORMALIZATION_PATTERNS)).toContain("DATE")
    expect(Object.keys(NORMALIZATION_PATTERNS)).toContain("SESSION_ID")
  })
})
