import type { MemoryEvent } from "./memoriesApi"
import type { TraceVerdict } from "../components/memory/memoryVocab"

export function auditRecord(events: MemoryEvent[], limit = 10) {
  const corrections = new Map<string, MemoryEvent>()
  const key = (event: MemoryEvent) => JSON.stringify([event.sessionId, event.turn])
  for (const event of events) if (event.kind === "trace_correction" && event.sessionId && event.turn !== undefined) corrections.set(key(event), event)
  const traces = events.filter(event => event.kind === "trace" && typeof event.meta?.label === "string")
  const verdicts = (limit > 0 ? traces.slice(-limit) : []).map(event => {
    const auditLabel = event.meta!.label as TraceVerdict
    const correction = event.sessionId && event.turn !== undefined ? corrections.get(key(event)) : undefined
    const corrected = Boolean(correction && !correction.meta?.withdrawn && typeof correction.meta?.label === "string")
    return {
      turn: event.turn, sessionId: event.sessionId, auditLabel,
      effectiveLabel: corrected ? correction!.meta!.label as TraceVerdict : auditLabel,
      corrected, ...(corrected && typeof correction!.meta!.note === "string" ? { note: correction!.meta!.note } : {}),
    }
  })
  return { verdicts, total: verdicts.length, corrected: verdicts.filter(item => item.corrected).length }
}
