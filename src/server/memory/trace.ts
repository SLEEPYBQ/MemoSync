// Trace — post-turn labeler (SPEC §4.10 "Trace"): a dedicated LLM call, given
// the full exchange plus the memories used this turn, labels each one
// operational / injected-without-effect / violated. Distinct from the
// per-turn Preview (which is a pre-action "will this influence the plan?"
// note) — Trace runs AFTER the assistant's turn and judges what actually
// happened. Follows deepseek.ts's LlmJsonCaller contract: this module never
// touches the network directly, so tests stub `callJson`. (The rigorous
// offline utilization audit for the paper is a separate pipeline — SPEC §4.10.)
import type { LlmJsonCaller } from './deepseek';
import type { MemoryItem } from './types';
import type { ExperimentLogger } from '../experiment/logger';

export type TraceLabel = 'operational' | 'injected_without_effect' | 'violated' | 'not_applicable';

/** Violated only: whether the violation visibly hurt the outcome (mentor 2026-08-15: surface "no negative impact" explicitly). */
export type TraceViolationImpact = 'negative' | 'none';

export interface TraceInput {
  sessionId: string;
  engine?: string;
  turn?: number;
  userText: string;
  assistantText: string;
  /** Memories injected/cited this turn — the set Trace is asked to judge. */
  usedMemories: MemoryItem[];
}

/**
 * Violated-only cause diagnosis (redesign 2026-08-07 §3, Auditing): the two
 * causes demand different follow-ups — "not_followed" (the memory is right,
 * the assistant didn't comply → pay attention next turn) vs "memory_conflict"
 * (the memory itself clashes with the task or another memory → fix the
 * memory).
 */
export type TraceViolationCause = 'not_followed' | 'memory_conflict';

export interface TraceOutcome {
  // `quote` (operational/violated only): the verbatim span of the assistant
  // response where the memory took effect / was broken — the UI uses it to jump
  // to that spot when the reply carried no inline [M-NN] citation (point 3).
  // `missing` (not_applicable only): the absent object/opportunity the audit
  // named — an NA verdict without it is downgraded (decision tree, 2026-08-19).
  // `impact` (violated only): whether the violation visibly hurt the outcome.
  labels: Array<{ id: string; label: TraceLabel; note?: string; quote?: string; cause?: TraceViolationCause; missing?: string; impact?: TraceViolationImpact }>;
  /**
   * One-sentence English recap of the turn with the memories that MATTERED
   * cited inline as [M-NN] (operational/violated only — no-effect memories are
   * excluded by construction). The timeline renders this as each turn's
   * cognitive anchor; selectivity comes from the length budget, not from a
   * client-side filter.
   */
  summary?: string;
}

export interface TraceService {
  trace(input: TraceInput): Promise<TraceOutcome>;
}

const VALID_LABELS = new Set<TraceLabel>(['operational', 'injected_without_effect', 'violated', 'not_applicable']);

const SYSTEM_PROMPT = [
  'You are the Trace auditor for MemoSync, a memory-augmented coding assistant.',
  'You will be given one turn (the user message and the assistant response) plus the memory items',
  'that were available to the assistant this turn. Label EACH memory by walking this decision tree IN ORDER:',
  '1. Did this turn\'s response or actions contain anything the memory could apply to?',
  '   NO -> "not_applicable" (there was no object or opportunity for it).',
  '2. It had something to apply to. Did the response follow what the memory prescribes?',
  '   NO -> "violated".',
  '3. It followed the memory. Can you point at a visible difference it made?',
  '   YES -> "operational". NO -> "injected_without_effect" (included, but no detectable influence).',
  'Worked example — memory: "generated images must use vivid colors":',
  '- the response produced no image at all -> "not_applicable" (nothing to apply it to), NOT "violated";',
  '- the response produced an image with dull colors -> "violated";',
  '- the response produced a vivid image -> "operational".',
  'Do NOT hunt for conflicts between memories — conflict review happens in a separate checkup;',
  'judge only how each memory related to THIS turn\'s output.',
  'For "not_applicable" entries, ALSO include "missing": one short phrase naming the absent object or',
  'opportunity (e.g. "no image in this output"). A "not_applicable" without "missing" will be rejected.',
  'For "operational" and "violated" entries, ALSO include "quote": the shortest span copied VERBATIM',
  '(character-for-character, do not paraphrase or shorten) from the Assistant response that shows where the',
  'memory took effect or was violated. Omit "quote" for "injected_without_effect" and "not_applicable".',
  'For "violated" entries, ALSO include "cause": "not_followed" (the memory is right; the assistant',
  'simply did not comply) or "memory_conflict" (the memory itself clashes with the task or with another',
  'memory, so complying was impossible or wrong), AND "impact": "negative" (the violation visibly hurt',
  'the outcome) or "none" (violated, but with no visible damage).',
  'ALSO include "summary": ONE plain-English sentence (at most 140 characters) recapping what the',
  'assistant did this turn. The summary renders in a UI where every bracketed [M-NN] becomes a',
  'clickable memory chip, and citing an id ASSERTS that this memory actively shaped or was violated',
  'by this turn — so cite ONLY ids you labeled operational or violated, placed inline at the point',
  'in the sentence where that effect is described, e.g. "Gave the test command per [M-10] but',
  'ignored the port rule [M-14]." Do NOT append a list of citations at the end of the sentence,',
  'do NOT write bare ids without brackets, and do NOT mention no-effect memories at all.',
  'Respond with strict JSON only, no prose:',
  '{"summary":"...","labels":[{"id":"M-01","label":"operational","note":"short reason","quote":"exact text from the response"},{"id":"M-02","label":"not_applicable","note":"short reason","missing":"no image in this output"}]}.',
  'Include exactly one label entry per memory id given, in any order, each with a short (<20 word) note.',
].join('\n');

