import { describe, test, expect, beforeEach } from "bun:test"
import { CompressionCache } from "../compress/compression-cache"

describe("CompressionCache", () => {
  let cache: CompressionCache

  beforeEach(() => {
    cache = new CompressionCache()
  })

  test("put + get round-trip: same content returns cached result", () => {
    const content = '{"key": "value"}'
    cache.put(content, "compressed", 0.5, "smart_crusher")

    const result = cache.get(content)
    expect(result).not.toBeNull()
    expect(result!.compressed).toBe("compressed")
    expect(result!.ratio).toBe(0.5)
    expect(result!.strategy).toBe("smart_crusher")
  })

  test("get returns null for uncached content (miss)", () => {
    const result = cache.get("never cached")
    expect(result).toBeNull()
    expect(cache.misses).toBe(1)
  })

  test("isSkipped returns true after markSkip, false for uncached", () => {
    const content = "some log output"
    expect(cache.isSkipped(content)).toBe(false)

    cache.markSkip(content)
    expect(cache.isSkipped(content)).toBe(true)
    expect(cache.skipHits).toBe(1)
  })

  test("cache hit/miss/skipHit counters increment correctly", () => {
    const content = "compressible content"
    const skipped = "non-compressible content"

    // Miss
    expect(cache.get(content)).toBeNull()
    expect(cache.misses).toBe(1)

    // Put and hit
    cache.put(content, "compressed", 0.5, "kompress")
    expect(cache.get(content)).not.toBeNull()
    expect(cache.hits).toBe(1)

    // Skip
    cache.markSkip(skipped)
    expect(cache.isSkipped(skipped)).toBe(true)
    expect(cache.skipHits).toBe(1)
  })

  test("size and skipSize reflect entry counts", () => {
    expect(cache.size).toBe(0)
    expect(cache.skipSize).toBe(0)

    cache.put("a", "ca", 0.5, "s")
    cache.put("b", "cb", 0.6, "s")
    expect(cache.size).toBe(2)

    cache.markSkip("x")
    cache.markSkip("y")
    expect(cache.skipSize).toBe(2)
  })

  test("moveToSkip removes from results, adds to skip", () => {
    const content = "moving target"
    cache.put(content, "compressed", 0.5, "kompress")
    expect(cache.size).toBe(1)
    expect(cache.skipSize).toBe(0)

    cache.moveToSkip(content)
    expect(cache.size).toBe(0)
    expect(cache.skipSize).toBe(1)
    expect(cache.get(content)).toBeNull()
    expect(cache.isSkipped(content)).toBe(true)
  })

  test("TTL expiry: entries older than TTL are evicted on access", async () => {
    const shortCache = new CompressionCache(1) // 1ms TTL
    const content = "expires quickly"

    shortCache.put(content, "compressed", 0.5, "kompress")
    shortCache.markSkip("skip-me")

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(shortCache.get(content)).toBeNull()
    expect(shortCache.isSkipped("skip-me")).toBe(false)
    expect(shortCache.evictions).toBeGreaterThanOrEqual(2)
  })

  test("clear() empties both tiers", () => {
    cache.put("a", "ca", 0.5, "s")
    cache.put("b", "cb", 0.6, "s")
    cache.markSkip("x")
    cache.markSkip("y")

    cache.clear()

    expect(cache.size).toBe(0)
    expect(cache.skipSize).toBe(0)
    expect(cache.get("a")).toBeNull()
    expect(cache.isSkipped("x")).toBe(false)
  })

  test("stats returns object with correct keys", () => {
    const stats = cache.stats
    expect(stats).toHaveProperty("cache_hits")
    expect(stats).toHaveProperty("cache_skip_hits")
    expect(stats).toHaveProperty("cache_misses")
    expect(stats).toHaveProperty("cache_evictions")
    expect(stats).toHaveProperty("cache_size")
    expect(stats).toHaveProperty("cache_skip_size")
  })

  test("different content produces different cache keys", () => {
    cache.put("content-a", "comp-a", 0.5, "s")
    cache.put("content-b", "comp-b", 0.6, "s")

    expect(cache.get("content-a")!.compressed).toBe("comp-a")
    expect(cache.get("content-b")!.compressed).toBe("comp-b")
  })
})
