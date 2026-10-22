import { createHash } from "node:crypto"
import type { Model } from "@mariozechner/pi-ai"
import { PI_REASONING_OPTIONS, type LlmProviderKind, type PiReasoningEffort } from "../shared/types"
import type { RegistryModelCard } from "../shared/model-capabilities"
import { loadModelsDevCatalog, type ModelsDevCatalog } from "./models-dev"

export interface RegistryConnection { provider: LlmProviderKind; baseUrl: string; apiKey: string }
export type RegistryModelLoader = ((connection: RegistryConnection, requestedModel?: string) => Promise<RegistryModelCard[]>) & {
  peek?: (connection: RegistryConnection, model: string) => RegistryModelCard | undefined
}
const validEfforts = new Set<string>(PI_REASONING_OPTIONS.map(option => option.id))
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
const price = (value: unknown) => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined
}

/** OpenRouter exposes exact efforts and mandatory/default flags on each model. */
export function parseRegistryModelCard(value: unknown): RegistryModelCard | null {
  const data = record(value)
  if (typeof data.id !== "string" || !data.id.trim()) return null
  const reasoning = record(data.reasoning)
  const mandatory = typeof reasoning.mandatory === "boolean" ? reasoning.mandatory : undefined
  const levels = Array.isArray(data.supported_reasoning_levels) ? data.supported_reasoning_levels.map(v => typeof v === "string" ? v : record(v).effort) : []
  const options = Array.isArray(data.reasoning_options) ? data.reasoning_options.map(record) : []
  const effort = options.find(o => o.type === "effort")
  const declared = [...strings(reasoning.supported_efforts), ...levels.filter((v): v is string => typeof v === "string"), ...strings(effort?.values)].map(e => e === "none" ? "off" : e)
  let efforts = [...new Set(declared.filter((e): e is PiReasoningEffort => validEfforts.has(e) && e !== "default" && (!mandatory || e !== "off")))]
  const parameters = Array.isArray(data.supported_parameters) ? strings(data.supported_parameters) : undefined
  const nonReasoning = data.reasoning === false || (parameters && !parameters.some(p => p === "reasoning" || p === "reasoning_effort"))
  if (nonReasoning) efforts = ["off"]
  else if (!efforts.length) efforts = ["default"]
  const preferred = reasoning.default_enabled === false && !mandatory && efforts.includes("off") ? "off" : reasoning.default_effort === "none" ? "off" : reasoning.default_effort
  const defaultEffort = efforts.includes(preferred as PiReasoningEffort) ? preferred as PiReasoningEffort : efforts.includes("default") ? "default" : efforts.includes("medium") ? "medium" : efforts[0]!
  const pricing = record(data.pricing)
  const input = record(data.architecture).input_modalities ?? record(data.modalities).input
  const explicitLevels = Array.isArray(reasoning.supported_efforts) || Array.isArray(data.supported_reasoning_levels) || !!effort
  return {
    id: data.id.trim(), label: typeof data.name === "string" ? data.name : typeof data.display_name === "string" ? data.display_name : data.id.trim(),
    supportsEffort: efforts.some(e => e !== "off" && e !== "default"),
    reasoningEfforts: efforts, defaultReasoningEffort: defaultEffort, reasoningMandatory: mandatory,
    reasoningKind: nonReasoning ? "none" : declared.length ? "effort" : explicitLevels ? "unlevelled"
      : options.some(o => o.type === "toggle") ? "toggle" : options.some(o => o.type === "budget_tokens") ? "budget" : "unknown",
    reasoningDefaultEnabled: typeof reasoning.default_enabled === "boolean" ? reasoning.default_enabled : undefined,
    preferredReasoningEffort: typeof preferred === "string" && validEfforts.has(preferred) ? preferred as PiReasoningEffort : undefined,
    supportsStructuredOutput: typeof data.structured_output === "boolean" ? data.structured_output : parameters ? parameters.includes("structured_outputs") && parameters.includes("response_format") : undefined,
    metadataSource: "provider", contextWindow: positive(data.context_length) ?? positive(data.context_window),
    maxTokens: positive(record(data.top_provider).max_completion_tokens) ?? positive(data.max_output_tokens),
    inputModalities: Array.isArray(input) ? strings(input) : undefined,
    ...(Object.keys(pricing).length ? { cost: { input: price(pricing.prompt), output: price(pricing.completion), cacheRead: price(pricing.input_cache_read), cacheWrite: price(pricing.input_cache_write) } } : {}),
  }
}

