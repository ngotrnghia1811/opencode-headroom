export interface CompressorConfig {
  smart_crusher?: boolean    // default true — JSON array compression
  log?: boolean              // default true — build/test log compression
  search?: boolean           // default true — grep/ripgrep output compression
  diff?: boolean             // default true — git diff compression
  kompress?: boolean         // default true — prose text compression (requires onnxruntime-node)
}

export interface CompressorParams {
  smart_crusher?: {
    min_items_to_analyze?: number
    max_items?: number
    first_fraction?: number
    last_fraction?: number
  }
  log?: {
    max_errors?: number
    error_context_lines?: number
    max_stack_traces?: number
    stack_trace_max_lines?: number
    max_warnings?: number
    max_total_lines?: number
  }
  search?: {
    max_matches_per_file?: number
    max_files?: number
    max_total_matches?: number
  }
  diff?: {
    max_context_lines?: number
    max_hunks_per_file?: number
    max_files?: number
  }
  kompress?: {
    score_threshold?: number
    chunk_words?: number
    target_ratio?: number
  }
  ccr?: {
    capacity?: number
    ttl_seconds?: number
  }
}

export interface HeadroomOptions {
  enabled?: boolean
  min_tokens_to_compress?: number
  live_zone_only?: boolean
  verbose?: boolean
  cache_align?: boolean
  ccr_db_path?: string
  /** Enable real-time tool-result compression via tool.execute.after hook. Default true. */
  real_time?: boolean
  compressors?: CompressorConfig
  compressor_params?: CompressorParams
}

function extractBool(o: Record<string, unknown>, dottedPath: string, defaultVal: boolean): boolean {
  const parts = dottedPath.split(".")
  let current: unknown = o
  for (const part of parts) {
    if (current == null || typeof current !== "object") return defaultVal
    current = (current as Record<string, unknown>)[part]
  }
  if (typeof current !== "boolean") return defaultVal
  return current
}

export function parseOptions(options: unknown): HeadroomOptions {
  if (!options || typeof options !== "object") return {}
  const o = options as Record<string, unknown>
  return {
    enabled: o.enabled === false ? false : true,
    min_tokens_to_compress: typeof o.min_tokens_to_compress === "number" ? o.min_tokens_to_compress : 200,
    live_zone_only: o.live_zone_only !== false,
    verbose: Boolean(o.verbose),
    cache_align: o.cache_align !== false,
    ccr_db_path: typeof o.ccr_db_path === "string" ? o.ccr_db_path : undefined,
    real_time: o.real_time !== false,
    compressors: {
      smart_crusher: extractBool(o, "compressors.smart_crusher", true),
      log:           extractBool(o, "compressors.log", true),
      search:        extractBool(o, "compressors.search", true),
      diff:          extractBool(o, "compressors.diff", true),
      kompress:      extractBool(o, "compressors.kompress", true),
    },
    compressor_params: typeof o.compressor_params === "object" && o.compressor_params !== null
      ? o.compressor_params as CompressorParams
      : undefined,
  }
}
