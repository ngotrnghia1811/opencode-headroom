export interface HeadroomOptions {
  enabled?: boolean
  min_tokens_to_compress?: number
  live_zone_only?: boolean
  verbose?: boolean
  cache_align?: boolean
  ccr_db_path?: string
  /** Enable real-time tool-result compression via tool.execute.after hook. Default true. */
  real_time?: boolean
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
  }
}
