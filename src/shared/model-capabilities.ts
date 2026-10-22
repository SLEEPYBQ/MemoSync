import { PI_REASONING_OPTIONS, type PiReasoningEffort, type ProviderModelOption } from "./types"

export interface RegistryModelCard extends ProviderModelOption {
  /** Unknown capabilities use the provider default; switches and budgets aren't effort lists. */
  reasoningEfforts: PiReasoningEffort[]
  defaultReasoningEffort: PiReasoningEffort
  reasoningKind?: "unknown" | "none" | "effort" | "toggle" | "budget" | "unlevelled"
  reasoningMandatory?: boolean
  reasoningDefaultEnabled?: boolean
  preferredReasoningEffort?: PiReasoningEffort
  /** Source of the reasoning fields; other fields can still come from the live provider. */
  metadataSource: "provider" | "pi" | "models.dev"
  supportsStructuredOutput?: boolean
  contextWindow?: number
  maxTokens?: number
  inputModalities?: string[]
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

export function resolvePiEffort(card: RegistryModelCard | undefined, requested?: PiReasoningEffort): PiReasoningEffort {
  if (!card) return "default"
  return requested && card.reasoningEfforts.includes(requested) ? requested : card.defaultReasoningEffort
}

export function piEffortOptions(card: RegistryModelCard | undefined) {
  const supported = card?.reasoningEfforts ?? ["default"]
  return PI_REASONING_OPTIONS.filter(option => supported.includes(option.id))
}

/** Pi's native xhigh slot can carry max. "default" uses its off slot together
 * with thinkingLevelMap.off=null, which omits reasoning rather than sending none. */
export function toPiThinkingLevel(effort: PiReasoningEffort) {
  return effort === "max" ? "xhigh" : effort === "default" ? "off" : effort
}
