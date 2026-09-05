// Fold memory_trace 'violated' verdicts back onto the assistant replies of the
// same turn segment (all assistant messages since the previous user_prompt),
// so the [M-NN] citations in the prose carry the drift signal at the sentence
// itself — no extra click (advisor feedback 2026-07-16). The trace entry is
// appended after the reply it judges, which is why the fold looks backwards.
import type { HydratedTranscriptMessage } from "../../shared/types"

export function buildViolatedCitationsByMessageId(
  messages: HydratedTranscriptMessage[],
): Map<string, Set<string>> | null {
  let segment: string[] = []
  let result: Map<string, Set<string>> | null = null
  for (const message of messages) {
    if (message.hidden) continue
    if (message.kind === "user_prompt") {
      segment = []
    } else if (message.kind === "assistant_text") {
      segment.push(message.id)
    } else if (message.kind === "memory_trace") {
      const violated = message.labels.filter((l) => l.label === "violated").map((l) => l.id)
      const judged = segment
      // A trace closes its turn. Post-tool follow-up turns append no
      // user_prompt, so without this reset the NEXT trace would fold onto
      // this turn's replies too and red-mark citations it never judged.
      segment = []
      if (violated.length === 0 || judged.length === 0) continue
      result ??= new Map()
      for (const id of judged) {
        const set = result.get(id) ?? new Set<string>()
        for (const v of violated) set.add(v)
        result.set(id, set)
      }
    }
  }
  return result
}

/**
 * Cheap order-stable signature so the transcript can keep the SAME map
 * identity across re-renders — trace verdicts arrive once per turn, and only
 * then should every memoized text row bother re-reading the context.
 */
export function violatedCitationsSignature(map: Map<string, Set<string>> | null): string {
  if (!map) return ""
  return [...map.entries()].map(([k, v]) => `${k}:${[...v].sort().join("+")}`).join("|")
}
