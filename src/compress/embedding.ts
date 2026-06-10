// ─── Embedding model for BM25+embedding hybrid scoring ─────────────
// Faithful port of headroom-core/src/relevance/embedding.rs (v0.24.0)
// Model: BAAI/bge-small-en-v1.5 via @xenova/transformers (same weights as fastembed-rs)
// Falls back to zero vector when model is not available.
// @xenova/transformers is an optionalDependency — plugin loads without it.

const MODEL_NAME = "Xenova/bge-small-en-v1.5"

export interface EmbeddingModel {
  embed(text: string): Promise<Float32Array>
  similarity(a: string, b: string): Promise<number>
  readonly ready: boolean
  readonly modelName: string
}

// ─── Lazy model loader (avoids eager import of optional dep) ─────────

let _modelPromise: Promise<any | null> | null = null

function loadModel(): Promise<any | null> {
  if (_modelPromise !== null) return _modelPromise
  try {
    const pipelinePromise = import("@xenova/transformers").then(({ pipeline }) =>
      (pipeline as Function)("feature-extraction", MODEL_NAME),
    )
    _modelPromise = pipelinePromise.catch(() => null)
  } catch {
    _modelPromise = Promise.resolve(null)
  }
  return _modelPromise
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

// ─── BGE-small-en-v1.5 model via @xenova/transformers (lazy) ─────────

function createBgeModel(): EmbeddingModel {
  let extractor: any | null = null
  let ready = false
  let initStarted = false
  let initDone = false
  const cache = new Map<string, Float32Array>()

  async function ensureModel(): Promise<void> {
    if (initDone) return
    if (initStarted) return  // already loading; embed() will re-check after
    initStarted = true
    const model = await loadModel()
    extractor = model
    ready = model !== null
    initDone = true
  }

  const model: EmbeddingModel = {
    modelName: MODEL_NAME,

    get ready() { return ready },

    async embed(text: string): Promise<Float32Array> {
      const cached = cache.get(text)
      if (cached) return cached

      await ensureModel()

      const ext = extractor
      if (!ext || !ready) return new Float32Array(384)  // zero vector fallback

      const result = await ext(text, { pooling: "mean", normalize: true })
      const vec = new Float32Array(result.data)
      cache.set(text, vec)
      return vec
    },

    async similarity(a: string, b: string): Promise<number> {
      if (!ready) {
        // If not yet tried, attempt lazy load
        if (!initDone) await ensureModel()
        if (!ready) return 0.5  // neutral fallback (headroom: BM25-fallback boost handles this)
      }

      const [vecA, vecB] = await Promise.all([this.embed(a), this.embed(b)])
      // Vectors are already L2-normalized by the pipeline, so dot product = cosine similarity
      let dot = 0
      for (let i = 0; i < vecA.length; i++) dot += vecA[i] * vecB[i]
      return Math.max(0, Math.min(1, dot))
    },
  }

  return model
}
