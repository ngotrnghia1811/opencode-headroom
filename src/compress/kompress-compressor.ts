// ─── KompressCompressor: ONNX ML-based extractive text compression ──
// Faithful port of headroom v0.24.0 kompress_compressor.py:595-761
// Model: chopratejas/kompress-base (ModernBERT + dual-head ONNX)
// Tokenizer: answerdotai/ModernBERT-base
//
// Requires: onnxruntime-node (already in dependencies)
//           @xenova/transformers (peer/dev dependency — AutoTokenizer)

import type { CcrStore } from "../ccr/store"
import { deriveKey } from "../ccr/hash"

const HF_MODEL_REPO = "chopratejas/kompress-base"
const HF_ONNX_FILE = "onnx/kompress-int8.onnx"
const HF_TOKENIZER_REPO = "answerdotai/ModernBERT-base"
const HF_DOWNLOAD_BASE = "https://huggingface.co"

export interface KompressConfig {
  model_id?: string        // default HF_MODEL_REPO
  chunk_words?: number     // default 350 (headroom KompressConfig default)
  enable_ccr?: boolean     // default true
  target_ratio?: number    // if set, keep top-K words; else use score>0.5 threshold
  score_threshold?: number // default 0.5
}

export interface KompressResult {
  compressed: string
  original: string
  original_tokens: number
  compressed_tokens: number
  compression_ratio: number
  model_used: string
  cache_key?: string  // CCR hash if stored
}

// ─── Model cache (singleton, per-process) ────────────────────────────

let _cache: { model: KompressModel; tokenizer: KompressTokenizer } | null = null

interface KompressModel {
  get_scores(input_ids: number[][], attention_mask: number[][]): Promise<number[][]>
  get_keep_mask(input_ids: number[][], attention_mask: number[][]): Promise<boolean[][]>
}

interface KompressTokenizer {
  (texts: string[], opts: TokenizerOpts): Promise<TokenizerEncoding>
}

interface TokenizerOpts {
  is_split_into_words: boolean
  truncation: boolean
  max_length: number
  padding: boolean
}

interface TokenizerEncoding {
  input_ids: { data: Int32Array | BigInt64Array }
  attention_mask: { data: Int32Array | BigInt64Array }
  word_ids(): (number | null)[]
}

async function _loadModel(config: KompressConfig): Promise<{ model: KompressModel; tokenizer: KompressTokenizer }> {
  if (_cache) return _cache

  const ort = require("onnxruntime-node")
  const { AutoTokenizer } = await import("@xenova/transformers")

  const cacheDir = `${Bun.env.HOME || "/tmp"}/.cache/opencode-headroom/kompress/`
  await Bun.$`mkdir -p ${cacheDir}`.quiet()

  // Download ONNX model
  const onnxUrl = `${HF_DOWNLOAD_BASE}/${config.model_id || HF_MODEL_REPO}/resolve/main/${HF_ONNX_FILE}`
  const onnxPath = `${cacheDir}kompress-int8.onnx`

  const onnxFile = Bun.file(onnxPath)
  if (!(await onnxFile.exists())) {
    const response = await fetch(onnxUrl)
    if (!response.ok) throw new Error(`Failed to download ONNX model: ${response.status} ${response.statusText}`)
    await Bun.write(onnxPath, response)
  }

  // Create ONNX inference session (CPU only — matching headroom's ONNX path)
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  })

  const model: KompressModel = {
    async get_scores(input_ids: number[][], attention_mask: number[][]): Promise<number[][]> {
      const batchSize = input_ids.length
      const seqLen = input_ids[0].length
      const flatIds = input_ids.flat().map(BigInt)
      const flatMask = attention_mask.flat().map(BigInt)

      const feeds = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(flatIds), [batchSize, seqLen]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(flatMask), [batchSize, seqLen]),
      }
      const results = await session.run(feeds)
      const scores = results.final_scores.data as Float32Array

      const out: number[][] = []
      for (let b = 0; b < batchSize; b++) {
        out.push(Array.from(scores.slice(b * seqLen, (b + 1) * seqLen)))
      }
      return out
    },

    async get_keep_mask(input_ids: number[][], attention_mask: number[][]): Promise<boolean[][]> {
      const scores = await this.get_scores(input_ids, attention_mask)
      return scores.map(row => row.map(s => s > 0.5))
    },
  }

  const tokenizer = await AutoTokenizer.from_pretrained(HF_TOKENIZER_REPO) as unknown as KompressTokenizer

  _cache = { model, tokenizer }
  return _cache
}

