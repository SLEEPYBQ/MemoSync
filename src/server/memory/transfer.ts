// Cross-context transfer (Transfer design 2026-08-08, docs/TRANSFER_DESIGN_
// 2026-08-08.md). TWO EXPLICIT STAGES around a middle representation:
//
//   ENCODE  source item + source context profile
//           → abstract rule + applicability (the portable middle form)
//   DECODE  rule + target name + target's existing memories
//           [+ task text + recent-conversation digest, flow-initiated only]
//           → localized text + suggested landing scope + landing judgment
//
// Input discipline (audited against over-engineering, doc §输入的理由审查):
// the encoder sees the SOURCE profile because stripping source-local nouns
// requires knowing what the source looks like — it deliberately does NOT see
// the conversation digest (what the source chatted about recently is not
// evidence of what is source-local). The decoder sees task text + digest so
// the localized form fits the work at hand; Board-initiated transfers have
// neither and degrade naturally. The middle representation is NOT persisted
// as a standalone memory item — it rides the proposal (and the transferred
// item's provenance) as metadata.
//
import type { LlmJsonCaller } from './deepseek';
import type { AbstractionLevel, MemoryItem, MemoryScope } from './types';

export interface TransferTarget {
  scope: MemoryScope;
  projectId?: string;
  /** Human title for the target project — the LLM localizes better with it. */
  projectTitle?: string;
  /** The target context's existing ACTIVE memories — version is included by
   * automatic Transfer so the landing can carry a write-time CAS snapshot. */
  existing?: Array<Pick<MemoryItem, 'id' | 'content'> & Partial<Pick<MemoryItem, 'version'>>>;
}

export interface TransferSourceContext {
  /** Human title of the source project (undefined for session/personal sources). */
  projectTitle?: string;
  /**
   * A few representative memories from the source context. They show the
   * encoder which nouns, paths, and stack choices are source-local — you
   * cannot know what to strip without knowing what the source looks like.
   */
  representative?: Array<Pick<MemoryItem, 'id' | 'content'>>;
}

/** The middle representation — shown on the card, stored as metadata, never a standalone item. */
export interface TransferEncoding {
  /** The portable, context-free rule (one line). */
  rule: string;
  /** When the rule applies; undefined = unconditional. */
  applicability?: string;
  /** False = context-bound: the memory only makes sense at its source. */
  portable: boolean;
  /** Exact source-memory substrings removed as source-local — the card
   * strikes them through to make the encoding VISIBLE in the text. */
  stripped?: string[];
  note: string;
}

export interface TransferDecodeContext {
  target: TransferTarget;
  /** The current task text — conversation-flow initiations only. */
  taskText?: string;
  /** Recent-conversation digest (the same non-fork mechanism relevance uses). */
  recentContext?: string;
}

export type TransferLandingRoute = 'new' | 'reinforces' | 'conflicts';

export interface TransferLanding {
  route: TransferLandingRoute;
  /** The target-context memory the landing relates to (reinforces/conflicts). */
  targetId?: string;
  targetContent?: string;
  /** Version of the target snapshot used for this landing judgment. */
  targetVersion?: number;
}

export interface TransferDecoding {
  /** The localized memory text as it should read in the target (editable by the user). */
  content: string;
  /** Exact content substrings newly bound from the target/task — the card
   * tints them in the landing scope's color. */
  bound?: string[];
  detail?: string;
  abstractionLevel: AbstractionLevel;
  /** Where the decoded form should land — preselects the card's ScopeControl. */
  suggestedScope: MemoryScope;
  landing: TransferLanding;
  note: string;
}

export type TransferVerdict = 'as_is' | 'rewrite' | 'context_bound';

/** Board-compat proposal shape (transfer-preview route + dialog). */
export interface TransferProposal {
  verdict: TransferVerdict;
  /** The abstract rule the source was lifted to (the middle representation). */
  portable: string;
  /** When the rule applies; undefined = unconditional. */
  applicability?: string;
  /** The form localized for the target context (editable by the user). */
  content: string;
  detail?: string;
  abstractionLevel: AbstractionLevel;
  note: string;
  landing: TransferLanding;
}

