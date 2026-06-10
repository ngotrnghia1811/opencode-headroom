import { detectContentType } from "./content-detector"
import { compressLog } from "./log-compressor"
import { compressSearch } from "./search-compressor"
import { compressDiff } from "./diff-compressor"
import { crushJsonArray } from "./smart-crusher"
import { countTokensSync } from "../util/tokens"
import { ContentType } from "./types"
import type { CcrStore } from "../ccr/store"

export interface PipelineConfig {
  enabled: boolean
  min_tokens_to_compress: number
  live_zone_only: boolean
}

const DEFAULTS: PipelineConfig = {
  enabled: true,
  min_tokens_to_compress: 200,
  live_zone_only: true,
}

// ─── Single block compression result (real-time hook) ──────────────

export interface CompressBlockResult {
  compressed: string
  tokensAfter: number
  strategies: string[]
}

// ─── Internal dispatch: contentType → compressor + strategy name ───

function dispatchCompressor(
  text: string,
  contentType: ContentType,
  store?: CcrStore,
): { text: string; strategy: string } {
  switch (contentType) {
    case ContentType.JsonArray:
      return { text: crushJsonArray(text, undefined, store), strategy: "smart_crusher" }
    case ContentType.SearchResults:
      return { text: compressSearch(text, undefined, store), strategy: "search_compressor" }
    case ContentType.BuildOutput:
      return { text: compressLog(text, undefined, store), strategy: "log_compressor" }
    case ContentType.GitDiff:
      return { text: compressDiff(text, undefined, store), strategy: "diff_compressor" }
    default:
      return { text, strategy: "passthrough" }
  }
}

// ─── Single block compression (fail-open, no min-tokens check) ─────

/**
 * Compress a single text block (e.g. tool result). Fail-open.
 * Returns null if compression fails or content type is PlainText.
 */
export function compressBlock(text: string, store?: CcrStore): CompressBlockResult | null {
  if (!text) return null

  const detection = detectContentType(text)
  if (detection.content_type === ContentType.PlainText) return null

  const { text: compressed, strategy } = dispatchCompressor(text, detection.content_type, store)
  if (compressed === text) return null

  const tokensAfter = countTokensSync(compressed)
  return { compressed, tokensAfter, strategies: [strategy] }
}

// ─── Live zone identification ──────────────────────────────────────

export function findLiveZoneStart(messages: { info: { role: string }; parts: unknown[] }[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") return i
  }
  return messages.length
}

// ─── Main hook handler: mutate output.messages in place ────────────

interface MessageParts {
  type: string
  text?: string
  state?: { status: string; output?: string }
}

export function applyCompressionToMessages(
  messages: { info: { role: string }; parts: MessageParts[] }[],
  config?: Partial<PipelineConfig>,
  store?: CcrStore,
): { tokens_consumed: number; tokens_saved: number; strategies: string[] } {
  const cfg: PipelineConfig = { ...DEFAULTS, ...config } as PipelineConfig
  const liveStart = cfg.live_zone_only ? findLiveZoneStart(messages) : 0

  let tokensConsumed = 0
  let tokensSaved = 0
  const strategies: string[] = []

  for (let i = liveStart; i < messages.length; i++) {
    const msg = messages[i]
    for (const part of msg.parts) {
      // Compress tool result outputs
      if (part.type === "tool" && part.state?.status === "completed" && part.state.output) {
        const result = compressPart(part.state.output, cfg, store)
        tokensConsumed += result.tokens_before
        if (result.didCompress) {
          part.state.output = result.text
          tokensSaved += result.tokens_before - result.tokens_after
          strategies.push(result.strategy)
        }
      }
      // Compress large text parts
      if (part.type === "text" && part.text) {
        const result = compressPart(part.text, cfg, store)
        tokensConsumed += result.tokens_before
        if (result.didCompress) {
          part.text = result.text
          tokensSaved += result.tokens_before - result.tokens_after
          strategies.push(result.strategy)
        }
      }
    }
  }

  return { tokens_consumed: tokensConsumed, tokens_saved: tokensSaved, strategies }
}

function compressPart(
  text: string,
  cfg: PipelineConfig,
  store?: CcrStore,
): { text: string; strategy: string; tokens_before: number; tokens_after: number; didCompress: boolean } {
  const tokensBefore = countTokensSync(text)

  if (tokensBefore < cfg.min_tokens_to_compress) {
    return { text, strategy: "passthrough_small", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
  }

  try {
    const detection = detectContentType(text)
    const { text: compressed, strategy } = dispatchCompressor(text, detection.content_type, store)
    const tokensAfter = countTokensSync(compressed)

    if (tokensAfter >= tokensBefore || compressed === text) {
      return { text, strategy: "passthrough_revert", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
    }
    return { text: compressed, strategy, tokens_before: tokensBefore, tokens_after: tokensAfter, didCompress: true }
  } catch {
    return { text, strategy: "passthrough_error", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
  }
}
