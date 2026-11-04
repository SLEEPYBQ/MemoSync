// Field semantics: OpenAI Chat Completions usage.prompt_tokens_details and
// https://api-docs.deepseek.com/api/create-chat-completion (hit + miss = prompt).
// This normalizer does not accept native Messages/Responses or SDK session totals.
export const CHAT_USAGE_NORMALIZER = "chat-completions-usage-v1"

type Counter = "input" | "output" | "cached" | "cacheWrite" | "uncached" | "reasoning"
interface Source { kind: "reported" | "derived"; fields: string[] }
export interface ChatUsage extends Partial<Record<Counter, number>> {
  normalizer: typeof CHAT_USAGE_NORMALIZER
  /** Chat usage describes one request. These are replacement snapshots, not deltas
   * or a native SDK's cumulative session/modelUsage totals. */
  basis: "per-request"
  sources: Partial<Record<Counter, Source>>
  /** Recognized numeric fields only; never echo arbitrary upstream strings. */
  reported: Record<string, number>
  diagnostics: { code: "invalid_counter" | "conflicting_counters" | "inconsistent_input"; fields: string[] }[]
}

export function normalizeChatUsage(value?: unknown): ChatUsage {
  const usage: ChatUsage = { normalizer: CHAT_USAGE_NORMALIZER, basis: "per-request", sources: {}, reported: {}, diagnostics: [] }
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const read = (path: string): number | undefined => {
    const v = path.split(".").reduce<unknown>((at, key) => at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined, raw)
    if (v === undefined) return undefined
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) { usage.reported[path] = v; return v }
    usage.diagnostics.push({ code: "invalid_counter", fields: [path] })
    return undefined
  }
  const counter = (key: Counter, paths: string[]) => {
    const measurements = paths.map(path => ({ path, value: read(path) })).filter((v): v is { path: string; value: number } => v.value !== undefined)
    const first = measurements[0]
    if (!first) return
    usage[key] = first.value
    usage.sources[key] = { kind: "reported", fields: [first.path] }
    if (measurements.some(m => m.value !== first.value)) usage.diagnostics.push({ code: "conflicting_counters", fields: measurements.map(m => m.path) })
  }
  counter("input", ["prompt_tokens"])
  counter("output", ["completion_tokens"])
  // DeepSeek documents hit + miss = prompt_tokens. Some relays expose both
  // spellings; prefer the provider-specific count and report any disagreement.
  counter("cached", ["prompt_cache_hit_tokens", "prompt_tokens_details.cached_tokens"])
  counter("cacheWrite", ["prompt_tokens_details.cache_write_tokens"])
  counter("reasoning", ["completion_tokens_details.reasoning_tokens"])
  const miss = read("prompt_cache_miss_tokens")
  const derive = (key: Counter, n: number, fields: string[]) => {
    usage[key] = n
    usage.sources[key] = { kind: "derived", fields }
  }
  if (usage.input === undefined && usage.cached !== undefined && miss !== undefined && Number.isSafeInteger(usage.cached + miss)) {
    derive("input", usage.cached + miss, [...usage.sources.cached!.fields, "prompt_cache_miss_tokens"])
  }
  const inconsistent = (fields: string[]) => usage.diagnostics.push({ code: "inconsistent_input", fields })
  if (usage.input !== undefined && usage.cached !== undefined && miss !== undefined && usage.cached + miss !== usage.input) {
    inconsistent(["prompt_tokens", ...usage.sources.cached!.fields, "prompt_cache_miss_tokens"])
  }
  if (usage.input !== undefined && (usage.cached ?? 0) + (usage.cacheWrite ?? 0) > usage.input) {
    inconsistent([...usage.sources.input!.fields, ...(usage.sources.cached?.fields ?? []), ...(usage.sources.cacheWrite?.fields ?? [])])
  }
  if (miss !== undefined && ((usage.input !== undefined && miss > usage.input) || (usage.cacheWrite !== undefined && usage.cacheWrite > miss))) {
    inconsistent(["prompt_cache_miss_tokens", ...(usage.sources.input?.fields ?? []), ...(usage.sources.cacheWrite?.fields ?? [])])
  }
  // A miss is not a write. In Chat accounting, writes are a subset of total
  // prompt tokens. Never add hit/miss/write counters to prompt_tokens.
  if (miss !== undefined && miss >= (usage.cacheWrite ?? 0)) {
    if (usage.cacheWrite === undefined) {
      usage.uncached = miss
      usage.sources.uncached = { kind: "reported", fields: ["prompt_cache_miss_tokens"] }
    } else derive("uncached", miss - usage.cacheWrite, ["prompt_cache_miss_tokens", ...usage.sources.cacheWrite!.fields])
  } else if (usage.input !== undefined && usage.cached !== undefined && usage.cacheWrite !== undefined && usage.input >= usage.cached + usage.cacheWrite) {
    derive("uncached", usage.input - usage.cached - usage.cacheWrite, [...usage.sources.input!.fields, ...usage.sources.cached!.fields, ...usage.sources.cacheWrite!.fields])
  }
  return usage
}
