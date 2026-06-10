import type { Plugin } from "@opencode-ai/plugin"
import { parseOptions } from "./config"
import type { CompressorConfig } from "./config"
import { applyCompressionToMessages, compressBlock } from "./compress/pipeline"
import { normalizeSystemPrompt } from "./compress/cache-aligner"
import { CompressionCache } from "./compress/compression-cache"
import { CcrStore } from "./ccr/store"
import { createRetrieveTool } from "./tool/retrieve"
import { createStatsTool, createSessionStats, recordCompression } from "./tool/stats"
import type { SessionStats } from "./tool/stats"
import { countTokensSafe } from "./util/tokens"

function defaultCcrDbPath(): string | undefined {
  const dataHome = process.env.XDG_DATA_HOME
  if (!dataHome) return undefined
  return `${dataHome}/opencode/headroom.db`
}

export const server: Plugin = async (_input, options) => {
  const config = parseOptions(options)

  if (!config.enabled) return {}

  const store = new CcrStore({ dbPath: config.ccr_db_path ?? defaultCcrDbPath() })

  const cache = new CompressionCache()

  const sessionStats: SessionStats = createSessionStats()

  const hooks: Record<string, unknown> = {
    "experimental.chat.messages.transform": async (_input: unknown, output: { messages: unknown[] }) => {
      const messages = output.messages as Parameters<typeof applyCompressionToMessages>[0]
      const result = await applyCompressionToMessages(messages, config, store, cache, config.compressors)
      if (config.verbose && result.tokens_saved > 0) {
        console.log(`[headroom] compressed ${result.tokens_saved} tokens via: ${result.strategies.join(", ")}`)
      }
      recordCompression(sessionStats, result.tokens_consumed, result.tokens_saved, result.strategies)
    },
  }

  // Real-time single-result compression (before result enters history)
  if (config.real_time !== false) {
    hooks["tool.execute.after"] = async (
      _input: unknown,
      output: { title: string; output: string; metadata: unknown },
    ) => {
      if (!config.enabled) return
      const text = output.output
      if (typeof text !== "string") return
      const tokenCount = await countTokensSafe(text)
      const minTokens = config.min_tokens_to_compress ?? 200
      if (tokenCount < minTokens) return
      const result = await compressBlock(text, store, cache, config.compressors)
      if (!result) return
      if (result.tokensAfter >= tokenCount) return
      output.output = result.compressed
      recordCompression(sessionStats, tokenCount, tokenCount - result.tokensAfter, result.strategies)
    }
  }

  // Cache-alignment: normalize dynamic tokens in system prompts
  if (config.cache_align !== false) {
    hooks["experimental.chat.system.transform"] = async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      output.system = output.system.map((s) => normalizeSystemPrompt(s).normalized)
    }
  }

  return {
    tool: {
      headroom_retrieve: createRetrieveTool(store),
      headroom_stats: createStatsTool(() => sessionStats),
    },
    ...hooks,
  }
}
