import { t } from "./index"
import type { MemoryType } from "../lib/memoriesApi"

export function memoryTypeLabel(type: MemoryType): string {
  const keys = { constraint: "memory:constraint", preference: "memory:preference", lesson: "memory:lesson", fact: "memory:fact" } as const
  return t(keys[type])
}
export function effortLabel(label: string): string {
  const keys = { High: "settings:effortHigh", Max: "settings:effortMax", Minimal: "settings:effortMinimal", Low: "settings:effortLow", Medium: "settings:effortMedium", XHigh: "settings:effortXhigh", "Extra High": "settings:effortExtraHigh", "Provider default": "settings:effortProviderDefault", Off: "settings:effortOff" } as const
  return label in keys ? t(keys[label as keyof typeof keys]) : label
}
export function traceVerdictLabel(label: string): string {
  const keys = { operational: "memory:traceShaped", violated: "memory:violated", injected_without_effect: "memory:traceNoEffect", not_applicable: "memory:traceNotApplicable" } as const
  return label in keys ? t(keys[label as keyof typeof keys]) : label
}

export function memoryStatusLabel(status: string): string {
  const keys = { active: "memory:fieldActive", candidate: "memory:fieldCandidate", archived: "memory:fieldArchived", discarded: "memory:fieldDiscarded" } as const
  return status in keys ? t(keys[status as keyof typeof keys]) : status
}