/** Fill absent fields only. Reasoning records are merged as a unit, with live constraints kept. */
export function mergeRegistryModelCard(live: RegistryModelCard, supplement?: RegistryModelCard, reasoningOnly = false): RegistryModelCard {
  if (!supplement) return live
  const unknown = live.reasoningKind === "unknown" || (!live.reasoningKind && live.reasoningEfforts.includes("default"))
  const merged: RegistryModelCard = reasoningOnly ? { ...live } : {
    ...live,
    contextWindow: live.contextWindow ?? supplement.contextWindow,
    maxTokens: live.maxTokens ?? supplement.maxTokens,
    inputModalities: live.inputModalities ?? supplement.inputModalities,
    supportsStructuredOutput: live.supportsStructuredOutput ?? supplement.supportsStructuredOutput,
    cost: live.cost || supplement.cost ? {
      input: live.cost?.input ?? supplement.cost?.input,
      output: live.cost?.output ?? supplement.cost?.output,
      cacheRead: live.cost?.cacheRead ?? supplement.cost?.cacheRead,
      cacheWrite: live.cost?.cacheWrite ?? supplement.cost?.cacheWrite,
    } : undefined,
  }
  if (unknown && supplement.reasoningKind !== "unknown") {
    merged.reasoningEfforts = supplement.reasoningEfforts.filter(e => !live.reasoningMandatory || e !== "off")
    if (!merged.reasoningEfforts.length) merged.reasoningEfforts = ["default"]
    merged.reasoningKind = supplement.reasoningKind
    merged.reasoningMandatory = live.reasoningMandatory ?? supplement.reasoningMandatory
    merged.reasoningDefaultEnabled = live.reasoningDefaultEnabled ?? supplement.reasoningDefaultEnabled
    const preferred = merged.reasoningDefaultEnabled === false && !merged.reasoningMandatory
      ? "off" : live.preferredReasoningEffort ?? supplement.defaultReasoningEffort
    merged.defaultReasoningEffort = merged.reasoningEfforts.includes(preferred) ? preferred : merged.reasoningEfforts.find(e => e !== "off") ?? merged.reasoningEfforts[0]!
    merged.supportsEffort = merged.reasoningEfforts.some(e => e !== "off" && e !== "default")
    merged.metadataSource = supplement.metadataSource
  }
  return merged
}

export function piModelCard(model: Model<any>, levels: readonly string[]): RegistryModelCard {
  const efforts = levels.map(level => model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap] === "max" ? "max" : level).filter((level): level is PiReasoningEffort => validEfforts.has(level))
  if (!efforts.length) efforts.push("default")
  return { id: model.id, label: model.name, supportsEffort: model.reasoning, reasoningEfforts: efforts,
    defaultReasoningEffort: efforts.includes("medium") ? "medium" : efforts[0]!, metadataSource: "pi", reasoningKind: !model.reasoning ? "none" : efforts.includes("default") ? "unknown" : "effort",
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputModalities: model.input, cost: model.cost }
}

