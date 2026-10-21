import { createHash } from "node:crypto"
import type { Model } from "@mariozechner/pi-ai"
import { PI_REASONING_OPTIONS, type LlmProviderKind, type PiReasoningEffort } from "../shared/types"
import type { RegistryModelCard } from "../shared/model-capabilities"

export interface RegistryConnection { provider: LlmProviderKind; baseUrl: string; apiKey: string }
const validEfforts = new Set<string>(PI_REASONING_OPTIONS.map(option => option.id))
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

/** OpenRouter exposes exact efforts and mandatory/default flags on each model. */
export function parseRegistryModelCard(value: unknown): RegistryModelCard | null {
  const data = record(value)
  if (typeof data.id !== "string" || !data.id.trim()) return null
  const reasoning = record(data.reasoning)
  const mandatory = reasoning.mandatory === true
  const declared = strings(reasoning.supported_efforts).map(e => e === "none" ? "off" : e)
  let efforts = [...new Set(declared.filter((e): e is PiReasoningEffort => validEfforts.has(e) && e !== "default" && (!mandatory || e !== "off")))]
  const parameters = Array.isArray(data.supported_parameters) ? strings(data.supported_parameters) : undefined
  const nonReasoning = data.reasoning === false || (parameters && !parameters.some(p => p === "reasoning" || p === "reasoning_effort"))
  if (!efforts.length) efforts = [nonReasoning ? "off" : "default"]
  const preferred = reasoning.default_enabled === false && !mandatory && efforts.includes("off") ? "off" : reasoning.default_effort === "none" ? "off" : reasoning.default_effort
  const defaultEffort = efforts.includes(preferred as PiReasoningEffort) ? preferred as PiReasoningEffort : efforts.includes("default") ? "default" : efforts.includes("medium") ? "medium" : efforts[0]!
  const pricing = record(data.pricing)
  const perMillion = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : 0 }
  return {
    id: data.id.trim(), label: typeof data.name === "string" ? data.name : data.id.trim(),
    supportsEffort: efforts.some(e => e !== "off" && e !== "default"),
    reasoningEfforts: efforts, defaultReasoningEffort: defaultEffort, reasoningMandatory: mandatory,
    supportsStructuredOutput: parameters?.includes("structured_outputs") && parameters.includes("response_format"),
    metadataSource: "provider", contextWindow: positive(data.context_length),
    maxTokens: positive(record(data.top_provider).max_completion_tokens),
    inputModalities: strings(record(data.architecture).input_modalities),
    ...(Object.keys(pricing).length ? { cost: { input: perMillion(pricing.prompt), output: perMillion(pricing.completion), cacheRead: perMillion(pricing.input_cache_read), cacheWrite: perMillion(pricing.input_cache_write) } } : {}),
  }
}

export function piModelCard(model: Model<any>, levels: readonly string[]): RegistryModelCard {
  const efforts = levels.map(level => model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap] === "max" ? "max" : level).filter((level): level is PiReasoningEffort => validEfforts.has(level))
  if (!efforts.length) efforts.push("default")
  return { id: model.id, label: model.name, supportsEffort: model.reasoning, reasoningEfforts: efforts,
    defaultReasoningEffort: efforts.includes("medium") ? "medium" : efforts[0]!, metadataSource: "pi",
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputModalities: model.input, cost: model.cost }
}

/** Cache per endpoint AND credential without retaining the credential in keys. */
export function createRegistryModelLoader(deps: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: () => number; fallback?: (connection: RegistryConnection) => Promise<RegistryModelCard[]> } = {}) {
  const cache = new Map<string, { models: RegistryModelCard[]; expires: number; pending?: Promise<RegistryModelCard[]> }>()
  return async (connection: RegistryConnection): Promise<RegistryModelCard[]> => {
    const now = deps.now ?? Date.now
    const baseUrl = connection.baseUrl.replace(/\/+$/, "")
    const key = `${connection.provider}:${baseUrl}:${createHash("sha256").update(connection.apiKey).digest("hex")}`
    let entry = cache.get(key)
    if (entry?.pending) return entry.pending
    if (entry && entry.expires > now()) return entry.models
    if (!entry) {
      if (cache.size >= 8) cache.delete(cache.keys().next().value!)
      entry = { models: [], expires: 0 }; cache.set(key, entry)
    }
    const current = entry
    current.pending = (async () => {
      try {
        const response = await (deps.fetch ?? fetch)(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${connection.apiKey}` }, signal: AbortSignal.timeout(3_000) })
        if (!response.ok) throw new Error("Model catalog unavailable")
        const data = record(await response.json())
        if (!Array.isArray(data.data) || !data.data.length) throw new Error("Invalid model catalog")
        const models = data.data.map(parseRegistryModelCard).filter((m): m is RegistryModelCard => m !== null)
        if (!models.length) throw new Error("Invalid model catalog")
        const fallback = await (deps.fallback ?? bundledModelCards)(connection)
        const known = new Map(fallback.map(m => [m.id, m]))
        // Plain OpenAI /models entries only contain IDs; retain exact bundled metadata.
        current.models = models.map(m => m.reasoningEfforts[0] === "default" && known.has(m.id) ? { ...known.get(m.id)!, label: m.label } : m)
        current.expires = now() + 5 * 60_000
      } catch {
        if (!current.models.length) current.models = await (deps.fallback ?? bundledModelCards)(connection)
        current.expires = now() + 30_000
      }
      return current.models
    })().finally(() => { current.pending = undefined })
    return current.pending
  }
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