export interface TransferService {
  encode(
    memory: MemoryItem,
    source: TransferSourceContext,
    opts?: { signal?: AbortSignal },
  ): Promise<TransferEncoding>;
  decode(
    encoding: Pick<TransferEncoding, 'rule' | 'applicability'>,
    ctx: TransferDecodeContext,
    opts?: { signal?: AbortSignal },
  ): Promise<TransferDecoding>;
  /** encode → decode chained into the Board dialog's proposal shape. */
  propose(
    memory: MemoryItem,
    target: TransferTarget,
    source?: TransferSourceContext,
    opts?: { signal?: AbortSignal },
  ): Promise<TransferProposal>;
}

const ABSTRACTION_LEVELS: AbstractionLevel[] = ['concrete', 'contextual', 'general'];
const SCOPES: MemoryScope[] = ['session', 'project', 'personal'];
const LANDING_ROUTES = new Set<TransferLandingRoute>(['new', 'reinforces', 'conflicts']);

const ENCODE_SYSTEM = `A developer is transferring one saved memory of an AI coding agent across a context \
boundary (to another project or another conversation). Do the ENCODE step: strip everything \
that is only true at the source, keep the invariant that made the memory worth saving.

You are given the memory and a profile of its source context (name + a few representative memories saved \
there). The profile shows which nouns, paths, ports, and stack choices are source-local and must go — do \
not guess beyond it.

HARD RULE: if your "rule" still contains a file name, hex color, port number, product name, or any other \
value copied from the source memory, you have NOT abstracted it — name the BEHAVIOR that made those values \
matter, not the values.

Examples:
- Memory: "Dev server port 3000 conflicts with the preview proxy; use 3001"
  → rule: "Check the dev-server port against other local services before starting; pick a free one."
    applicability: "Projects running a local dev server." portable: true.
- Memory: "Background snow (#fffafa), components dim gray (#696969)"
  → rule: "Apply the exact color palette the user specifies, rather than choosing one."
    applicability: "UI work where the user has stated palette preferences." portable: true.
    (WRONG rule: "Keep the background snow #fffafa…" — the hex values are the source's choices, not the lesson.)
- Memory: "The flaky test is test/checkout.spec.ts"
  → portable: false — a source-local pointer with no lesson behind it.

Return:
- "rule": the portable, context-free statement — ONE short imperative line, aim for 12 words or fewer. \
No hedging, no "should consider"; state the behavior.
- "applicability": when the rule applies, one short line; null when it applies unconditionally.
- "portable": false when the memory only makes sense in its source context and carries no transferable \
lesson; true otherwise.
- "stripped": the source-local VALUES you removed — individual names, numbers, paths, or colors, each an \
EXACT substring copied verbatim from the memory text, at most ~24 characters each (at most 5). NEVER a \
whole clause or sentence — e.g. ["port 3000", "3001"], not the sentence containing them. Empty when \
nothing was stripped.
- "note": one short line explaining the judgment (shown to the developer).

Respond with strict JSON only: {"rule": "...", "applicability": "... or null", "portable": true, \
"stripped": ["..."], "note": "..."}`;

