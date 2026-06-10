let enc: { encode(t: string): Uint32Array } | null = null
let initialized = false

async function getEncoder(): Promise<{ encode(t: string): Uint32Array } | null> {
  if (initialized) return enc
  initialized = true
  try {
    const mod = await import("js-tiktoken")
    enc = (mod as { get_encoding(name: string): { encode(t: string): Uint32Array } }).get_encoding("cl100k_base")
  } catch {
    enc = null
  }
  return enc
}

export async function countTokens(text: string): Promise<number> {
  const encoder = await getEncoder()
  if (encoder) return encoder.encode(text).length
  return Math.ceil(text.length / 4)
}

export function countTokensSync(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Tries the real tokenizer, falls back to char/4 estimate. */
export async function countTokensSafe(text: string): Promise<number> {
  try {
    return await countTokens(text)
  } catch {
    return countTokensSync(text)
  }
}
