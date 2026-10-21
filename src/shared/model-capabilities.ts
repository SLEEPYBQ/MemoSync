import { PI_REASONING_OPTIONS, type PiReasoningEffort, type ProviderModelOption } from "./types"

export interface RegistryModelCard extends ProviderModelOption {
  /** Missing metadata means provider defaults, never a guess at supported levels. */
  reasoningEfforts: PiReasoningEffort[]
  defaultReasoningEffort: PiReasoningEffort
  reasoningMandatory?: boolean
  metadataSource: "provider" | "pi"
  supportsStructuredOutput?: boolean
  contextWindow?: number
  maxTokens?: number
  inputModalities?: string[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export function resolvePiEffort(card: RegistryModelCard | undefined, requested?: PiReasoningEffort): PiReasoningEffort {
  if (!card) return "default"
  return requested && card.reasoningEfforts.includes(requested) ? requested : card.defaultReasoningEffort
}

export function piEffortOptions(card: RegistryModelCard | undefined) {
  const supported = card?.reasoningEfforts ?? ["default"]
  return PI_REASONING_OPTIONS.filter(option => supported.includes(option.id))
}

/** Pi's native xhigh slot can carry a provider's distinct max wire value. */
export function toPiThinkingLevel(effort: PiReasoningEffort) {
  return effort === "max" ? "xhigh" : effort === "default" ? "off" : effort
}