// ─── compressText — main entry point ─────────────────────────────────

export async function compressText(
  content: string,
  config?: KompressConfig,
  store?: CcrStore,
): Promise<KompressResult | null> {
  const cfg: Required<KompressConfig> = {
    model_id: HF_MODEL_REPO,
    chunk_words: 350,
    enable_ccr: true,
    score_threshold: 0.5,
    ...config,
  }

  const words = content.split(/\s+/)
  const n_words = words.length

  // Passthrough for very short text (headroom kompress_compressor.py:620)
  if (n_words < 10) return null

  try {
    const { model, tokenizer } = await _loadModel(cfg)

    const kept_ids = new Set<number>()
    const max_chunk_words = cfg.chunk_words

    for (let chunk_start = 0; chunk_start < n_words; chunk_start += max_chunk_words) {
      const chunk_words = words.slice(chunk_start, chunk_start + max_chunk_words)

      // Tokenize: is_split_into_words=true, truncation=true, max_length=512, padding=true
      // Headroom: return_tensors="np" for ONNX path
      const encoding = await tokenizer(chunk_words, {
        is_split_into_words: true,
        truncation: true,
        max_length: 512,
        padding: true,
      })

      const input_ids: number[][] = [Array.from(encoding.input_ids.data as any, Number)]
      const attention_mask: number[][] = [Array.from(encoding.attention_mask.data as any, Number)]

      const word_ids: (number | null)[] = encoding.word_ids()

      if (cfg.target_ratio !== undefined) {
        // Top-K by score
        const scores: number[] = (await model.get_scores(input_ids, attention_mask))[0]

        const word_scores = new Map<number, number>()
        for (let idx = 0; idx < word_ids.length; idx++) {
          const wid = word_ids[idx]
          if (wid === null) continue
          const s = scores[idx]
          if (!word_scores.has(wid) || s > word_scores.get(wid)!) {
            word_scores.set(wid, s)
          }
        }

        if (word_scores.size > 0) {
          const sorted = [...word_scores.entries()].sort((a, b) => b[1] - a[1])
          const num_keep = Math.max(1, Math.floor(sorted.length * cfg.target_ratio))
          for (let i = 0; i < num_keep; i++) {
            kept_ids.add(sorted[i][0] + chunk_start)
          }
        }
      } else {
        // Threshold-based: keep_mask (score > 0.5)
        const keep_mask: boolean[] = (await model.get_keep_mask(input_ids, attention_mask))[0]

        for (let idx = 0; idx < word_ids.length; idx++) {
          const wid = word_ids[idx]
          if (wid === null) continue
          if (keep_mask[idx]) {
            kept_ids.add(wid + chunk_start)
          }
        }
      }
    }

    if (kept_ids.size === 0) return null

    const compressed_words = [...kept_ids].sort((a, b) => a - b).map(w => words[w]).filter(Boolean)
    const compressed = compressed_words.join(" ")
    const compressed_count = compressed_words.length
    const ratio = compressed_count / n_words

    const result: KompressResult = {
      compressed,
      original: content,
      original_tokens: n_words,
      compressed_tokens: compressed_count,
      compression_ratio: ratio,
      model_used: cfg.model_id,
    }

    // CCR injection (headroom kompress_compressor.py:734-742)
    // enable_ccr && ratio < 0.8
    if (cfg.enable_ccr && ratio < 0.8 && store) {
      const cache_key = deriveKey(content)
      store.put(cache_key, content)
      result.cache_key = cache_key
      result.compressed += `\n[${n_words} items compressed to ${compressed_count}. Retrieve more: hash=${cache_key}]`
    }

    return result

  } catch (e) {
    // Fail-open (headroom kompress_compressor.py:759-761)
    console.warn("Kompress compression failed:", e)
    return null
  }
}
