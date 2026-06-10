// ─── Embedding model for BM25+embedding hybrid scoring ─────────────
// Faithful port of headroom-core/src/relevance/embedding.rs (v0.24.0)
// Model: BAAI/bge-small-en-v1.5 via @xenova/transformers (same weights as fastembed-rs)
// Falls back to zero vector when model is not available.

const MODEL_NAME = "Xenova/bge-small-en-v1.5"

export interface EmbeddingModel {
  embed(text: string): Promise<Float32Array>
  similarity(a: string, b: string): Promise<number>
  readonly ready: boolean
  readonly modelName: string
}

// ─── Singleton ───────────────────────────────────────────────────────

let _singleton: EmbeddingModel | null = null

export function getEmbeddingModel(): EmbeddingModel {
  if (_singleton) return _singleton
  _singleton = createEmbeddingModel()
  return _singleton
}

// Legacy alias (used by pipeline / smart-crusher)
export function createEmbeddingModel(): EmbeddingModel {
  return createBgeModel()
}

// ─── BGE-small-en-v1.5 model via @xenova/transformers ────────────────

function createBgeModel(): EmbeddingModel {
  let extractor: any = null
  let ready = false
  let initPromise: Promise<void> | null = null
  const cache = new Map<string, Float32Array>()

  initPromise = (async () => {
    try {
      const { pipeline } = await import("@xenova/transformers")
      extractor = await (pipeline as Function)("feature-extraction", MODEL_NAME)
      ready = true
    } catch {
      ready = false
    }
  })()

  const model: EmbeddingModel = {
    modelName: MODEL_NAME,

    get ready() { return ready },

    async embed(text: string): Promise<Float32Array> {
      const cached = cache.get(text)
      if (cached) return cached

      if (initPromise) await initPromise

      const ext = extractor
      if (!ext || !ready) return new Float32Array(384)  // zero vector fallback

      const result = await ext(text, { pooling: "mean", normalize: true })
      const vec = new Float32Array(result.data)
      cache.set(text, vec)
      return vec
    },

    async similarity(a: string, b: string): Promise<number> {
      if (!ready) return 0.5  // neutral fallback (headroom: BM25-fallback boost handles this)

      const [vecA, vecB] = await Promise.all([this.embed(a), this.embed(b)])
      // Vectors are already L2-normalized by the pipeline, so dot product = cosine similarity
      let dot = 0
      for (let i = 0; i < vecA.length; i++) dot += vecA[i] * vecB[i]
      return Math.max(0, Math.min(1, dot))
    },
  }

  return model
}
