import { detectContentType } from "./content-detector"
import { compressLog } from "./log-compressor"
import { compressSearch } from "./search-compressor"
import { compressDiff } from "./diff-compressor"
import { crushJsonArray } from "./smart-crusher"
import { compressText } from "./kompress-compressor"
import { countTokensSync } from "../util/tokens"
import { ContentType } from "./types"
import type { CcrStore } from "../ccr/store"
import { isMixedContent, splitIntoSections } from "./mixed-content"
import type { CompressionCache } from "./compression-cache"

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
  tokensBefore: number
  tokensAfter: number
  strategies: string[]
}

// ─── Internal dispatch: contentType → compressor + strategy name ───

async function dispatchCompressor(
  text: string,
  contentType: ContentType,
  store?: CcrStore,
): Promise<{ text: string; strategy: string }> {
  switch (contentType) {
    case ContentType.JsonArray: {
      const result = await crushJsonArray(text, undefined, store, undefined)
      return { text: result, strategy: "smart_crusher" }
    }
    case ContentType.Prose: {
      const result = await compressText(text, undefined, store)
      if (!result) return { text, strategy: "passthrough" }
      // Token-monotone: verify compression actually shrinks
      if (result.compressed_tokens >= result.original_tokens || result.compressed.length >= result.original.length) {
        return { text, strategy: "passthrough" }
      }
      return { text: result.compressed, strategy: "kompress" }
    }
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

// ─── Single block compression (fail-open, no min-tokens check) ──────

/**
 * Compress a single text block (e.g. tool result). Fail-open.
 * Returns null if compression fails or content type is PlainText.
 */
export async function compressBlock(
  text: string,
  store?: CcrStore,
  cache?: CompressionCache,
): Promise<CompressBlockResult | null> {
  if (!text) return null

  const tokensBefore = countTokensSync(text)

  // Tier 1: known non-compressible — instant skip
  if (cache?.isSkipped(text)) return null

  // Tier 2: cached compressed result
  if (cache) {
    const cached = cache.get(text)
    if (cached) {
      const tokensAfter = countTokensSync(cached.compressed)
      return { compressed: cached.compressed, tokensBefore, tokensAfter, strategies: [cached.strategy] }
    }
  }

  // Mixed-content detection: split and compress sections independently
  if (isMixedContent(text)) {
    const sections = splitIntoSections(text)
    const compressedSections: string[] = []
    let totalAfter = 0
    const strategies: string[] = []

    for (const section of sections) {
      if (section.content_type === ContentType.PlainText || section.content_type === ContentType.SourceCode) {
        compressedSections.push(section.content)
        totalAfter += section.content.length
        continue
      }
      const result = await dispatchCompressor(section.content, section.content_type, store)
      compressedSections.push(result.text)
      totalAfter += result.text.length
      strategies.push(result.strategy)
    }

    // Token-monotone guard on reassembled output
    if (totalAfter < text.length) {
      const compressed = compressedSections.join("\n")
      const tokensAfter = countTokensSync(compressed)
      const strategy = ["mixed", ...strategies]
      if (cache) cache.put(text, compressed, compressed.length / text.length, strategy.join(","))
      return { compressed, tokensBefore, tokensAfter, strategies: strategy }
    }
    if (cache) cache.markSkip(text)
    return null
  }

  const detection = detectContentType(text)
  if (detection.content_type === ContentType.PlainText) {
    if (cache) cache.markSkip(text)
    return null
  }

  const { text: compressed, strategy } = await dispatchCompressor(text, detection.content_type, store)
  if (compressed === text) {
    if (cache) cache.markSkip(text)
    return null
  }

  const tokensAfter = countTokensSync(compressed)
  if (tokensAfter >= tokensBefore) {
    if (cache) cache.markSkip(text)
    return null
  }

  if (cache) cache.put(text, compressed, compressed.length / text.length, strategy)
  return { compressed, tokensBefore, tokensAfter, strategies: [strategy] }
}

// ─── Live zone identification ────────────────────────────────────────

export function findLiveZoneStart(messages: { info: { role: string }; parts: unknown[] }[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") return i
  }
  return messages.length
}

// ─── Main hook handler: mutate output.messages in place ──────────────

interface MessageParts {
  type: string
  text?: string
  state?: { status: string; output?: string }
}

export async function applyCompressionToMessages(
  messages: { info: { role: string }; parts: MessageParts[] }[],
  config?: Partial<PipelineConfig>,
  store?: CcrStore,
  cache?: CompressionCache,
): Promise<{ tokens_consumed: number; tokens_saved: number; strategies: string[] }> {
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
        const result = await compressPart(part.state.output, cfg, store, cache)
        tokensConsumed += result.tokens_before
        if (result.didCompress) {
          part.state.output = result.text
          tokensSaved += result.tokens_before - result.tokens_after
          strategies.push(result.strategy)
        }
      }
      // Compress large text parts
      if (part.type === "text" && part.text) {
        const result = await compressPart(part.text, cfg, store, cache)
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

async function compressPart(
  text: string,
  cfg: PipelineConfig,
  store?: CcrStore,
  cache?: CompressionCache,
): Promise<{ text: string; strategy: string; tokens_before: number; tokens_after: number; didCompress: boolean }> {
  const tokensBefore = countTokensSync(text)

  if (tokensBefore < cfg.min_tokens_to_compress) {
    return { text, strategy: "passthrough_small", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
  }

  // Tier 1: known non-compressible — instant skip
  if (cache?.isSkipped(text)) {
    return { text, strategy: "passthrough_skip_cache", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
  }

  // Tier 2: cached compressed result
  if (cache) {
    const cached = cache.get(text)
    if (cached) {
      const tokensAfter = countTokensSync(cached.compressed)
      return { text: cached.compressed, strategy: cached.strategy, tokens_before: tokensBefore, tokens_after: tokensAfter, didCompress: true }
    }
  }

  try {
    const detection = detectContentType(text)
    const { text: compressed, strategy } = await dispatchCompressor(text, detection.content_type, store)
    const tokensAfter = countTokensSync(compressed)

    if (tokensAfter >= tokensBefore || compressed === text) {
      if (cache) cache.markSkip(text)
      return { text, strategy: "passthrough_revert", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
    }
    if (cache) cache.put(text, compressed, compressed.length / text.length, strategy)
    return { text: compressed, strategy, tokens_before: tokensBefore, tokens_after: tokensAfter, didCompress: true }
  } catch {
    if (cache) cache.markSkip(text)
    return { text, strategy: "passthrough_error", tokens_before: tokensBefore, tokens_after: tokensBefore, didCompress: false }
  }
}