const DECODE_SYSTEM = `A developer is bringing an abstract rule (encoded from a memory saved elsewhere) into \
a target context of an AI coding agent's memory. Do the DECODE step: re-bind the rule to the target.

You are given the rule with its applicability condition, the target context (name + existing memories), \
and — when initiated inside a conversation — the current task text and a digest of the recent conversation.

Return:
- "content": the localized one-line memory as it should read in the target. It must NOT be a copy of the \
rule — decoding means RE-BINDING: name the target project or the task's concrete specifics. When the \
current task states values the rule refers to (a palette, a port, a naming convention), bind those values \
from the TASK (e.g. rule "apply the user's specified palette" + task "background snow #fffafa" → content \
names snow #fffafa). When nothing concrete is available to bind, compress the rule into a short imperative \
memory line in this project's voice (e.g. rule "honor the user's stated language preference for replies" → \
content "Reply in Chinese — the user's stated preference."), never the rule verbatim. Only a personal-scope \
target may stay at the rule's level.
- "detail": optional longer form; null when the one line suffices.
- "abstractionLevel": "concrete" | "contextual" | "general" — of the localized form.
- "suggestedScope": where this should land — "project" (durable, true of the whole target project), \
"session" (only serves the current conversation's task), "personal" (true of the developer everywhere). \
Judge by content generality against the task; without task text, keep the target scope as given.
- Landing against the target's existing memories: "landingRoute": "new" (nothing related exists) | \
"reinforces" (an existing memory already states this — name it in "landingTargetId"; bump it, don't \
duplicate) | "conflicts" (name it; both are kept and flagged). "conflicts" is ONLY for genuinely \
incompatible instructions — following both at once would be impossible or incoherent. Two preferences \
that coexist fine (a build-setup rule vs. a language preference) are NOT a conflict. When unsure, "new".
- "bound": the VALUES in your "content" that came from the TARGET context or the current task — individual \
names, numbers, paths, or colors, each an EXACT substring copied verbatim from "content", at most ~24 \
characters each (at most 5). NEVER a whole clause. Empty when the content stays at the rule's level.
- "note": one sentence explaining the judgment (shown to the developer, who makes the final call).

Respond with strict JSON only: {"content": "...", "detail": "... or null", "abstractionLevel": "...", \
"suggestedScope": "project", "landingRoute": "new", "landingTargetId": "<id or null>", "bound": ["..."], \
"note": "..."}`;

/** Keep only real, verbatim substrings of `host` — a hallucinated fragment
 * must never earn a highlight. */
function cleanFragments(raw: unknown, host: string): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    // Values, not prose: short, verbatim, and free of clause punctuation — a
    // model that returns the whole sentence must not strike the whole card.
    .filter((x) => x.length > 0 && x.length <= 24 && host.includes(x) && !/[,;。;,]/.test(x))
    .slice(0, 5);
  return items.length ? items : undefined;
}

function contextLabel(scope: MemoryScope, projectTitle?: string, projectId?: string): string {
  if (scope === 'project') return `project "${projectTitle ?? projectId ?? 'unknown'}"`;
  return scope === 'personal' ? 'the personal scope (applies across every project)' : 'a session';
}