/** Render one memory's fields for the labeling prompt (id/type/scope/content/detail). */
function formatMemoryForPrompt(m: MemoryItem): string {
  const lines = [`[${m.id}] type=${m.type} scope=${m.scope}`, `content: ${m.content}`];
  if (m.detail) lines.push(`detail: ${m.detail}`);
  return lines.join('\n');
}

function buildUserPrompt(input: TraceInput): string {
  // Cache-friendly ordering: DeepSeek's automatic prefix cache only matches
  // identical leading bytes. The memory list is semi-stable across a
  // session's turns; the turn text changes every time — stable first.
  return [
    `Memories used this turn:\n${input.usedMemories.map(formatMemoryForPrompt).join('\n\n')}`,
    `User message:\n${input.userText}`,
    `Assistant response:\n${input.assistantText}`,
  ].join('\n\n');
}

/** Best-effort read of a raw label entry; malformed entries are dropped/coerced, never thrown. */
function readLabelEntry(entry: unknown): { id: string; label: TraceLabel; note?: string; quote?: string; cause?: TraceViolationCause; missing?: string; impact?: TraceViolationImpact } | null {
  if (!entry || typeof entry !== 'object') return null;
  const id = (entry as Record<string, unknown>).id;
  if (typeof id !== 'string') return null;
  const rawLabel = (entry as Record<string, unknown>).label;
  const label = typeof rawLabel === 'string' && VALID_LABELS.has(rawLabel as TraceLabel) ? (rawLabel as TraceLabel) : 'injected_without_effect';
  const rawNote = (entry as Record<string, unknown>).note;
  const note = typeof rawNote === 'string' ? rawNote : undefined;
  const rawQuote = (entry as Record<string, unknown>).quote;
  const quote = typeof rawQuote === 'string' && rawQuote.trim() ? rawQuote : undefined;
  const rawCause = (entry as Record<string, unknown>).cause;
  const cause = rawCause === 'not_followed' || rawCause === 'memory_conflict' ? rawCause : undefined;
  const rawMissing = (entry as Record<string, unknown>).missing;
  const missing = typeof rawMissing === 'string' && rawMissing.trim() ? rawMissing.trim() : undefined;
  const rawImpact = (entry as Record<string, unknown>).impact;
  const impact = rawImpact === 'negative' || rawImpact === 'none' ? rawImpact : undefined;
  return { id, label, note, quote, cause, missing, impact };
}

// NOTE: the service emits NO experiment event — the verdicts it returns are
// judgments about the text it was SHOWN, and the caller must CAS them against
// live memory state before anything (event log, trace labels, usage) is
// written. Logging here would record verdicts that may then be discarded.
export function createTraceService(opts: { callJson: LlmJsonCaller; logger?: Pick<ExperimentLogger, 'event'> }): TraceService {
  return {
    async trace(input: TraceInput): Promise<TraceOutcome> {
      if (input.usedMemories.length === 0) return { labels: [] };

      // Labels + per-memory notes over long multilingual turns can exceed the
      // caller's 2000-token default and come back TRUNCATED — an unparseable,
      // unretried "Unterminated string" (QA BUG-009). Give the pass headroom.
      // Quotes add length; keep the truncation headroom generous (see below).
      // Background pass: reasoning stays ON for label quality; the 90s caller
      // default absorbs the thinking time (user decision 2026-08-05).
      const raw = await opts.callJson({ system: SYSTEM_PROMPT, user: buildUserPrompt(input), maxTokens: 6000 });
      return coerceTraceOutcome(raw, input);
    },
  };
}