/** Cache per endpoint AND credential without retaining the credential in keys. */
export function createRegistryModelLoader(deps: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: () => number; fallback?: (connection: RegistryConnection) => Promise<RegistryModelCard[]>; catalog?: () => Promise<ModelsDevCatalog> } = {}) {
  const cache = new Map<string, { models: RegistryModelCard[]; expires: number; pending?: Promise<RegistryModelCard[]>; catalog?: ModelsDevCatalog; fallback?: RegistryModelCard[] }>()
  const connectionKey = (connection: RegistryConnection) => `${connection.provider}:${connection.baseUrl.replace(/\/+$/, "")}:${createHash("sha256").update(connection.apiKey).digest("hex")}`
  const getCatalog = deps.catalog ?? loadModelsDevCatalog
  const getFallback = deps.fallback ?? bundledModelCards
  function decorate(models: RegistryModelCard[], connection: RegistryConnection, catalog: ModelsDevCatalog, fallback: RegistryModelCard[]) {
    const bundled = new Map(fallback.map(m => [m.id, m]))
    return models.map(live => {
      const match = catalog.lookup(connection, live.id)
      const exact = match?.scope === "provider" ? match.card : undefined
      const card = mergeRegistryModelCard(mergeRegistryModelCard(live, exact), bundled.get(live.id))
      return match?.scope === "model" ? mergeRegistryModelCard(card, match.card, true) : card
    })
  }
  const getModels = async (connection: RegistryConnection): Promise<RegistryModelCard[]> => {
    const now = deps.now ?? Date.now
    const baseUrl = connection.baseUrl.replace(/\/+$/, "")
    const key = connectionKey(connection)
    let entry = cache.get(key)
    if (entry?.pending) return entry.pending
    if (entry && entry.expires > now()) return entry.models
    if (!entry) {
      if (cache.size >= 8) cache.delete(cache.keys().next().value!)
      entry = { models: [], expires: 0 }; cache.set(key, entry)
    }
    const current = entry
    current.pending = (async () => {
      const readLive = async () => {
        const response = await (deps.fetch ?? fetch)(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${connection.apiKey}` }, signal: AbortSignal.timeout(3_000) })
        if (!response.ok) throw new Error("Model catalog unavailable")
        const data = record(await response.json())
        if (!Array.isArray(data.data) || !data.data.length) throw new Error("Invalid model catalog")
        const models = data.data.map(parseRegistryModelCard).filter((m): m is RegistryModelCard => m !== null)
        if (!models.length) throw new Error("Invalid model catalog")
        return models
      }
      const [catalog, fallback, models] = await Promise.all([getCatalog(), getFallback(connection), readLive().catch(() => undefined)])
      current.catalog = catalog
      current.fallback = fallback
      if (models) {
        current.models = decorate(models, connection, catalog, fallback)
        current.expires = now() + 5 * 60_000
      } else {
        if (!current.models.length) current.models = decorate(fallback, connection, catalog, [])
        current.expires = now() + 30_000
      }
      return current.models
    })().finally(() => { current.pending = undefined })
    return current.pending
  }
  const load = async (connection: RegistryConnection, requestedModel?: string): Promise<RegistryModelCard[]> => {
    const models = await getModels(connection)
    if (!requestedModel || models.some(m => m.id === requestedModel)) return models
    const live = parseRegistryModelCard({ id: requestedModel })
    if (!live) return models
    const [catalog, fallback] = await Promise.all([getCatalog(), getFallback(connection)])
    const current = cache.get(connectionKey(connection))
    if (current) { current.catalog = catalog; current.fallback = fallback }
    // A manually entered model stays on this endpoint with its original ID.
    return [...models, ...decorate([live], connection, catalog, fallback)]
  }
  return Object.assign(load, {
    // No I/O here: a turn can use stale metadata while a refresh is pending.
    peek(connection: RegistryConnection, model: string): RegistryModelCard | undefined {
      const current = cache.get(connectionKey(connection))
      const listed = current?.models.find(card => card.id === model)
      if (listed) return listed
      if (!current?.catalog) return undefined
      const live = parseRegistryModelCard({ id: model })
      return live ? decorate([live], connection, current.catalog, current.fallback ?? [])[0] : undefined
    },
  })
}

async function bundledModelCards(connection: RegistryConnection): Promise<RegistryModelCard[]> {
  // Never borrow catalog routing or capabilities for a custom endpoint.
  const official = (connection.provider === "openrouter" && connection.baseUrl.replace(/\/+$/, "") === "https://openrouter.ai/api/v1")
    || (connection.provider === "openai" && connection.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1")
  if (!official) return []
  const { getModels, getSupportedThinkingLevels } = await import("@mariozechner/pi-ai")
  return getModels(connection.provider as "openai" | "openrouter").map(model => piModelCard(model, getSupportedThinkingLevels(model)))
}

export const loadRegistryModels = createRegistryModelLoader()
