// Automatic cross-context Transfer is deliberately split into two stages:
//
//   turn end: source memory + stable source profile -> portable generic rule
//   next send: current task + recent context -> relevance -> decode/landing
//
// Only the source-side rule is reused between prompts. Relevance and landing
// are task-local and must be recomputed for every send. These prepared rules
// are process-local temporary intermediate results; they are unrelated to a
// provider/API prompt cache.
import type { LlmJsonCaller } from './deepseek';
import type { MemoryService } from './index';
import type { SessionClockEntry } from './maintenance';
import type { MemoryItem, MemoryScope } from './types';
import type { TransferDecoding, TransferEncoding, TransferService } from './transfer';

export interface TransferSuggestionProgress {
  sourceId: string;
  sourceContent: string;
  sourceScope: MemoryScope;
  sourceVersion: number;
  sourceLabel: string;
  encoding?: TransferEncoding;
  decoding?: TransferDecoding;
}

/** Source fields are a snapshot. The automatic card threads sourceVersion to
 * the commit route, where a final active/version CAS protects the write. */
export interface TransferSuggestionCard extends TransferSuggestionProgress {
  encoding: TransferEncoding;
  decoding: TransferDecoding;
}

export interface TransferSourceContext {
  projectId?: string;
  sessionId?: string;
  projectTitle?: string;
}

export interface TransferTaskContext extends TransferSourceContext {
  /** The new prompt. It is never folded into the reusable source rule. */
  taskText: string;
  /** Prior turns only; taskText is supplied separately. */
  recentContext?: string;
}

export interface TransferTaskResult {
  cards: TransferSuggestionCard[];
  /** Task-local relevance selection, retained even if one Decode fails. */
  selectedSourceIds?: string[];
  /** Content-bearing target snapshot used for these landing judgments. */
  targetKey: string;
}

export interface TransferTaskOptions {
  onProgress?: (cards: TransferSuggestionProgress[], targetKey: string) => void;
}

export interface TransferDetectService {
  /** Synchronous shelf probe used only to decide whether a slow cold-start
   * preparation should render a scanning shell. It performs no LLM work. */
  hasSourceCandidates(ctx: TransferSourceContext): boolean;
  /** Encode every currently eligible external source whose source version or
   * stable source profile changed. Concurrent callers share the same work. */
  prepareSources(ctx: TransferSourceContext): Promise<void>;
  /** Current-task relevance question over already-prepared portable rules. */
  buildTaskForkPrompt(ctx: TransferTaskContext): string | null;
  /** Validate a current-session fork reply and decode its relevant rules.
   * null means the reply was not a valid relevance answer and must fall back. */
  materializeTaskFromFork(
    ctx: TransferTaskContext,
    raw: Record<string, unknown>,
    opts?: TransferTaskOptions,
  ): Promise<TransferTaskResult | null>;
  /** Sidecar relevance fallback for this prompt, followed by Decode/landing. */
  runTask(ctx: TransferTaskContext, opts?: TransferTaskOptions): Promise<TransferTaskResult>;
  /** Candidate review may mutate the target pool while relevance is running.
   * Re-decode the same selection only when that target snapshot changed. */
  refreshLandingsIfTargetChanged(
    ctx: TransferTaskContext,
    result: TransferTaskResult,
    opts?: TransferTaskOptions,
  ): Promise<TransferTaskResult>;
  /** True when progressive rows were decoded against the current target. */
  landingsStillCurrent(ctx: TransferTaskContext, targetKey: string): boolean;
}

const MAX_SUGGESTIONS = 3;
const PER_PROJECT_TOP_N = 5;
const MAX_FOREIGN_PROJECTS = 5;
const MAX_OTHER_SESSION_ITEMS = 15;
const PROFILE_N = 5;
const QUERY_TIMEOUT_MS = 60_000;
const PREPARED_MAX_ENTRIES = 100;
const MAX_CONCURRENT_SOURCE_ENCODINGS = 4;

