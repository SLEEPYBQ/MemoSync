// Per-turn relevance highlight (REDESIGN D6) — the restored "before" leg of
// F3: before execution the developer could not predict which memories would
// matter for THIS task. A sidecar LLM pass ranks the injected index against
// the just-submitted user prompt and names up to MAX_RELEVANT likely-relevant
// items, each with a one-line why.
//
// One-call fast path (user decision 2026-08-08): the same pass ALSO writes
// each pick's expectedUse — the concrete instruction the Injected Memory Set
// card shows and Claude receives. Selection and use planning stay separate
// SERVICES for the assistant/manual-add paths; merging them here is an
// implementation detail that halves the pre-turn wait (one round-trip instead
// of relevance → use-plan in series). Ids the model omits are topped up by
// the standalone Use Planner, so the contract never weakens.
//
// Epistemics (the fact/inference red line): this is a PREDICTION, not a
// system fact. Every consumer must present it as such — the receipt card
// styles it as a guess ("likely relevant"), and it is logged as
// memory.relevance, never mixed into injection/citation facts. Failures
// degrade to no highlight; nothing ever blocks the turn on this pass.
import type { LlmJsonCaller } from './deepseek';
import type { MemoryItem } from './types';

export interface RelevantMemory {
  id: string;
  /** One short clause: why this item likely matters for the task. */
  why: string;
  /** One imperative sentence: how the agent should apply it this turn (may be absent when the model omitted it). */
  expectedUse?: string;
}

export interface RelevanceService {
  /**
   * Rank `injected` against the user's task; [] on failure or nothing
   * relevant. `mustInclude` ids (attention carryovers, already selected) are
   * always part of the output. `recentContext` is a truncated digest of the
   * last turns — the cheap de-biasing context for this latency-critical pass
   * (user decision 2026-08-08, option C): the pass can't wait for a fork,
   * but it CAN know what the conversation has been doing.
   */
  assess(
    userText: string,
    injected: MemoryItem[],
    opts?: { mustInclude?: string[]; recentContext?: string },
  ): Promise<RelevantMemory[]>;
}

const MAX_RELEVANT = 5;
const WHY_MAX_LEN = 80;
const EXPECTED_USE_MAX_LEN = 220;

const RELEVANCE_SYSTEM = `You are shown a developer's task message and the index of their agent's active \
memories (one line each; [+detail] marks items with a loadable detailed form). Do TWO things in one pass:

1. SELECT the memories LIKELY TO MATTER for this specific task — the ones the agent should honor or \
draw on while doing it. Up to ${MAX_RELEVANT}; fewer is better than padding; an empty list is correct \
when nothing clearly applies (unless a must-include list is given).
2. For EVERY memory you return, write "why" (under 10 words, tying it to the task) and "expectedUse" — \
one concrete imperative sentence telling the agent how to apply it in THIS task. Name an observable \
action, decision, constraint, or output property; never merely say it is relevant. When the item is \
marked [+detail], tell the agent to load the detail first when appropriate.

When a MUST-INCLUDE list is provided, always include those ids in your output (they are already \
selected; still write their why and expectedUse).

Respond with strict JSON only: {"relevant": [{"id": "M-07", "why": "<short clause>", "expectedUse": \
"<one imperative sentence>"}, ...]}.`;

export function createRelevanceService(opts: { callJson: LlmJsonCaller }): RelevanceService {
  const { callJson } = opts;
  return {
    async assess(userText, injected, options): Promise<RelevantMemory[]> {
      const mustInclude = (options?.mustInclude ?? []).filter((id) => injected.some((m) => m.id === id));
      if (injected.length === 0 || !userText.trim()) return mustInclude.map((id) => ({ id, why: '' }));
      try {
        const raw = await callJson({
          system: RELEVANCE_SYSTEM,
          user:
            (options?.recentContext?.trim()
              ? `Recent conversation (earlier turns, context only — the task is below):\n${options.recentContext.trim()}\n\n`
              : '') +
            `Task:\n${userText}\n\nActive memory index:\n` +
            injected
              .map((m) => `[${m.id}] (${m.scope} · ${m.type}) ${m.content}${m.detail ? ' [+detail]' : ''}`)
              .join('\n') +
            (mustInclude.length ? `\n\nMUST-INCLUDE ids: ${mustInclude.join(', ')}` : ''),
          // Latency-critical: the highlight must beat the user's gate decision.
          // Reasoning OFF keeps this in the ~2-4s band; the budget covers
          // MAX_RELEVANT whys + expectedUse sentences.
          disableThinking: true,
          maxTokens: 1400,
          timeoutMs: 15_000,
        });
        const list = Array.isArray(raw.relevant) ? (raw.relevant as unknown[]) : [];
        const injectedIds = new Set(injected.map((m) => m.id));
        const seen = new Set<string>();
        const out: RelevantMemory[] = [];
        const cap = MAX_RELEVANT + mustInclude.length;
        for (const entry of list) {
          if (!entry || typeof entry !== 'object') continue;
          const rec = entry as Record<string, unknown>;
          const id = typeof rec.id === 'string' ? rec.id : '';
          // Hallucinated ids must not surface — the highlight may only ever
          // point at items that are really on the receipt.
          if (!id || !injectedIds.has(id) || seen.has(id)) continue;
          seen.add(id);
          const expectedUse = typeof rec.expectedUse === 'string' && rec.expectedUse.trim()
            ? rec.expectedUse.trim().slice(0, EXPECTED_USE_MAX_LEN)
            : undefined;
          out.push({
            id,
            why: typeof rec.why === 'string' ? rec.why.trim().slice(0, WHY_MAX_LEN) : '',
            ...(expectedUse ? { expectedUse } : {}),
          });
          if (out.length >= cap) break;
        }
        // Carryovers the model dropped still ride the output — their
        // expectedUse gets topped up by the standalone Use Planner.
        for (const id of mustInclude) {
          if (!seen.has(id)) out.push({ id, why: '' });
        }
        return out;
      } catch {
        // Degrade to no highlight — never block or throw into the turn. The
        // carryovers stay selected regardless.
        return mustInclude.map((id) => ({ id, why: '' }));
      }
    },
  };
}
