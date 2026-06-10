import { describe, test, expect } from "bun:test"
import { createEmbeddingModel, getEmbeddingModel, type EmbeddingModel } from "../compress/embedding"

describe("Embedding Model (BGE-small-en-v1.5)", () => {
  // ─── 1. Model has correct modelName ────────────────────────────────

  test("modelName is Xenova/bge-small-en-v1.5", () => {
    const model = createEmbeddingModel()
    expect(model.modelName).toBe("Xenova/bge-small-en-v1.5")
  })

  // ─── 2. ready is false initially (before model loads) ──────────────

  test("model.ready is false initially", () => {
    const model = createEmbeddingModel()
    expect(model.ready).toBe(false)
  })

  // ─── 3. similarity returns 0.5 when not ready (neutral fallback) ───

  test("similarity returns neutral 0.5 when model not ready", async () => {
    const model = createEmbeddingModel()
    const sim = await model.similarity("hello world", "hello world")
    expect(sim).toBe(0.5)
  })

  // ─── 4. embed returns 384-dim vector ───────────────────────────────

  test("embed returns 384-dim Float32Array", async () => {
    const model = createEmbeddingModel()
    const vec = await model.embed("test text")
    expect(vec.length).toBe(384)
    expect(vec).toBeInstanceOf(Float32Array)
    // Vector may be zero (model not loaded) or have values (model loaded)
    // Both are valid behaviors
  })

  // ─── 5. Singleton: getEmbeddingModel returns same instance ─────────

  test("getEmbeddingModel returns same instance on repeated calls", () => {
    const model1 = getEmbeddingModel()
    const model2 = getEmbeddingModel()
    expect(model1).toBe(model2)
  })

  // ─── 6. similarity returns number in [0, 1] ────────────────────────

  test("similarity returns value in [0, 1] range", async () => {
    const model = createEmbeddingModel()
    const sim = await model.similarity("a", "b")
    expect(sim).toBeGreaterThanOrEqual(0)
    expect(sim).toBeLessThanOrEqual(1)
  })
})