/** "Not this one" suppresses a source only for this destination context. */
export const TRANSFER_DECLINED_PREFIX = 'transfer_declined:';

const TASK_RELEVANCE_SYSTEM = `You select portable agent-memory rules that are relevant to the developer's current task. \
The rules were already abstracted from other conversations or projects. Judge them against THIS task and \
recent context; do not select a rule merely because it was useful at its source. Select at most ${MAX_SUGGESTIONS}. \
Respond with strict JSON only: {"suggestions":[{"memoryId":"M-3"}, ...]}`;

interface SourceCandidate {
  item: MemoryItem;
  sourceLabel: string;
  sourceSessionId?: string;
  sourceProjectId?: string;
}

interface SourceProfile {
  projectTitle?: string;
  representative: MemoryItem[];
  key: string;
}

interface PreparedSource {
  prepareKey: string;
  sourceId: string;
  sourceContent: string;
  sourceScope: MemoryScope;
  sourceVersion: number;
  sourceLabel: string;
  encoding: TransferEncoding;
}

interface TransferDetectOptions {
  memory: MemoryService;
  callJson: LlmJsonCaller;
  transfer: TransferService;
  listRecentSessions: (projectId: string | undefined, excludeSessionId?: string) => SessionClockEntry[];
  listProjects: () => Array<{ id: string; title: string }>;
}

function stableItemOrder(a: MemoryItem, b: MemoryItem): number {
  return a.id.localeCompare(b.id) || a.version - b.version;
}

