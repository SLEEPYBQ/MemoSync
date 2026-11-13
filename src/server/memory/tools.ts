// Engine-neutral memory capability specs. The business logic is written ONCE
// here; per-engine adapters (claude-adapter.ts, codex-adapter.ts) compile these
// into each engine's native tool shape. This is the "register once, works on
// every engine" seam the project is built around.
import { z } from 'zod';
import type { MemoryService } from './index';
import type { CaptureService } from './capture';
import type { MemoryItem } from './types';
import { planMemoryInjection } from './injection';
import { compileMemoryView, semanticHash, type MemoryView } from './view';

/** Per-turn context threaded into a tool handler. */
export interface MemoryToolContext {
  /** Active repo/project id (used to scope project memories). */
  projectId?: string;
  /** Active conversation/session id (provenance for proposed memories). */
  sessionId?: string;
  /** Current user-visible turn, shared by every engine's capture channels. */
  turn?: number;
  engine?: string;
  /** Immutable server grant captured from the context admitted to this turn. */
  memoryView?: MemoryView;
  /** Server-confirmed working memory for this turn; omitted by legacy callers. */
  allowedMemoryIds?: readonly string[];
}

/** Normalized tool result; adapters translate this into each engine's shape. */
export interface MemoryToolResult {
  text: string;
  isError?: boolean;
  receipts?: Array<{ memoryId: string; version: number; viewRevision: string; contentDigest: string }>;
}

/** An engine-neutral tool definition. `schema` is a Zod raw shape (object props). */
export interface MemoryToolSpec {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult> | MemoryToolResult;
}

/** Format ranked/listed memories the way the model should see them (short forms). */
export function formatMemoriesForModel(items: Array<{ id: string; scope: string; type: string; content: string; detail?: string }>): string {
  return items.map((m) => `[${m.id}] (${m.scope} · ${m.type}) ${m.content}${m.detail ? ' [+detail]' : ''}`).join('\n');
}

function pendingCandidateReviewTiming(items: MemoryItem[], currentSessionId?: string): string {
  const allBelongToCurrentChat = Boolean(
    currentSessionId &&
      items.length > 0 &&
      items.every(
        (item) => item.provenanceSessionId === currentSessionId || item.sessionId === currentSessionId,
      ),
  );
  return allBelongToCurrentChat
    ? `It will appear in the next turn's Candidate review.`
    : 'It remains pending in its existing Memory review / Memory Board.';
}

/**
 * Build the memory tools bound to a MemoryService. Returned specs are
 * engine-neutral; feed them to the Claude / Codex adapters.
 *
 * Capture is dual-channel (REDESIGN D3): the forced coordinator hook stays as
 * the floor, and — when a CaptureService is provided — the session agent gets
 * propose_memory back: it proposes with full in-context judgment, but every
 * proposal goes through the SAME routing gate and lands as a review candidate,
 * never directly active. There is still deliberately NO search_memory tool:
 * the injected index IS the complete memory surface for a turn, so the receipt
 * the user sees never under-reports what the agent can reach. The model's only
 * recall path is load_memory_detail over already-injected ids.
 */
