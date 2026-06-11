import { appendFileSync } from "node:fs"

/**
 * Simple file-based logger for verbose compression output.
 * Writes to a file so logs are visible even in TUI mode
 * (where console.log is swallowed by the terminal renderer).
 */
export function createLogger(filePath: string | undefined, enabled: boolean) {
  if (!enabled || !filePath) return { log: (_msg: string) => {} }

  return {
    log(msg: string) {
      const timestamp = new Date().toISOString()
      const line = `[${timestamp}] ${msg}\n`
      try {
        appendFileSync(filePath, line)
      } catch {
        // fail-open — logging failure must never break the session
      }
    },
  }
}