export function createTransferDetectService(opts: TransferDetectOptions): TransferDetectService {
  const { memory, callJson, transfer, listRecentSessions, listProjects } = opts;
  const preparedBySourceId = new Map<string, PreparedSource>();
  const preparationInFlight = new Map<string, Promise<void>>();
  let activeSourceEncodings = 0;
  const sourceEncodingWaiters: Array<() => void> = [];

  async function withSourceEncodingSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeSourceEncodings < MAX_CONCURRENT_SOURCE_ENCODINGS) {
      activeSourceEncodings += 1;
    } else {
      // A completed caller transfers its occupied slot directly to this
      // waiter, so a new caller cannot steal the gap between wake and resume.
      await new Promise<void>((resolve) => sourceEncodingWaiters.push(resolve));
    }
    try {
      return await run();
    } finally {
      const next = sourceEncodingWaiters.shift();
      if (next) next();
      else activeSourceEncodings -= 1;
    }
  }

  const declined = (item: MemoryItem, ctx: TransferSourceContext) =>
    Boolean(memory.store.getKv(`${TRANSFER_DECLINED_PREFIX}${item.id}:${ctx.projectId ?? ctx.sessionId ?? ''}`));

  /** The two automatic shelves. Current-session/current-project memories are
   * intentionally absent because they are already in the visible pool. */
  function sourceCandidates(ctx: TransferSourceContext, respectDeclines: boolean): SourceCandidate[] {
    const candidates: SourceCandidate[] = [];
    for (const session of listRecentSessions(ctx.projectId, ctx.sessionId)) {
      if (candidates.length >= MAX_OTHER_SESSION_ITEMS) break;
      for (const item of memory.store.list({ scope: 'session', sessionId: session.id, status: 'active' })) {
        if (candidates.length >= MAX_OTHER_SESSION_ITEMS) break;
        if (!respectDeclines || !declined(item, ctx)) {
          candidates.push({
            item,
            sourceLabel: 'another conversation in this project',
            sourceSessionId: session.id,
            sourceProjectId: ctx.projectId,
          });
        }
      }
    }

    let foreignProjects = 0;
    for (const project of listProjects()) {
      if (foreignProjects >= MAX_FOREIGN_PROJECTS) break;
      if (project.id === ctx.projectId) continue;
      const items = memory.store
        .list({ scope: 'project', projectId: project.id, status: 'active' })
        .filter((item) => !respectDeclines || !declined(item, ctx))
        .sort((a, b) => b.usageCount + b.reinforcedCount - (a.usageCount + a.reinforcedCount) || stableItemOrder(a, b))
        .slice(0, PER_PROJECT_TOP_N);
      if (!items.length) continue;
      foreignProjects += 1;
      for (const item of items) {
        candidates.push({ item, sourceLabel: project.title, sourceProjectId: project.id });
      }
    }

    return candidates;
  }

  /** The source profile is deterministic and excludes usage/reinforcement
   * counters. Those volatile evidence counters must never invalidate Encode. */
  function profileOf(ctx: TransferSourceContext, candidate: SourceCandidate): SourceProfile {
    const sourceSessionId = candidate.sourceSessionId;
    const sourceProjectId = candidate.sourceProjectId;
    const projectTitle = sourceSessionId ? ctx.projectTitle : candidate.sourceLabel;
    const representative = (
      sourceSessionId
        ? memory.store.list({ scope: 'session', sessionId: sourceSessionId, status: 'active' })
        : sourceProjectId
          ? memory.store.list({ scope: 'project', projectId: sourceProjectId, status: 'active' })
          : []
    )
      .filter((item) => item.id !== candidate.item.id)
      .sort(stableItemOrder)
      .slice(0, PROFILE_N);
    const key = JSON.stringify({
      sourceScope: candidate.item.scope,
      sourceSessionId: sourceSessionId ?? '',
      sourceProjectId: sourceProjectId ?? '',
      projectTitle: projectTitle ?? '',
      representative: representative.map((item) => [item.id, item.version]),
    });
    return { projectTitle, representative, key };
  }

  function prepareKeyOf(candidate: SourceCandidate, profile: SourceProfile): string {
    return `${candidate.item.id}:${candidate.item.version}:${profile.key}`;
  }

  function trimPreparedResults() {
    while (preparedBySourceId.size > PREPARED_MAX_ENTRIES) {
      const oldest = preparedBySourceId.keys().next().value;
      if (oldest === undefined) return;
      preparedBySourceId.delete(oldest);
    }
  }

  async function prepareOne(ctx: TransferSourceContext, candidate: SourceCandidate): Promise<void> {
    const profile = profileOf(ctx, candidate);
    const prepareKey = prepareKeyOf(candidate, profile);
    if (preparedBySourceId.get(candidate.item.id)?.prepareKey === prepareKey) return;
    const pending = preparationInFlight.get(prepareKey);
    if (pending) return pending;

    const work = (async () => {
      const encoding = await withSourceEncodingSlot(() =>
        transfer.encode(candidate.item, {
          projectTitle: profile.projectTitle,
          representative: profile.representative,
        }),
      );
      // Do not publish a result whose source/profile changed while Encode ran.
      const currentItem = memory.store.getById(candidate.item.id);
      if (!currentItem || currentItem.status !== 'active' || currentItem.version !== candidate.item.version) return;
      const currentCandidate: SourceCandidate = {
        ...candidate,
        item: currentItem,
        ...(candidate.item.scope === 'project' && candidate.sourceProjectId
          ? { sourceLabel: listProjects().find((project) => project.id === candidate.sourceProjectId)?.title ?? candidate.sourceLabel }
          : {}),
      };
      const currentProfile = profileOf(ctx, currentCandidate);
      if (prepareKeyOf(currentCandidate, currentProfile) !== prepareKey) return;
      preparedBySourceId.set(candidate.item.id, {
        prepareKey,
        sourceId: candidate.item.id,
        sourceContent: candidate.item.content,
        sourceScope: candidate.item.scope,
        sourceVersion: candidate.item.version,
        sourceLabel: candidate.sourceLabel,
        encoding,
      });
      trimPreparedResults();
    })().finally(() => {
      preparationInFlight.delete(prepareKey);
    });
    preparationInFlight.set(prepareKey, work);
    return work;
  }

  async function prepareSources(ctx: TransferSourceContext): Promise<void> {
    // One failed source must not sink the other prepared rules. A later send
    // or turn-end pass retries it because no completed result was stored.
    await Promise.all(sourceCandidates(ctx, true).map((candidate) => prepareOne(ctx, candidate).catch(() => {})));
  }

  function eligiblePrepared(ctx: TransferSourceContext): PreparedSource[] {
    const result: PreparedSource[] = [];
    for (const candidate of sourceCandidates(ctx, true)) {
      const profile = profileOf(ctx, candidate);
      const prepared = preparedBySourceId.get(candidate.item.id);
      if (prepared?.prepareKey === prepareKeyOf(candidate, profile)) result.push(prepared);
    }
    return result;
  }

  function portablePrepared(ctx: TransferSourceContext): PreparedSource[] {
    return eligiblePrepared(ctx).filter((prepared) => prepared.encoding.portable);
  }

  function taskSections(ctx: TransferTaskContext, sources: PreparedSource[]): string {
    return [
      `CURRENT TASK:\n${ctx.taskText.trim() || '(empty)'}`,
      ctx.recentContext ? `RECENT CONVERSATION (prior turns only):\n${ctx.recentContext}` : '',
      'PREPARED PORTABLE RULES FROM OTHER CONTEXTS:',
      ...sources.map((source) =>
        [
          `[${source.sourceId}] From ${source.sourceLabel}: ${source.encoding.rule}`,
          source.encoding.applicability ? `  Applies when: ${source.encoding.applicability}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  function validatePicks(raw: Record<string, unknown>, sources: PreparedSource[]): PreparedSource[] | null {
    if (!Array.isArray(raw.suggestions)) return null;
    const byId = new Map(sources.map((source) => [source.sourceId, source]));
    const selected: PreparedSource[] = [];
    const seen = new Set<string>();
    for (const entry of raw.suggestions) {
      if (selected.length >= MAX_SUGGESTIONS) break;
      if (!entry || typeof entry !== 'object') continue;
      const id = typeof (entry as Record<string, unknown>).memoryId === 'string'
        ? ((entry as Record<string, unknown>).memoryId as string)
        : '';
      const source = byId.get(id);
      if (!source || seen.has(id)) continue;
      seen.add(id);
      selected.push(source);
    }
    return selected;
  }

  function targetSnapshot(ctx: TransferTaskContext): { items: MemoryItem[]; key: string } {
    const items = [
      ...memory.store.list({ scope: 'personal', status: 'active' }),
      ...(ctx.projectId ? memory.store.list({ scope: 'project', projectId: ctx.projectId, status: 'active' }) : []),
      ...(ctx.sessionId ? memory.store.list({ scope: 'session', sessionId: ctx.sessionId, status: 'active' }) : []),
    ];
    const key = items
      .map((item) => `${item.id}:${item.version}:${item.scope}:${item.projectId ?? ''}:${item.sessionId ?? ''}`)
      .sort()
      .join('|');
    return { items, key };
  }

  function progressOf(source: PreparedSource): TransferSuggestionProgress {
    return {
      sourceId: source.sourceId,
      sourceContent: source.sourceContent,
      sourceScope: source.sourceScope,
      sourceVersion: source.sourceVersion,
      sourceLabel: source.sourceLabel,
      encoding: source.encoding,
    };
  }

  async function decodeSelected(
    ctx: TransferTaskContext,
    selected: PreparedSource[],
    opts?: TransferTaskOptions,
  ): Promise<TransferTaskResult> {
    const target = targetSnapshot(ctx);
    const rows = selected.map(progressOf);
    const dropped = new Set<string>();
    const emit = () => opts?.onProgress?.(
      rows.filter((row) => !dropped.has(row.sourceId)).map((row) => ({ ...row })),
      target.key,
    );
    if (rows.length) emit();
    await Promise.all(
      selected.map(async (source, index) => {
        const row = rows[index]!;
        try {
          // Re-check source active/version immediately before spending Decode.
          const live = memory.store.getById(source.sourceId);
          if (!live || live.status !== 'active' || live.version !== source.sourceVersion) throw new Error('stale source');
          const decoding = await transfer.decode(source.encoding, {
            target: {
              scope: 'project',
              projectId: ctx.projectId,
              projectTitle: ctx.projectTitle,
              existing: target.items.filter((item) => item.id !== source.sourceId),
            },
            taskText: ctx.taskText,
            recentContext: ctx.recentContext,
          });
          // Decode is task-local and may outlive a concurrent source edit.
          // Revalidate before exposing the completed row through progress or
          // the final card; the route CAS remains the last write-time guard.
          const afterDecode = memory.store.getById(source.sourceId);
          if (!afterDecode || afterDecode.status !== 'active' || afterDecode.version !== source.sourceVersion) {
            throw new Error('stale source');
          }
          row.decoding = decoding;
          emit();
        } catch {
          dropped.add(source.sourceId);
          emit();
        }
      }),
    );
    const cards = rows
      .filter((row) => !dropped.has(row.sourceId) && row.encoding && row.decoding)
      .map((row) => row as TransferSuggestionCard);
    return { cards, selectedSourceIds: selected.map((source) => source.sourceId), targetKey: target.key };
  }

  return {
    hasSourceCandidates(ctx) {
      return sourceCandidates(ctx, true).length > 0;
    },

    prepareSources,

    buildTaskForkPrompt(ctx) {
      const sources = portablePrepared(ctx);
      if (!sources.length) return null;
      return [
        'OUT-OF-BAND MEMORY TRANSFER RELEVANCE — this answer is never shown in the conversation.',
        'Judge only the new current task below. Select at most three prepared rules that would help it.',
        '',
        taskSections(ctx, sources),
        '',
        'Respond with STRICT JSON only: {"suggestions":[{"memoryId":"M-3"}]}',
      ].join('\n');
    },

    async materializeTaskFromFork(ctx, raw, taskOpts) {
      const sources = portablePrepared(ctx);
      if (!sources.length) return { cards: [], selectedSourceIds: [], targetKey: targetSnapshot(ctx).key };
      const selected = validatePicks(raw, sources);
      if (!selected) return null;
      return decodeSelected(ctx, selected, taskOpts);
    },

    async runTask(ctx, taskOpts) {
      const sources = portablePrepared(ctx);
      if (!sources.length) return { cards: [], selectedSourceIds: [], targetKey: targetSnapshot(ctx).key };
      const raw = await callJson({
        system: TASK_RELEVANCE_SYSTEM,
        disableThinking: true,
        user: taskSections(ctx, sources),
        timeoutMs: QUERY_TIMEOUT_MS,
      });
      return decodeSelected(ctx, validatePicks(raw, sources) ?? [], taskOpts);
    },

    async refreshLandingsIfTargetChanged(ctx, result, taskOpts) {
      const currentTarget = targetSnapshot(ctx);
      if (currentTarget.key === result.targetKey) return result;
      const selectedSourceIds = result.selectedSourceIds ?? result.cards.map((card) => card.sourceId);
      if (!selectedSourceIds.length) return { cards: [], selectedSourceIds: [], targetKey: currentTarget.key };
      const eligible = new Map(portablePrepared(ctx).map((source) => [source.sourceId, source]));
      const sameSelection = selectedSourceIds
        .map((sourceId) => eligible.get(sourceId))
        .filter((source): source is PreparedSource => Boolean(source));
      return decodeSelected(ctx, sameSelection, taskOpts);
    },

    landingsStillCurrent(ctx, targetKey) {
      return targetSnapshot(ctx).key === targetKey;
    },
  };
}
