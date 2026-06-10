import { tool } from "@opencode-ai/plugin"
import type { CcrStore } from "../ccr/store"

export function createRetrieveTool(store: CcrStore) {
  return tool({
    description:
      "Retrieve the original (uncompressed) content for a <<ccr:HASH>> marker inserted by headroom compression. " +
      "Use this when you need to see the full content that was compressed in a previous tool output.",
    args: {
      hash: tool.schema
        .string()
        .describe("The 24-character hex hash from a <<ccr:HASH>> marker"),
    },
    async execute(args) {
      const original = store.get(args.hash)
      if (!original) {
        return {
          title: `CCR Retrieve: ${args.hash.slice(0, 8)}... (not found)`,
          output: `No cached content found for hash ${args.hash}. The entry may have expired (TTL: 5 minutes) or the hash is invalid.`,
        }
      }
      return {
        title: `CCR Retrieve: ${args.hash.slice(0, 8)}...`,
        output: original,
      }
    },
  })
}
