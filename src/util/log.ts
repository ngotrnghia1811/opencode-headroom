import { appendFileSync } from "node:fs"

/**
 * Logs compression events to both a file (for TUI mode) and stdout
 * (for server/web mode). Creates the logger only when verbose is
 * enabled and a file path is configured.
 */
export function createLogger(filePath: string | undefined, enabled: boolean) {
  if (!enabled) return { log: (_msg: string) => {} }

  const hasFile = Boolean(filePath)

  return {
    log(msg: string) {
      // Always log to terminal stdout (visible in server/web mode)
      console.log(`[headroom] ${msg}`)

      // Also write to file (visible in TUI mode via tail -f)
      if (hasFile) {
        const timestamp = new Date().toISOString()
        const line = `[${timestamp}] ${msg}\n`
        try {
          appendFileSync(filePath!, line)
        } catch {
          // fail-open — logging failure must never break the session
        }
      }
    },
  }
}
