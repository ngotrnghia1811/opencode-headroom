import { describe, test, expect, afterAll } from "bun:test"
import { unlinkSync } from "node:fs"
import { CcrStore } from "../ccr/store"
import { deriveKey, extractCcrHashes, ccrMarker, HASH_ALGORITHM } from "../ccr/hash"

describe("CcrStore", () => {
  test("put + get round-trip", () => {
    const store = new CcrStore()
    store.put("abc123def456ghi789jkl012", "hello world")
    const result = store.get("abc123def456ghi789jkl012")
    expect(result).toBe("hello world")
  })

  test("get returns null for non-existent hash", () => {
    const store = new CcrStore()
    const result = store.get("nonexistent0000000000000")
    expect(result).toBeNull()
  })

  test("size reports correct count", () => {
    const store = new CcrStore()
    expect(store.size()).toBe(0)
    store.put("hash1", "payload-1")
    expect(store.size()).toBe(1)
    store.put("hash2", "payload-2")
    expect(store.size()).toBe(2)
  })

  test("clear empties the store", () => {
    const store = new CcrStore()
    store.put("hash1", "payload-1")
    store.put("hash2", "payload-2")
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.get("hash1")).toBeNull()
  })

  test("capacity eviction: inserting beyond capacity evicts oldest", () => {
    const store = new CcrStore({ capacity: 10 })
    for (let i = 0; i < 11; i++) {
      store.put(`hash-${i}`, `payload-${i}`)
    }
    // After 11 puts into capacity 10, size should be ≤ 10
    expect(store.size()).toBeLessThanOrEqual(10)
  })

  test("replace on same hash preserves single entry", () => {
    const store = new CcrStore()
    store.put("same-hash", "first")
    store.put("same-hash", "second")
    expect(store.size()).toBe(1)
    expect(store.get("same-hash")).toBe("second")
  })
})

describe("hash utilities", () => {
  test("deriveKey produces 24-char hex string", () => {
    const key = deriveKey("test payload")
    expect(key.length).toBe(24)
    expect(/^[0-9a-f]{24}$/.test(key)).toBe(true)
  })

  test("deriveKey is deterministic", () => {
    const a = deriveKey("hello")
    const b = deriveKey("hello")
    expect(a).toBe(b)
  })

  test("deriveKey produces different hashes for different inputs", () => {
    const a = deriveKey("hello")
    const b = deriveKey("world")
    expect(a).not.toBe(b)
  })

  test("extractCcrHashes finds all markers in mixed text", () => {
    const text = `Some text <<ccr:abc123def456ghi789jkl012>> more text
and another <<ccr:xyz9876543210abcdef123456>> end`
    const hashes = extractCcrHashes(text)
    expect(hashes).toEqual(["abc123def456ghi789jkl012", "xyz9876543210abcdef123456"])
  })

  test("extractCcrHashes returns empty array for text with no markers", () => {
    const text = "Plain text without any markers << not a marker >>"
    const hashes = extractCcrHashes(text)
    expect(hashes).toEqual([])
  })

  test("extractCcrHashes handles malformed markers gracefully", () => {
    const text = "start <<ccr:goodhash1234567890123456>> middle <<ccr:unclosed"
    const hashes = extractCcrHashes(text)
    expect(hashes).toEqual(["goodhash1234567890123456"])
  })

  test("ccrMarker produces correct format", () => {
    const result = ccrMarker("abcdef1234567890abcdef12")
    expect(result).toBe("<<ccr:abcdef1234567890abcdef12>>")
  })

  test("HASH_ALGORITHM is sha256 and markers round-trip correctly", () => {
    expect(HASH_ALGORITHM).toBe("sha256")

    const payload = "some log content\nwith multiple lines\n"
    const hash = deriveKey(payload)
    const marker = ccrMarker(hash)

    // Marker format
    expect(marker).toStartWith("<<ccr:")
    expect(marker).toEndWith(">>")

    // Extract round-trip
    const text = `prefix text ${marker} suffix text`
    const extracted = extractCcrHashes(text)
    expect(extracted).toEqual([hash])
  })
})

describe("CcrStore persistence", () => {
  const testDbPath = "/tmp/headroom-test-persistent.db"

  afterAll(() => {
    try {
      unlinkSync(testDbPath)
    } catch {
      // file may not exist — fine
    }
  })

  test("persistent path: data survives close and reopen", () => {
    // Write
    const store1 = new CcrStore({ dbPath: testDbPath })
    store1.put("persist-hash", "persisted-payload")
    store1.close()

    // Re-open
    const store2 = new CcrStore({ dbPath: testDbPath })
    const result = store2.get("persist-hash")
    store2.close()

    expect(result).toBe("persisted-payload")
  })

  test("in-memory: default constructor still works (no regression)", () => {
    const store = new CcrStore()
    store.put("inmem-test", "value")
    expect(store.get("inmem-test")).toBe("value")
    expect(store.size()).toBe(1)
    store.close()
  })
})
