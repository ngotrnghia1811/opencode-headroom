export const ContentType = {
  JsonArray: "json_array",
  SourceCode: "source_code",
  SearchResults: "search",
  BuildOutput: "build",
  GitDiff: "diff",
  Html: "html",
  PlainText: "text",
} as const
export type ContentType = (typeof ContentType)[keyof typeof ContentType]

export interface DetectionResult {
  content_type: ContentType
  confidence: number
  metadata: Record<string, unknown>
}

export interface CompressResult {
  compressed: string
  tokens_before: number
  tokens_after: number
  strategy: string
}

export interface PipelineResult {
  compressed_messages: { info: unknown; parts: unknown[] }[]
  tokens_before: number
  tokens_after: number
  strategies: string[]
  warnings: string[]
}