/**
 * Shared post-processing for BOTH trace paths (sidecar + session fork):
 * validate/coerce raw labels, guarantee one label per used memory, and
 * sanitize the summary's citations. Never throws.
 */
export function coerceTraceOutcome(
  raw: Record<string, unknown>,
  input: Pick<TraceInput, 'usedMemories' | 'assistantText'>,
): TraceOutcome {
  {
      const validIds = new Set(input.usedMemories.map((m) => m.id));
      const byId = new Map<string, { label: TraceLabel; note?: string; quote?: string; cause?: TraceViolationCause; missing?: string; impact?: TraceViolationImpact }>();
      const rawLabels = Array.isArray(raw.labels) ? raw.labels : [];
      for (const entry of rawLabels) {
        const parsed = readLabelEntry(entry);
        if (!parsed || !validIds.has(parsed.id)) continue; // drop hallucinated ids
        // Decision-tree contract (2026-08-19): an NA verdict must name the
        // absent object. Without it the verdict is unfalsifiable — downgrade
        // to no-effect rather than trusting it.
        if (parsed.label === 'not_applicable' && !parsed.missing) {
          byId.set(parsed.id, { label: 'injected_without_effect', note: parsed.note });
          continue;
        }
        byId.set(parsed.id, { label: parsed.label, note: parsed.note, quote: parsed.quote, cause: parsed.cause, missing: parsed.missing, impact: parsed.impact });
      }

      // Quote validation is tolerant of whitespace/markdown drift: the model
      // often normalizes spacing when "copying verbatim", and a strict
      // includes() silently dropped those quotes — leaving audit rows without
      // their where-used jump (bug, user report 2026-08-07). Same
      // normalization family as the client's quote-jump matcher.
      const normalizeQuote = (s: string) => s.replace(/[*_`~#>[\]()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const normalizedAssistant = normalizeQuote(input.assistantText);

      // Every usedMemory appears exactly once: fall back for anything the model skipped.
      const labels = input.usedMemories.map((m) => {
        const found = byId.get(m.id);
        if (found) {
          // A quote only makes sense for a memory that acted this turn
          // (operational/violated) — never for NA or no-effect.
          const keepQuote = found.quote
            && (found.label === 'operational' || found.label === 'violated')
            && normalizedAssistant.includes(normalizeQuote(found.quote));
          return {
            id: m.id,
            label: found.label,
            ...(found.note !== undefined ? { note: found.note } : {}),
            ...(keepQuote ? { quote: found.quote } : {}),
            // Cause + impact only ride violations — cause drives the follow-up
            // action, impact surfaces "violated but harmless" honestly.
            ...(found.label === 'violated' && found.cause ? { cause: found.cause } : {}),
            ...(found.label === 'violated' && found.impact ? { impact: found.impact } : {}),
            // The named absent object only rides validated NA verdicts.
            ...(found.label === 'not_applicable' && found.missing ? { missing: found.missing } : {}),
          };
        }
        return { id: m.id, label: 'injected_without_effect' as TraceLabel, note: 'not labeled by trace model' };
      });

      // The turn recap: clamp, single-line, and keep it only when non-empty.
      // Citations are validated like labels: a citable id must not merely be
      // in this turn's used set — it must have MATTERED (operational or
      // violated). A no-effect memory cited as [M-NN] would render as an
      // active chip for something the same pass just judged inert.
      const citableIds = new Set(labels.filter((l) => l.label === 'operational' || l.label === 'violated').map((l) => l.id));
      const rawSummary = typeof raw.summary === 'string' ? raw.summary.replace(/\s+/g, ' ').trim() : '';
      const decited = rawSummary.replace(/\[(M-\d+)\]/g, (whole, cited: string) =>
        citableIds.has(cited) ? whole : cited,
      );
      // A trailing citation dump ("... requirement. [M-42] [M-26]") survives
      // de-citation as a dangling bare id after the full stop — prose keeps
      // its bare mentions, the dangling tail loses them.
      const sanitizedSummary = decited.replace(
        /([.!?])((?:\s+(?:\[M-\d+\]|M-\d+))+)\s*$/,
        (_whole, punct: string, tail: string) => {
          const kept = tail.match(/\[M-\d+\]/g) ?? [];
          return kept.length ? `${punct} ${kept.join(' ')}` : punct;
        },
      );
      const summary = sanitizedSummary ? sanitizedSummary.slice(0, 200) : undefined;

      return { labels, ...(summary ? { summary } : {}) };
  }
}