export function createTransferService(opts: { callJson: LlmJsonCaller }): TransferService {
  const encode: TransferService['encode'] = async (memory, source, encodeOpts) => {
    const sourceLabel = contextLabel(memory.scope, source.projectTitle, memory.projectId);
    const representative = (source.representative ?? []).filter((m) => m.id !== memory.id);
    const raw = await opts.callJson({
      system: ENCODE_SYSTEM,
      // Low-effort thinking (user decision 2026-08-09, official mapping is a
      // true "low" on v4-flash): the few-shot examples carry the abstraction
      // quality; a roomy budget so the reply can never truncate silently.
      reasoningEffort: 'low',
      maxTokens: 12000,
      user: [
        `Memory (${memory.type}, abstraction: ${memory.abstractionLevel}, saved in ${sourceLabel}):`,
        memory.content,
        memory.detail ? `\nDetailed form:\n${memory.detail}` : '',
        representative.length
          ? `\nSource context profile — representative memories saved there:\n${representative
              .map((m) => `[${m.id}] ${m.content}`)
              .join('\n')}`
          : '\nNo source context profile available.',
      ].join('\n'),
      signal: encodeOpts?.signal,
    });
    return {
      rule: typeof raw.rule === 'string' && raw.rule.trim() ? raw.rule.trim() : memory.content,
      applicability:
        typeof raw.applicability === 'string' && raw.applicability.trim() ? raw.applicability.trim() : undefined,
      portable: raw.portable !== false,
      stripped: cleanFragments(raw.stripped, memory.content),
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  };

  const decode: TransferService['decode'] = async (encoding, ctx, decodeOpts) => {
    const { target } = ctx;
    const existing = target.existing ?? [];
    const raw = await opts.callJson({
      system: DECODE_SYSTEM,
      // The heaviest call in the pipeline: the landing judgment reasons over
      // the whole target pool. Low-effort thinking + a roomy budget — the
      // default 4000 truncated the JSON and silently dropped rows.
      reasoningEffort: 'low',
      maxTokens: 12000,
      user: [
        `Abstract rule: ${encoding.rule}`,
        encoding.applicability ? `Applies when: ${encoding.applicability}` : '',
        `\nTarget: ${contextLabel(target.scope, target.projectTitle, target.projectId)}.`,
        existing.length
          ? `\nTarget's existing memories (for the landing judgment):\n${JSON.stringify(
              existing.map((m) => ({ id: m.id, content: m.content })),
              null,
              2,
            )}`
          : '\nThe target context has no existing memories.',
        ctx.taskText ? `\nCurrent task (the conversation this rule would serve):\n${ctx.taskText}` : '',
        ctx.recentContext ? `\nRecent conversation (context only):\n${ctx.recentContext}` : '',
      ].join('\n'),
      signal: decodeOpts?.signal,
    });

    // Landing CAS: only bind to a target memory that really exists in the
    // provided short-list — a hallucinated id degrades to "new".
    const existingIds = new Map(existing.map((m) => [m.id, m]));
    let landing: TransferLanding = { route: 'new' };
    const landingRoute = LANDING_ROUTES.has(raw.landingRoute as TransferLandingRoute)
      ? (raw.landingRoute as TransferLandingRoute)
      : 'new';
    if (landingRoute !== 'new' && typeof raw.landingTargetId === 'string' && existingIds.has(raw.landingTargetId)) {
      const targetItem = existingIds.get(raw.landingTargetId)!;
      landing = {
        route: landingRoute,
        targetId: raw.landingTargetId,
        targetContent: targetItem.content,
        ...(typeof targetItem.version === 'number' ? { targetVersion: targetItem.version } : {}),
      };
    }

    const content = typeof raw.content === 'string' && raw.content.trim() ? raw.content.trim() : encoding.rule;
    return {
      content,
      bound: cleanFragments(raw.bound, content),
      detail: typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim() : undefined,
      abstractionLevel: ABSTRACTION_LEVELS.includes(raw.abstractionLevel as AbstractionLevel)
        ? (raw.abstractionLevel as AbstractionLevel)
        : 'contextual',
      suggestedScope: SCOPES.includes(raw.suggestedScope as MemoryScope)
        ? (raw.suggestedScope as MemoryScope)
        : target.scope,
      landing,
      note: typeof raw.note === 'string' ? raw.note : '',
    };
  };

  return {
    encode,
    decode,

    async propose(memory, target, source, proposeOpts) {
      const encoding = await encode(memory, source ?? {}, proposeOpts);
      const decoding = await decode(encoding, { target }, proposeOpts);
      // Verdict is DERIVED, not asked for: context-bound comes from the
      // encoder; as_is means the round trip landed back on the source text.
      const verdict: TransferVerdict = !encoding.portable
        ? 'context_bound'
        : decoding.content === memory.content
          ? 'as_is'
          : 'rewrite';
      return {
        verdict,
        portable: encoding.rule,
        applicability: encoding.applicability,
        content: verdict === 'as_is' ? memory.content : decoding.content,
        detail: verdict === 'as_is' ? memory.detail : decoding.detail,
        abstractionLevel: verdict === 'as_is' ? memory.abstractionLevel : decoding.abstractionLevel,
        note: decoding.note || encoding.note,
        landing: decoding.landing,
      };
    },
  };
}
