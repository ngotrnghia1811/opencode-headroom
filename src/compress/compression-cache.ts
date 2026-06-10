import { deriveKey } from "../ccr/hash"

interface CacheEntry {
  compressed: string
  ratio: number
  strategy: string
  created_at: number
}

/**
 * Port of CompressionCache — content_router.py:191-295.
 * Two-tier in-memory cache with TTL.
 *
 * Tier 1 (skip set): content hashes known to be non-compressible — instant skip.
 * Tier 2 (result cache): compressed results for content that DID compress.
 *
 * Entries expire after TTL (default 30 min = 1_800_000 ms).
 */
export class CompressionCache {
  private results = new Map<string, CacheEntry>()
  private skip = new Map<string, number>()
  private ttlMs: number

  hits = 0
  skipHits = 0
  misses = 0
  evictions = 0

  constructor(ttlMs = 1_800_000) {
    this.ttlMs = ttlMs
  }

  private key(content: string): string {
    return deriveKey(content)
  }

  /** Check if content is known non-compressible (Tier 1). */
  isSkipped(content: string): boolean {
    const key = this.key(content)
    const ts = this.skip.get(key)
    if (ts === undefined) return false
    if (Date.now() - ts < this.ttlMs) {
      this.skipHits++
      return true
    }
    this.skip.delete(key)
    this.evictions++
    return false
  }

  /** Get cached compression result (Tier 2). Returns null if not found/expired. */
  get(content: string): { compressed: string; ratio: number; strategy: string } | null {
    const key = this.key(content)
    const entry = this.results.get(key)
    if (entry === undefined) {
      this.misses++
      return null
    }
    if (Date.now() - entry.created_at < this.ttlMs) {
      this.hits++
      return { compressed: entry.compressed, ratio: entry.ratio, strategy: entry.strategy }
    }
    this.results.delete(key)
    this.evictions++
    this.misses++
    return null
  }

  /** Store a compressed result (Tier 2). */
  put(content: string, compressed: string, ratio: number, strategy: string): void {
    const key = this.key(content)
    this.results.set(key, { compressed, ratio, strategy, created_at: Date.now() })
  }

  /** Mark content as non-compressible (Tier 1). */
  markSkip(content: string): void {
    const key = this.key(content)
    this.skip.set(key, Date.now())
  }

  /** Move a cached result to skip set. */
  moveToSkip(content: string): void {
    const key = this.key(content)
    this.results.delete(key)
    this.skip.set(key, Date.now())
  }

  get size(): number { return this.results.size }
  get skipSize(): number { return this.skip.size }

  get stats() {
    return {
      cache_hits: this.hits,
      cache_skip_hits: this.skipHits,
      cache_misses: this.misses,
      cache_evictions: this.evictions,
      cache_size: this.results.size,
      cache_skip_size: this.skip.size,
    }
  }

  clear(): void {
    this.results.clear()
    this.skip.clear()
  }
}
