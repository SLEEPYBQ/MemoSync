import { getModelAccessService } from "./model-access/service"
import { compatibleEndpointForEngine } from "../shared/model-access"
import type {
  AgentProvider,
  ClaudeContextWindow,
  ClaudeModelOptions,
  CodexModelOptions,
  ModelOptions,
  PiModelOptions,
  ProviderCatalogEntry,
  ProviderModelOption,
  ServiceTier,
} from "../shared/types"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_PI_MODEL_OPTIONS,
  PROVIDERS,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isPiReasoningEffort,
  normalizeClaudeContextWindow,
  normalizePiModelId,
  normalizeProviderModelId
} from "../shared/types"
import { isCliIsolationEnabled, resolveCodexRuntimeModel } from "./provider-runtime"

const HARD_CODED_CODEX_MODELS: ProviderModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: false },
  { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportsEffort: false },
]

export interface ClaudeSdkModelInfo {
  value: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
}

function createServerProviders(): ProviderCatalogEntry[] {
  return PROVIDERS.map((provider) =>
    provider.id === "codex"
      ? {
          ...provider,
          defaultModel: "gpt-5.5",
          models: HARD_CODED_CODEX_MODELS,
        }
      : provider
  )
}

export const SERVER_PROVIDERS: ProviderCatalogEntry[] = createServerProviders()

export function deployedProviders(env: Readonly<Record<string, string | undefined>> = process.env): ProviderCatalogEntry[] {
  const access = getModelAccessService()
  if (access) return SERVER_PROVIDERS.map(provider => {
    const setup = access.setup(provider.id)
    const connections = access.connections().filter(c => compatibleEndpointForEngine(provider.id, c))
    const models: ProviderModelOption[] = connections.flatMap(c => c.models.map(m => ({
      id: m.id, label: m.label || m.id, supportsEffort: m.supportsReasoning ?? true,
      connectionId: c.id, vendor: c.name,
      ...(provider.id === "claude" && (m.contextWindow ?? 0) >= 1_000_000 ? { contextWindowOptions: [{ id: "1m" as const, label: "1M" }] } : {}),
    })))
    if (setup.access.mode === "account") {
      if (provider.id === "claude") models.unshift(...["sonnet", "opus", "haiku"].map(id => ({ id, label: id, supportsEffort: true })))
      if (provider.id === "codex") models.unshift(...HARD_CODED_CODEX_MODELS)
    }
    const connectionId = setup.access.mode === "connection" ? setup.access.connectionId : undefined
    const selected = connections.find(c => c.id === connectionId)
    const defaultModel = setup.access.mode === "connection" ? setup.access.defaultModel || selected?.models[0]?.id || "" : provider.id === "claude" ? "sonnet" : provider.defaultModel
    return { ...provider, models, defaultModel }
  })
  return SERVER_PROVIDERS.map((provider) => {
    if (provider.id !== "codex" || !isCliIsolationEnabled(env)) return provider
    try {
      const model = resolveCodexRuntimeModel(provider.defaultModel, env)
      return { ...provider, defaultModel: model, models: [{ id: model, label: model, supportsEffort: true }] }
    } catch {
      // A missing key is reported when that engine is started, not while reading UI state.
      return provider
    }
  })
}

export function resetServerProvidersForTests() {
  SERVER_PROVIDERS.splice(0, SERVER_PROVIDERS.length, ...createServerProviders())
}

function modelFamily(value: string) {
  const match = value.match(/^(?:claude-)?([a-z]+)(?:-|$)/i)
  return match?.[1]?.toLowerCase() ?? value.toLowerCase()
}

function sdkModelMatchScore(model: ClaudeSdkModelInfo, option: ProviderModelOption) {
  const modelValue = model.value.toLowerCase()
  if (modelValue === option.id.toLowerCase()) return 3
  if (option.aliases?.some((alias) => alias.toLowerCase() === modelValue)) return 2
  const optionKeys = [option.id, ...(option.aliases ?? [])].map(modelFamily)
  return optionKeys.includes(modelFamily(model.value)) ? 1 : 0
}

function findSdkModelForOption(models: readonly ClaudeSdkModelInfo[], option: ProviderModelOption) {
  let bestModel: ClaudeSdkModelInfo | undefined
  let bestScore = 0
  for (const model of models) {
    const score = sdkModelMatchScore(model, option)
    if (score > bestScore) {
      bestModel = model
      bestScore = score
    }
  }
  return bestModel
}

export function applyClaudeSdkModels(models: readonly ClaudeSdkModelInfo[]) {
  const claudeIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "claude")
  const claudeProvider = SERVER_PROVIDERS[claudeIndex]
  if (!claudeProvider) return false
  if (claudeProvider.defaultModel.startsWith("deepseek-")) return false

  const nextModels = claudeProvider.models.map((option) => {
    const sdkModel = findSdkModelForOption(models, option)
    if (!sdkModel) return option
    return {
      ...option,
      label: sdkModel.displayName?.trim() || option.label,
      supportsEffort: sdkModel.supportsEffort ?? option.supportsEffort,
    }
  })

  if (JSON.stringify(nextModels) === JSON.stringify(claudeProvider.models)) {
    return false
  }

  SERVER_PROVIDERS.splice(claudeIndex, 1, {
    ...claudeProvider,
    models: nextModels,
  })
  return true
}

export function getServerProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = SERVER_PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

export function normalizeServerModel(provider: AgentProvider, model?: string): string {
  const catalog = deployedProviders().find((entry) => entry.id === provider) ?? getServerProviderCatalog(provider)
  // Any non-empty registry id is a valid pi model — only missing values fall
  // back to the catalog default.
  if (provider === "pi") return normalizePiModelId(model, catalog.defaultModel)
  if (model && catalog.models.some((candidate) => candidate.id === model)) return model
  const normalizedModel = normalizeProviderModelId(provider, model, catalog.defaultModel)
  if (catalog.models.some((candidate) => candidate.id === normalizedModel)) {
    return normalizedModel
  }
  return catalog.defaultModel
}

export function normalizeClaudeModelOptions(
  model: string,
  modelOptions?: ModelOptions,
  legacyEffort?: string
): ClaudeModelOptions {
  const reasoningEffort = modelOptions?.claude?.reasoningEffort
  return {
    ...(modelOptions?.claude?.connectionId ? { connectionId: modelOptions.claude.connectionId } : {}),
    reasoningEffort: isClaudeReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isClaudeReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort,
    contextWindow: normalizeClaudeContextWindow(model, modelOptions?.claude?.contextWindow as ClaudeContextWindow | undefined),
  }
}

export function normalizeCodexModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): CodexModelOptions {
  const reasoningEffort = modelOptions?.codex?.reasoningEffort
  return {
    ...(modelOptions?.codex?.connectionId ? { connectionId: modelOptions.codex.connectionId } : {}),
    reasoningEffort: isCodexReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isCodexReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CODEX_MODEL_OPTIONS.reasoningEffort,
    fastMode: typeof modelOptions?.codex?.fastMode === "boolean"
      ? modelOptions.codex.fastMode
      : DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
  }
}

export function codexServiceTierFromModelOptions(modelOptions: CodexModelOptions): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}

export function normalizePiModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): PiModelOptions {
  const reasoningEffort = modelOptions?.pi?.reasoningEffort
  return {
    ...(modelOptions?.pi?.connectionId ? { connectionId: modelOptions.pi.connectionId } : {}),
    reasoningEffort: isPiReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isPiReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_PI_MODEL_OPTIONS.reasoningEffort,
  }
}