export function buildMemoryToolSpecs(
  memory: MemoryService,
  opts?: {
    capture?: CaptureService | null;
    /**
     * A pending Candidate already exists, so no new memory was created.
     * Claude's review flow reports the real pending surface: this chat's next
     * Candidate gate when provenance matches, otherwise the existing Memory
     * review / Memory Board. The legacy default keeps other integrations unchanged.
     */
    pendingCandidateTiming?: 'immediate' | 'next_turn';
    /** Fires when an agent proposal lands as candidate(s) — the transcript
     * review card rides on this (the hook channel appends its own). */
    onProposed?: (created: import('./types').MemoryItem[], info?: { resurfaced?: boolean }) => void;
  },
): MemoryToolSpec[] {
  const capture = opts?.capture ?? null;
  const proposeSpec: MemoryToolSpec[] = capture
    ? [
        {
          name: 'propose_memory',
          description:
            'Propose ONE durable memory from this conversation — a standing preference, hard constraint, ' +
            'lesson, decision rationale, environment quirk, or stable pointer (a path, a key location, a ' +
            'command) that will matter in a future session and would be costly to rediscover. The proposal ' +
            'becomes a review card the user confirms; it never activates silently. Always propose when the ' +
            'user explicitly asks you to remember something. Write content/detail as PLAIN standalone ' +
            'text — never include [M-NN] citation markers inside them.',
          schema: {
            content: z.string().describe(
              'concise standalone memory, semantically complete and at most 100 words; never cut off mid-sentence',
            ),
            detail: z.string().optional().describe('2-4 self-contained sentences of specifics'),
            type: z.enum(['constraint', 'preference', 'lesson', 'fact']).optional(),
            scope: z
              .enum(['personal', 'project', 'session'])
              .optional()
              .describe('personal = true of the developer everywhere; project = this repo; session = this conversation only'),
            topic: z.string().optional().describe('short grouping label, e.g. "Testing"'),
            abstractionLevel: z.enum(['concrete', 'contextual', 'general']).optional(),
            sensitive: z.boolean().optional().describe('true if it contains secrets or personal data'),
            evidenceClass: z
              .enum(['user_stated', 'user_corrected', 'inferred', 'agent_proposed'])
              .optional()
              .describe('user_stated when the user said it outright (e.g. "remember X")'),
          },
          async handler(args, ctx) {
            const outcome = await capture.routeProposal(args, {
              projectId: ctx.projectId,
              sessionId: ctx.sessionId,
              turn: ctx.turn,
              engine: ctx.engine,
            });
            if (!outcome) return { text: 'Provide a non-empty `content`.', isError: true };
            if (outcome.surfaced > 0) {
              if (outcome.created.length) opts?.onProposed?.(outcome.created);
              const item = outcome.created[0]!;
              const revisionNote = outcome.revisions > 0 ? ' as a revision proposal' : '';
              const persisted = memory.store.getById(item.id);
              if (persisted?.status === 'active') {
                return { text: `Stored [${persisted.id} v${persisted.version}]${revisionNote} — accepted and active under the current review policy.` };
              }
              if (persisted?.status !== 'candidate') {
                return { text: `Proposal [${item.id}] is ${persisted?.status ?? 'unavailable'}; it is not active.` };
              }
              return {
                text: `Proposed [${item.id}]${revisionNote} — it now awaits the user's review; it is NOT active yet, so do not cite it.`,
              };
            }
            if (outcome.reinforced > 0) {
              return {
                text: `Already stored as [${outcome.reinforcedIds.join('], [')}] — recorded as a re-observation (reinforced) instead of a duplicate card.`,
              };
            }
            if (outcome.pending.length > 0) {
              if (opts?.pendingCandidateTiming === 'next_turn') {
                return {
                  text:
                    `Already proposed as [${outcome.pending.map((m) => m.id).join('], [')}] and still pending. ` +
                    `${pendingCandidateReviewTiming(outcome.pending, ctx.sessionId)} It is NOT active yet, so do not cite it.`,
                };
              }
              opts?.onProposed?.(outcome.pending, { resurfaced: true });
              const persisted = outcome.pending.map(item => memory.store.getById(item.id));
              if (persisted.some(item => item?.status !== 'candidate')) {
                return { text: persisted.map((item, index) => item
                  ? `[${item.id} v${item.version}] is ${item.status}.`
                  : `[${outcome.pending[index]!.id}] is unavailable.`).join(' ') };
              }
              return {
                text: `Already proposed earlier as [${outcome.pending.map((m) => m.id).join('], [')}] and still awaiting the user's review — its review card has been shown again in this chat. It is NOT active yet, so do not cite it.`,
              };
            }
            if (outcome.sameTurnDuplicates?.length) {
              const ids = [...new Set(
                outcome.sameTurnDuplicates
                  .map(({ memoryId }) => memoryId)
                  .filter((id): id is string => Boolean(id)),
              )];
              const idText = ids.length ? ` as [${ids.join('], [')}]` : '';
              const statusNote = ids.map(id => `[${id}] is ${memory.store.getById(id)?.status ?? 'unavailable'}.`).join(' ');
              const pendingItems = ids
                .map((id) => memory.store.getById(id))
                .filter((item): item is MemoryItem => item?.status === 'candidate');
              return {
                text:
                  `Already handled earlier this turn${idText}; no duplicate card or reinforcement was recorded.` +
                  (statusNote ? ` ${statusNote}` : '') +
                  (pendingItems.length > 0 && opts?.pendingCandidateTiming === 'next_turn'
                    ? ` ${pendingCandidateReviewTiming(pendingItems, ctx.sessionId)} It is NOT active yet, so do not cite it.`
                    : ''),
              };
            }
            return {
              text: 'Not stored: the user previously dismissed a closely similar suggestion. Do not re-propose it unless the situation clearly changed.',
            };
          },
        },
      ]
    : [];
  return [
    ...proposeSpec,
    {
      name: 'load_memory_detail',
      description:
        'Load the DETAILED form of one or more memories when their one-line short form is not enough — ' +
        'e.g. before acting on something a memory governs, or when the user will need the specifics. ' +
        'Load as many or as few as you judge necessary.',
      schema: {
        ids: z.array(z.string()).describe('memory ids to expand, e.g. ["M-07", "M-12"]'),
        expectedVersion: z.number().int().positive().optional().describe('Expected content version for a single id.'),
        expectedVersions: z.record(z.string(), z.number().int().positive()).optional(),
        expectedViewRevision: z.string().optional().describe('Expected semantic view revision; the server turn grant also applies.'),
      },
      handler(args, ctx) {
        const ids = Array.isArray(args.ids) ? [...new Set(args.ids.filter((x): x is string => typeof x === 'string'))] : [];
        if (!ids.length) return { text: 'Provide at least one memory id.', isError: true };
        if (args.expectedVersion !== undefined && ids.length !== 1) {
          return { text: 'expectedVersion requires a single id; use expectedVersions for multiple ids.', isError: true };
        }
        return memory.db.transaction((): MemoryToolResult => {
          const grant = ctx.memoryView;
          if (!grant) {
            return { text: 'VIEW_CHANGED: a versioned server turn grant is required; refresh Working Memory.', isError: true };
          }
          if (grant.projectId !== ctx.projectId || grant.chatId !== ctx.sessionId) {
            return { text: 'VIEW_CHANGED: the turn grant belongs to a different scope.', isError: true };
          }
          const current = planMemoryInjection({ memory, projectId: ctx.projectId, chatId: ctx.sessionId,
            restrictToIds: grant?.selectedIds.slice() ?? ctx.allowedMemoryIds?.slice(),
          });
          let admitted = current.injectedMemories;
          let view = current.view;
          if (grant.revision !== view.revision && grant.visibleIds) {
            const visible = memory.injectedFor(ctx.projectId, ctx.sessionId);
            const archived = grant.visibleIds.map(id => memory.store.getById(id)).filter((item): item is MemoryItem => item?.status === 'archived');
            const archivedIds = new Set(archived.map(item => item.id));
            const byId = new Map([...visible, ...archived.map(item => ({ ...item, status: 'active' as const }))].map(item => [item.id, item]));
            const restored = [...grant.visibleIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), ...visible.filter(item => !grant.visibleIds!.includes(item.id))];
            const selected = new Set(grant.selectedIds);
            const reconstructed = compileMemoryView(memory, restored, restored.filter(item => selected.has(item.id)), ctx.projectId, ctx.sessionId, archivedIds);
            if (reconstructed.revision === grant.revision) {
              admitted = restored.filter(item => selected.has(item.id));
              view = reconstructed;
            }
          }
          const allowed = new Map(admitted.map(item => [item.id, item]));
          const parts: string[] = [];
          const loaded: string[] = [];
          const receipts: NonNullable<MemoryToolResult['receipts']> = [];
          let failed = false;
          for (const id of ids) {
            if (!allowed.has(id) || (ctx.allowedMemoryIds && !ctx.allowedMemoryIds.includes(id))) continue;
            const m = allowed.get(id)!;
            const expectedVersions = args.expectedVersions as Record<string, unknown> | undefined;
            const expected = expectedVersions?.[id] ?? args.expectedVersion ?? grant?.versions[id];
            if ((grant && grant.versions[id] !== m.version) || (expected !== undefined && expected !== m.version)) {
              parts.push(`[${id}] VERSION_CHANGED: refresh Working Memory before loading details.`);
              failed = true;
              continue;
            }
            if ((grant && grant.revision !== view.revision) ||
                (args.expectedViewRevision !== undefined && args.expectedViewRevision !== view.revision)) {
              parts.push(`[${id}] VIEW_CHANGED: refresh Working Memory before loading details.`);
              failed = true;
              continue;
            }
            const receipt = { memoryId: id, version: m.version, viewRevision: view.revision,
              contentDigest: semanticHash([m.content, m.detail ?? null]) };
            memory.store.recordUse(id, { actor: 'agent', sessionId: ctx.sessionId, turn: ctx.turn, via: 'detail_load', detailLoaded: true });
            loaded.push(id);
            receipts.push(receipt);
            parts.push(`[${m.id} v${m.version}] (${m.scope} · ${m.type}) ${m.content}\n${m.detail ?? '(no additional detail — the short form is the whole memory)'}\nReceipt: ${JSON.stringify(receipt)}`);
          }
          if (loaded.length) memory.logger.event({ type: 'memory.detail_load', sessionId: ctx.sessionId, ids: loaded });
          return { text: parts.join('\n\n') || 'No matching active memories for those ids.',
            ...(failed ? { isError: true } : {}), receipts };
        })();
      },
    },
  ];
}

/** Execute a memory tool by name (used by the Codex item/tool/call dispatcher). */
export async function dispatchMemoryTool(
  specs: MemoryToolSpec[],
  name: string,
  args: Record<string, unknown>,
  ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
  const spec = specs.find((s) => s.name === name);
  if (!spec) return { text: `Unknown memory tool: ${name}`, isError: true };
  // Snapshot getter-backed contexts before any routing await can advance turns.
  return spec.handler(args, { ...ctx });
}
