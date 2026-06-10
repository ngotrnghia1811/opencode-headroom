import { Database } from "bun:sqlite"

export interface CcrStoreConfig {
  capacity?: number
  ttl_seconds?: number
  ttlMs?: number
  path?: string
  dbPath?: string
}

const DEFAULTS = {
  capacity: 1000,
  ttl_seconds: 300,
  path: ":memory:",
} as const

function resolveConfig(config?: Partial<CcrStoreConfig>): {
  capacity: number
  ttl_seconds: number
  path: string
} {
  const ttlMs = config?.ttlMs
  return {
    capacity: config?.capacity ?? DEFAULTS.capacity,
    ttl_seconds:
      ttlMs != null
        ? Math.ceil(ttlMs / 1000)
        : (config?.ttl_seconds ?? DEFAULTS.ttl_seconds),
    path: config?.dbPath ?? config?.path ?? DEFAULTS.path,
  }
}

export class CcrStore {
  private db: Database
  private resolved: ReturnType<typeof resolveConfig>

  constructor(config?: Partial<CcrStoreConfig>) {
    this.resolved = resolveConfig(config)
    this.db = new Database(this.resolved.path)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ccr_entries (
        hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
    this.db.run("PRAGMA journal_mode=WAL")
  }

  put(hash: string, payload: string): void {
    this.purge()
    const count = this.size()
    if (count >= this.resolved.capacity) {
      const toEvict = Math.ceil(this.resolved.capacity * 0.1)
      this.db.run(
        "DELETE FROM ccr_entries WHERE hash IN (SELECT hash FROM ccr_entries ORDER BY created_at ASC LIMIT ?)",
        [toEvict],
      )
    }
    this.db.run(
      "INSERT OR REPLACE INTO ccr_entries (hash, payload, created_at) VALUES (?, ?, unixepoch())",
      [hash, payload],
    )
  }

  get(hash: string): string | null {
    const row = this.db
      .query(
        `SELECT payload FROM ccr_entries WHERE hash = ? AND created_at > unixepoch() - ${this.resolved.ttl_seconds}`,
      )
      .get(hash) as { payload: string } | null
    return row?.payload ?? null
  }

  size(): number {
    return (this.db.query("SELECT COUNT(*) as n FROM ccr_entries").get() as { n: number }).n
  }

  clear(): void {
    this.db.run("DELETE FROM ccr_entries")
  }

  close(): void {
    this.db.close()
  }

  private purge(): void {
    this.db.run(
      `DELETE FROM ccr_entries WHERE created_at < unixepoch() - ${this.resolved.ttl_seconds}`,
    )
  }
}
