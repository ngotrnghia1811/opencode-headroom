import { createHash } from "node:crypto"

export function deriveKey(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 24)
}

export function extractCcrHashes(text: string): string[] {
  const hashes: string[] = []
  const MARKER = "<<ccr:"
  const MARKER_END = ">>"
  let start = text.indexOf(MARKER)
  while (start !== -1) {
    const end = text.indexOf(MARKER_END, start + MARKER.length)
    if (end === -1) break
    hashes.push(text.slice(start + MARKER.length, end))
    start = text.indexOf(MARKER, end + MARKER_END.length)
  }
  return hashes
}

export function ccrMarker(hash: string): string {
  return `<<ccr:${hash}>>`
}
