import { tool } from "@opencode-ai/plugin"

// ─── Types ───────────────────────────────────────────────────────────────

export interface SessionStats {
  messagesProcessed: number
  tokensConsumed: number
  tokensSaved: number
  compressorHits: Record<string, number>
}

function createEmptyStats(): SessionStats {
  return {
    messagesProcessed: 0,
    tokensConsumed: 0,
    tokensSaved: 0,
    compressorHits: {},
  }
}

// ─── Tool factory ────────────────────────────────────────────────────────

export function createStatsTool(getStats: () => SessionStats) {
  return tool({
    description:
      "Returns compression statistics for the current headroom session: " +
      "tokens processed, tokens saved, savings percentage, and per-compressor hit counts.",
    args: {},
    async execute() {
      const stats = getStats()
      const savingsPct =
        stats.tokensConsumed > 0
          ? Math.round((stats.tokensSaved / stats.tokensConsumed) * 100 * 100) / 100
          : 0

      return {
        title: `Headroom Stats`,
        output: JSON.stringify(
          {
            messages_processed: stats.messagesProcessed,
            tokens_consumed: stats.tokensConsumed,
            tokens_saved: stats.tokensSaved,
            savings_pct: savingsPct,
            compressor_hits: stats.compressorHits,
          },
          null,
          2,
        ),
      }
    },
  })
}

// ─── Stats accumulator helper ────────────────────────────────────────────

export function createSessionStats(): SessionStats {
  return createEmptyStats()
}

export function recordCompression(
  stats: SessionStats,
  tokensConsumed: number,
  tokensSaved: number,
  strategies: string[],
): void {
  stats.messagesProcessed++
  stats.tokensConsumed += tokensConsumed
  stats.tokensSaved += tokensSaved
  for (const name of strategies) {
    stats.compressorHits[name] = (stats.compressorHits[name] ?? 0) + 1
  }
}
