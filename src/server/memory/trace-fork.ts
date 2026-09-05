// Fork-based trace (user design 2026-08-05): instead of a sidecar LLM call
// that rebuilds the turn as a fresh prompt (whose prefix never hits any
// cache), fork the just-finished engine session and ask the audit question on
// top of the trajectory the server already paid for. Mechanics live in
// fork-query.ts (shared with capture extraction and checkup prewarm).
import { runForkQuery } from "./fork-query"
import type { MemoryItem } from "./types"

export interface ForkTraceInput {
  /** The just-finished Claude session's resume token. */
  sessionToken: string
  /** The project workspace the session ran in (resume needs the same cwd). */
  localPath: string
  usedMemories: MemoryItem[]
  timeoutMs?: number
}

const FORK_TRACE_TIMEOUT_MS = 90_000

/**
 * Run the trace question on a fork of the main session. Returns the raw JSON
 * object (same shape the sidecar expects) or null on ANY failure — the caller
 * falls back to the sidecar; this path must never take the turn loop down.
 */
export async function runForkTrace(input: ForkTraceInput): Promise<Record<string, unknown> | null> {
  if (!input.sessionToken || input.usedMemories.length === 0) return null
  const prompt = [
    "OUT-OF-BAND MEMORY AUDIT — this question is not part of the task above and your answer is never shown in the conversation.",
    "Judge how each saved memory below actually related to the conversation so far (the FULL trajectory above, tool calls included).",
    "Walk this decision tree IN ORDER for each memory:",
    '1. Did the conversation contain anything the memory could apply to? NO -> "not_applicable".',
    '2. It applied. Did you follow what it prescribes? NO -> "violated".',
    '3. You followed it. Can you point at a visible difference it made? YES -> "operational"; NO -> "injected_without_effect".',
    'Example — memory "generated images must use vivid colors": no image produced at all -> "not_applicable" (NOT "violated"); dull image -> "violated"; vivid image -> "operational".',
    "Do NOT hunt for conflicts between memories — conflict review happens in a separate checkup.",
    "",
    "Memories to judge:",
    ...input.usedMemories.map((m) => `[${m.id}] ${m.content}`),
    "",
    'For "not_applicable" entries also include "missing": one short phrase naming the absent object or opportunity (an NA without "missing" is rejected).',
    'For "violated" entries also include "cause": "not_followed" (the memory is right, you just did not comply) or "memory_conflict" (the memory clashes with the task or another memory, complying was impossible or wrong), and "impact": "negative" (the violation visibly hurt the outcome) or "none".',
    'Respond with STRICT JSON only — no prose before or after: {"labels":[{"id":"M-07","label":"operational","note":"<short why>","quote":"<verbatim from one of your replies; operational/violated only>","cause":"<violated only>","impact":"<violated only>","missing":"<not_applicable only>"}],"summary":"<one line; cite ids like [M-07]>"}',
  ].join("\n")

  return await runForkQuery({
    sessionToken: input.sessionToken,
    localPath: input.localPath,
    prompt,
    timeoutMs: input.timeoutMs ?? FORK_TRACE_TIMEOUT_MS,
  })
}
