// Which memory shaped which step. The post-turn audit ties a verdict to the tool
// call that shows it; this folds those back onto the calls, so the trace can say
// so in place instead of leaving it to the card at the end of the turn.
import type { HydratedTranscriptMessage } from "../../shared/types"

export interface ToolMemoryUse {
  id: string
  violated: boolean
  note?: string
  noteUiText?: Extract<HydratedTranscriptMessage, { kind: "memory_trace" }>["labels"][number]["noteUiText"]
}

export type ToolMemoryUses = ReadonlyMap<string, readonly ToolMemoryUse[]>

export function buildToolMemoryUses(messages: HydratedTranscriptMessage[]): ToolMemoryUses | null {
  let result: Map<string, ToolMemoryUse[]> | null = null
  for (const message of messages) {
    if (message.kind !== "memory_trace" || message.hidden) continue
    if (message.status !== undefined && message.status !== "ok") continue
    for (const label of message.labels) {
      // Only these two say the memory touched the work; the others say it didn't.
      const effective = label.userLabel ?? label.label
      if (!label.toolId || (effective !== "operational" && effective !== "violated")) continue
      result ??= new Map()
      const uses = result.get(label.toolId) ?? []
      const violated = effective === "violated"
      const existing = uses.find((use) => use.id === label.id)
      if (existing) existing.violated ||= violated
      else uses.push({ id: label.id, violated, note: label.userLabel ? label.userNote : label.note, noteUiText: label.userLabel ? undefined : label.noteUiText })
      result.set(label.toolId, uses)
    }
  }
  return result
}

/** Every memory used across several steps, in first-use order; a violation anywhere sticks. */
export function mergeToolMemoryUses(uses: ToolMemoryUses | null, toolIds: readonly string[]): ToolMemoryUse[] {
  if (!uses) return []
  const merged = new Map<string, ToolMemoryUse>()
  for (const toolId of toolIds) {
    for (const use of uses.get(toolId) ?? []) {
      const existing = merged.get(use.id)
      if (existing) merged.set(use.id, { ...existing, violated: existing.violated || use.violated })
      else merged.set(use.id, use)
    }
  }
  return [...merged.values()]
}

/** Keeps the map's identity while nothing shown changed, so memoized rows skip the context update. */
export function toolMemoryUsesSignature(uses: ToolMemoryUses | null): string {
  return uses ? JSON.stringify([...uses]) : ""
}
