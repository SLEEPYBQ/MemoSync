// HTTP routes for the memory layer — ported from MemoSync's Express router
// (apps/backend/src/routes/memory.ts) into Kanna's Bun.serve fetch-handler
// style: a single `handleMemoryRequest(req, url, memory)` that returns a
// Response for a matched `/api/memories*` route, or `null` to fall through.
//
// Envelope matches MemoSync: `{ data }` on success, `{ error: { code, message } }`
// on failure, so the ported frontend data layer works unchanged.
import type { MemoryService } from './index';
import { rankMemories } from './retrieval';
import type { TransferService } from './transfer';
import { TRANSFER_DECLINED_PREFIX } from './transfer-detect';
import type { RevisionService } from './evolution';
import type { SanitizeService } from './sanitize';
import type { AttentionKind, MaintenanceService } from './maintenance';
import type { SummaryService } from './summary';
import type { ReviseInjectionService } from './revise-injection';
import type { UsePlanService } from './use-plan';
import type {
  MemoryBoardBacklogService,
  MemoryBoardResolution,
  MemoryBoardTransferAdmission,
  MemoryBoardTransferResolution,
  MemoryBoardTrustedTransfer,
} from './board-backlog';
import type { ExpectedMemoryUse } from '../../shared/types';
import type { AbstractionLevel, MemoryItem, MemoryScope, MemoryStatus, MemoryType } from './types';
import { resolveConditionPolicy, type ConditionPolicy } from '../experiment/condition';
import type { StudySessionAttribution, StudySessionAttributionResolver } from '../study-session-attribution';
import { StudyTelemetryError } from '../study-telemetry';
import { CandidateDismissalTransitionError } from './MemoryStore';

/** Optional LLM-backed services a caller can plug into the routes. */
export interface MemoryRouteServices {
  transfer?: TransferService | null;
  sanitize?: SanitizeService | null;
  /** Maintenance actions used by the in-chat Checkup and Board conflict resolution. */
  maintenance?: MaintenanceService | null;
  /** Auto-arm memory summary panel (baseline B1) — prose summary + panel chat. */
  summary?: SummaryService | null;
  /** Server-authoritative active-project admission for the Auto panel's write-capable chat. */
  summaryProjectRefusal?: (projectId: string) => string | null;
  /** "Ask agent to revise" on the Step 2 gate (redesign 2026-08-07). */
  reviseInjection?: ReviseInjectionService | null;
  /** Turn-scoped explanation of how the agent should use selected memories. */
  usePlan?: UsePlanService | null;
  /** Audit-row "draft a fix" (redesign 2026-08-07). */
  revision?: RevisionService | null;
  /** Atomic study boundary: returns a release callback, or null once freeze starts. */
  beginStudyMemoryMutation?: () => (() => void) | null;
  /** Durable projection of skipped-but-unresolved Transfer/Checkup transcript rows. */
  boardBacklog?: MemoryBoardBacklogService | null;
  /** Server-authoritative study lifecycle admission for the session-start Board. */
  boardReviewAdmission?: (taskId: string) => string | null;
  /** Full canonical prompt gate before the opening payload can become immutable. */
  openingPromptAdmission?: (input: {
    chatId: string;
    reviewId: string;
    content: string;
    attachments: unknown[];
  }) => string | null | {
    refusal: string | null;
    attachmentSnapshots?: import('../study-opening-attachments').StudyOpeningAttachmentSnapshot[];
  };
  /** Re-prime the private durable opening payload after browser/server restart. */
  resumeOpeningBoardPreparation?: () => void;
  /** True while the active MemoSync task still owns its blocking opening Board. */
  blockingBoardReviewRequired?: () => boolean;
  /** Server-authoritative admission for Audit Enforce/Draft on a visible memory in the active Claude study chat. */
  auditAdmission?: (input: { chatId: string; memoryId: string }) => string | null;
  /** Active task-window identity for formal-study memory interaction telemetry. */
  studySessionAttribution?: StudySessionAttributionResolver;
  /** Active MemoSync preview + chat/project/Visible-Pool admission for one manual selection toggle. */
  workingMemorySelectionAdmission?: (input: {
    chatId: string;
    previewId: string;
    memoryId?: string;
  }) => string | null;
  /** Durable preview-lineage authority for Add/Remove evidence, including delayed delivery after freeze. */
  workingMemoryEvidenceAdmission?: (input: {
    chatId: string;
    previewId: string;
    memoryId: string;
    clientTimestamp: string;
  }) => { attribution: StudySessionAttribution } | { refusal: string };
  /** Server-held pool for the exact active Working Memory preview. */
  workingMemoryPool?: (input: { chatId: string; previewId: string }) => string[] | null;
  /** Server-authoritative expected-use planner for one exact pending preview. */
  workingMemoryUsePlan?: (input: {
    chatId: string;
    previewId: string;
    selectedIds: string[];
  }) => Promise<ExpectedMemoryUse[]>;
}

const MEMORY_SCOPES: MemoryScope[] = ['personal', 'project', 'session'];
const MEMORY_TYPES: MemoryType[] = ['constraint', 'preference', 'lesson', 'fact'];
const MEMORY_STATUSES: MemoryStatus[] = ['active', 'candidate', 'archived', 'discarded'];
const ABSTRACTION_LEVELS: AbstractionLevel[] = ['concrete', 'contextual', 'general'];

/** All HTTP mutations are user actions (the UI is the user's surface). */
const UI_ACTOR = { actor: 'user' as const };

class RouteError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function assertEnum(value: unknown, allowed: readonly string[], field: string): void {
  if (value !== undefined && !allowed.includes(value as string)) {
    throw new RouteError(400, 'BAD_REQUEST', `invalid ${field}: ${String(value)}`);
  }
}
function assertString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new RouteError(400, 'BAD_REQUEST', `${field} must be a string`);
  }
}
function assertNumber(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new RouteError(400, 'BAD_REQUEST', `${field} must be a number`);
  }
}

function controlSurface(value: unknown): 'board' | 'chat_gate' | undefined {
  if (value === undefined) return undefined;
  if (value === 'board' || value === 'chat_gate') return value;
  throw new RouteError(400, 'BAD_REQUEST', 'surface must be board or chat_gate');
}

function studyInteractionAttribution(
  policy: ConditionPolicy,
  services: MemoryRouteServices,
): Partial<StudySessionAttribution> {
  if (!policy.studyMode || policy.condition !== 'memosync') {
    return {};
  }
  if (!services.studySessionAttribution) {
    throw new RouteError(503, 'NOT_AVAILABLE', 'Study session attribution is unavailable');
  }
  const attribution = services.studySessionAttribution();
  if (!attribution) {
    throw new RouteError(409, 'STUDY_SESSION_CLOSED', 'This study session is no longer open');
  }
  return attribution;
}

type DurableControlType = 'crud' | 'transfer' | 'checkup' | 'audit' | 'working_memory';
type DurableControlSurface = 'board' | 'chat_gate' | 'audit' | 'working_memory';

function durableOperationId(input: {
  provided?: unknown;
  attribution: Partial<StudySessionAttribution>;
  surface?: DurableControlSurface;
  controlType: DurableControlType;
  identity: string;
}): string | null {
  if (!input.attribution.taskId || !input.surface) return null;
  if (input.provided !== undefined) {
    if (typeof input.provided !== 'string' || !input.provided.trim() || input.provided.length > 200) {
      throw new RouteError(400, 'BAD_REQUEST', 'operationId must be a non-empty string of at most 200 characters');
    }
    return input.provided.trim();
  }
  // Server fallback for old clients and Board-row restart recovery. Every
  // phase derives from the same task/surface/domain identity.
  return `control:${input.attribution.taskId}:${input.surface}:${input.controlType}:${input.identity}`;
}

async function runDurableControlOperation<T>(input: {
  memory: MemoryService;
  attribution: Partial<StudySessionAttribution>;
  surface?: DurableControlSurface;
  operationId?: unknown;
  chatId?: string;
  clientTimestamp?: string;
  action: string;
  controlType: DurableControlType;
  identity: string;
  payload?: Record<string, unknown>;
  run: () => T | Promise<T>;
}): Promise<T> {
  const operationId = durableOperationId({
    provided: input.operationId,
    attribution: input.attribution,
    surface: input.surface,
    controlType: input.controlType,
    identity: input.identity,
  });
  if (!operationId || !input.attribution.taskId || !input.surface) return await input.run();
  const base = {
    type: 'study.control_operation' as const,
    operationId,
    taskId: input.attribution.taskId,
    sessionId: input.attribution.sessionId ?? input.attribution.taskId,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.clientTimestamp ? { clientTimestamp: input.clientTimestamp } : {}),
    surface: input.surface,
    action: input.action,
    controlType: input.controlType,
    ...(input.payload ? { payload: input.payload } : {}),
  };
  const attempted = input.memory.logger.event({ ...base, phase: 'attempted' });
  if (
    attempted !== null
    && typeof attempted === 'object'
    && 'durableCreated' in attempted
    && attempted.durableCreated === false
  ) {
    throw new RouteError(
      409,
      'OPERATION_ALREADY_RECORDED',
      'This Control operation was already recorded. Refresh to recover its current outcome.',
    );
  }
  let result: T;
  try {
    result = await input.run();
  } catch (error) {
    try {
      input.memory.logger.event({
        ...base,
        phase: 'failed',
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    } catch {
      // A failed telemetry projection must not replace the domain error that
      // explains why no treatment mutation completed.
    }
    throw error;
  }
  try {
    input.memory.logger.event({ ...base, phase: 'completed' });
  } catch {
    // The mutation already succeeded. Returning a 500 would induce a retry;
    // leave telemetry honestly attempted/unknown and return domain success.
  }
  return result;
}

const ok = <T>(data: T, status = 200): Response => Response.json({ data }, { status });
const fail = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface BoardResolutionBase {
  taskId: string;
  chatId: string;
  gateId: string;
}

function boardResolutionBase(
  body: Record<string, unknown>,
  policy: ConditionPolicy,
  services: MemoryRouteServices,
): BoardResolutionBase | null {
  if (body.boardResolution === undefined) return null;
  if (body.surface !== 'board') {
    throw new RouteError(400, 'BAD_REQUEST', 'boardResolution requires surface=board');
  }
  if (!policy.studyMode || policy.condition !== 'memosync') {
    throw new RouteError(404, 'NOT_AVAILABLE', 'Board backlog actions only exist in the MemoSync study condition');
  }
  if (!body.boardResolution || typeof body.boardResolution !== 'object') {
    throw new RouteError(400, 'BAD_REQUEST', 'boardResolution must be an object');
  }
  const raw = body.boardResolution as Record<string, unknown>;
  if (typeof raw.taskId !== 'string' || !raw.taskId) throw new RouteError(400, 'BAD_REQUEST', 'boardResolution.taskId is required');
  if (typeof raw.chatId !== 'string' || !raw.chatId) throw new RouteError(400, 'BAD_REQUEST', 'boardResolution.chatId is required');
  if (typeof raw.gateId !== 'string' || !raw.gateId) throw new RouteError(400, 'BAD_REQUEST', 'boardResolution.gateId is required');
  if (!services.boardBacklog || !services.boardReviewAdmission) {
    throw new RouteError(503, 'NOT_AVAILABLE', 'Study Board backlog is unavailable');
  }
  const refusal = services.boardReviewAdmission(raw.taskId);
  if (refusal) throw new RouteError(409, 'BOARD_REVIEW_CLOSED', refusal);
  return { taskId: raw.taskId, chatId: raw.chatId, gateId: raw.gateId };
}

function assertPendingBoardResolution(
  services: MemoryRouteServices,
  resolution: MemoryBoardResolution | null,
): { pending: true } | { pending: false; resultId?: string } | null {
  if (!resolution) return null;
  try {
    return services.boardBacklog!.assertPending(resolution);
  } catch (error) {
    throw new RouteError(409, 'BOARD_GATE_STALE', error instanceof Error ? error.message : 'Board row is no longer pending');
  }
}

function assertPendingBoardTransfer(
  services: MemoryRouteServices,
  resolution: MemoryBoardTransferResolution | null,
): MemoryBoardTransferAdmission | null {
  if (!resolution) return null;
  try {
    return services.boardBacklog!.assertTransferPending(resolution);
  } catch (error) {
    throw new RouteError(409, 'BOARD_GATE_STALE', error instanceof Error ? error.message : 'Board Transfer row is no longer pending');
  }
}

function assertBoardTransferCommitSnapshot(
  body: Record<string, unknown>,
  trusted: MemoryBoardTrustedTransfer,
): void {
  const suggestion = trusted.suggestion;
  const mismatch = (field: string): never => {
    throw new RouteError(409, 'BOARD_GATE_STALE', `Board Transfer ${field} no longer matches the reviewed suggestion`);
  };
  if (body.sourceVersion !== suggestion.sourceVersion) mismatch('sourceVersion');
  if (body.chatId !== trusted.chatId) mismatch('chatId');
  if (typeof suggestion.content !== 'string' || !suggestion.landing) mismatch('snapshot');
  const landing = suggestion.landing!;
  if (body.detail !== suggestion.detail) mismatch('detail');
  if (body.abstractionLevel !== (suggestion.abstractionLevel ?? 'contextual')) mismatch('abstractionLevel');
  if (body.rule !== suggestion.rule) mismatch('rule');
  if (body.applicability !== suggestion.applicability) mismatch('applicability');
  if (body.landingRoute !== landing.route) mismatch('landingRoute');
  if (body.landingTargetId !== landing.targetId) mismatch('landingTargetId');
  if (body.landingTargetVersion !== landing.targetVersion) mismatch('landingTargetVersion');
  if (body.archiveOriginal === true) mismatch('archiveOriginal');

  const targetScope = body.targetScope;
  if (targetScope === 'project') {
    if (!trusted.projectId || body.targetProjectId !== trusted.projectId || body.targetSessionId !== undefined) {
      mismatch('project destination');
    }
  } else if (targetScope === 'session') {
    if (body.targetSessionId !== trusted.chatId || body.targetProjectId !== undefined) mismatch('session destination');
  } else if (targetScope === 'personal') {
    if (body.targetProjectId !== undefined || body.targetSessionId !== undefined) mismatch('personal destination');
  } else {
    mismatch('targetScope');
  }
  if (landing.route !== 'new' && targetScope !== (suggestion.suggestedScope ?? 'project')) {
    mismatch('landing scope');
  }
  const edited = typeof body.content === 'string' && body.content.trim() !== suggestion.content;
  if (body.edited !== edited) mismatch('edited state');
}

function resolveBoardRow(
  services: MemoryRouteServices,
  resolution: MemoryBoardResolution | null,
  outcome?: { resultId?: string },
): void {
  if (!resolution) return;
  try {
    services.boardBacklog!.resolve(resolution, outcome);
  } catch (error) {
    throw new RouteError(409, 'BOARD_GATE_STALE', error instanceof Error ? error.message : 'Board row is no longer pending');
  }
}

/**
 * Handle an `/api/memories*` request. Returns a Response when the path belongs
 * to the memory API (matched or a 4xx/5xx for a bad request), or `null` when
 * the path is not a memory route (so the caller falls through to other handlers).
 */
export async function handleMemoryRequest(
  req: Request,
  url: URL,
  memory: MemoryService,
  policy: ConditionPolicy = resolveConditionPolicy(),
  services: MemoryRouteServices = {},
): Promise<Response | null> {
  const { pathname } = url;
  if (pathname !== '/api/memories' && !pathname.startsWith('/api/memories/')) return null;

  // Study-condition gating: in the auto/static arms the user has no memory
  // control surface — every mutation (and working-set curation) is locked.
  // Reads stay open so citation chips etc. still resolve.
  const isMutation = req.method !== 'GET';
  const isBoardReviewSurface = pathname === '/api/memories/board-review'
    || pathname === '/api/memories/board-review/prepare'
    || pathname === '/api/memories/board-review/resume';
  if (isBoardReviewSurface && (policy.condition !== 'memosync' || !policy.studyMode)) {
    return fail(404, 'NOT_AVAILABLE', 'the blocking Memory Board only exists in the MemoSync study condition');
  }
  const isEnforce = pathname === '/api/memories/pay-attention';
  if (isEnforce && policy.condition !== 'memosync') {
    return fail(404, 'NOT_AVAILABLE', 'Enforce only exists in the MemoSync condition');
  }
  const isWorkingMemorySelection = pathname === '/api/memories/working-memory-selection';
  if (isWorkingMemorySelection && policy.condition !== 'memosync') {
    return fail(404, 'NOT_AVAILABLE', 'Working Memory selection telemetry only exists in the MemoSync condition');
  }
  // Working-set curation (session exclusions, REDESIGN D7) shares the old
  // bring-in policy flag — same class of control act, same arms allow it.
  const isWorkingSetCuration = pathname.startsWith('/api/memories/session-exclusions/');
  // Monitoring-act telemetry is pure logging — never condition-locked.
  const isTelemetry = pathname === '/api/memories/ui-monitor'
    || pathname === '/api/memories/surface-exposure';
  // Refresh only regenerates the Auto panel's derived prose. It does not
  // change the store-backed treatment memory or the frozen O_i snapshot, so
  // an automatic panel refresh must not delay the session freeze barrier.
  const isDerivedSummaryRefresh = pathname === '/api/memories/summary/refresh' && req.method === 'POST';
  // The auto arm's summary panel (baseline B1) is that arm's ONLY sanctioned
  // control channel — its chat mutations bypass the board lock, and the whole
  // surface is exclusive to the auto condition (404 elsewhere).
  const isAutoSummary = pathname === '/api/memories/summary' || pathname.startsWith('/api/memories/summary/');
  if (isAutoSummary && policy.condition !== 'auto') {
    return fail(404, 'NOT_AVAILABLE', `the memory summary surface only exists in the 'auto' condition`);
  }
  if (isWorkingSetCuration && !policy.bringIn && req.method !== 'GET') {
    return fail(403, 'CONDITION_LOCKED', `working-set curation is not available in the '${policy.condition}' condition`);
  }
  if (!isWorkingSetCuration && !isTelemetry && !isAutoSummary && isMutation && !policy.boardWritable) {
    return fail(403, 'CONDITION_LOCKED', `memory is not user-operable in the '${policy.condition}' condition`);
  }

  let releaseStudyMutation: (() => void) | undefined;
  if (isMutation && !isTelemetry && !isDerivedSummaryRefresh && !isWorkingMemorySelection && services.beginStudyMemoryMutation) {
    const release = services.beginStudyMemoryMutation();
    if (!release) {
      return fail(409, 'STUDY_FROZEN', 'The current session is ending. Memory can no longer be changed.');
    }
    releaseStudyMutation = release;
  }

  try {
    // GET /api/memories/search?q=&project=&k=
    if (pathname === '/api/memories/search') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      const q = url.searchParams.get('q') ?? '';
      const project = url.searchParams.get('project') || undefined;
      const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k')) || 6));
      if (!q.trim()) return ok({ query: q, memories: [] });
      const pool = [
        ...memory.store.list({ scope: 'personal', status: 'active' }),
        ...memory.store.list({ scope: 'project', projectId: project, status: 'active' }),
      ];
      const memories = rankMemories(q, pool)
        .slice(0, k)
        .map(({ memory: m, score }) => ({
          id: m.id,
          content: m.content,
          scope: m.scope,
          type: m.type,
          topic: m.topic,
          usageCount: m.usageCount,
          score: Number(score.toFixed(3)),
        }));
      return ok({ query: q, memories });
    }

    // Auto-arm summary surface (baseline B1). GET returns the stored prose projection +
    // staleness; refresh regenerates (LLM); chat is the conversation-only
    // control path (inspect + add/edit/forget through the panel assistant).
    if (pathname === '/api/memories/summary') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      if (!services?.summary) return fail(503, 'NOT_AVAILABLE', 'summary service is not running (no LLM configured)');
      const project = url.searchParams.get('project') || undefined;
      if (!project) return fail(400, 'BAD_REQUEST', 'project is required');
      const projectRefusal = services.summaryProjectRefusal?.(project);
      if (projectRefusal) return fail(409, 'STUDY_PROJECT_LOCKED', projectRefusal);
      return ok(services.summary.get(project));
    }
    if (pathname === '/api/memories/summary/refresh') {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');
      if (!services?.summary) return fail(503, 'NOT_AVAILABLE', 'summary service is not running (no LLM configured)');
      const b = await readBody(req);
      if (typeof b.projectId !== 'string' || !b.projectId.trim()) {
        throw new RouteError(400, 'BAD_REQUEST', 'projectId is required');
      }
      const projectRefusal = services.summaryProjectRefusal?.(b.projectId);
      if (projectRefusal) return fail(409, 'STUDY_PROJECT_LOCKED', projectRefusal);
      try {
        return ok(await services.summary.refresh(b.projectId));
      } catch (e) {
        return fail(502, 'LLM_FAILED', e instanceof Error ? e.message : 'summary generation failed');
      }
    }
    if (pathname === '/api/memories/summary/chat') {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');
      if (!services?.summary) return fail(503, 'NOT_AVAILABLE', 'summary service is not running (no LLM configured)');
      const b = await readBody(req);
      if (typeof b.message !== 'string' || !b.message.trim()) {
        throw new RouteError(400, 'BAD_REQUEST', 'message is required');
      }
      if (typeof b.projectId !== 'string' || !b.projectId.trim()) {
        throw new RouteError(400, 'BAD_REQUEST', 'projectId is required');
      }
      const projectRefusal = services.summaryProjectRefusal?.(b.projectId);
      if (projectRefusal) {
        return fail(409, 'STUDY_PROJECT_LOCKED', projectRefusal);
      }
      try {
        return ok(
          await services.summary.chat(b.message, {
            projectId: b.projectId,
            sessionId: typeof b.sessionId === 'string' ? b.sessionId : undefined,
            eventId: typeof b.eventId === 'string' && b.eventId.trim() ? b.eventId.trim() : undefined,
          }),
        );
      } catch (e) {
        if (e instanceof StudyTelemetryError) {
          return fail(e.status, e.status === 422 ? 'TELEMETRY_CONFLICT' : 'TELEMETRY_WRITE_FAILED', e.message);
        }
        return fail(502, 'LLM_FAILED', e instanceof Error ? e.message : 'memory chat failed');
      }
    }

    // GET /api/memories/needs-attention?project= — memories a drift event has
    // left contested (target of a conflicts_with), each with the item(s) that
    // supersede it. Backs the Board "needs attention" section (A1). Read-only.
    if (pathname === '/api/memories/needs-attention') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      const project = url.searchParams.get('project') || undefined;
      const items = memory.store.listConflicted(project).map((m) => ({
        memory: m,
        supersededBy: memory.store.getSupersedingItems(m.id),
      }));
      return ok({ items });
    }

    // POST /api/memories/working-memory-selection — semantic evidence for a
    // participant-observed Add/Remove toggle. Selection remains client-local
    // until Start; this route records the control act without creating a
    // second treatment-state store.
    if (pathname === '/api/memories/working-memory-selection') {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');
      const b = await readBody(req);
      if (typeof b.operationId !== 'string' || !b.operationId.trim()) {
        throw new RouteError(400, 'BAD_REQUEST', 'operationId is required');
      }
      if (typeof b.chatId !== 'string' || !b.chatId) throw new RouteError(400, 'BAD_REQUEST', 'chatId is required');
      if (typeof b.previewId !== 'string' || !b.previewId) throw new RouteError(400, 'BAD_REQUEST', 'previewId is required');
      if (typeof b.memoryId !== 'string' || !b.memoryId) throw new RouteError(400, 'BAD_REQUEST', 'memoryId is required');
      if (typeof b.clientTimestamp !== 'string' || !b.clientTimestamp) {
        throw new RouteError(400, 'BAD_REQUEST', 'clientTimestamp is required');
      }
      if (b.action !== 'add' && b.action !== 'remove') {
        throw new RouteError(400, 'BAD_REQUEST', 'action must be add or remove');
      }
      // Outside study mode there is no durable evidence store — keep the
      // control act in the longitudinal record as a plain logger event.
      if (!policy.studyMode) {
        memory.logger.event({
          type: 'memory.working_memory_selection',
          eventId: b.operationId,
          clientTimestamp: b.clientTimestamp,
          chatId: b.chatId,
          sessionId: b.chatId,
          previewId: b.previewId,
          memoryId: b.memoryId,
          action: b.action,
        });
        return ok({ observed: true, durable: false });
      }
      if (!services.workingMemoryEvidenceAdmission) {
        throw new RouteError(503, 'NOT_AVAILABLE', 'Working Memory evidence admission is unavailable');
      }
      const evidence = services.workingMemoryEvidenceAdmission({
        chatId: b.chatId,
        previewId: b.previewId,
        memoryId: b.memoryId,
        clientTimestamp: b.clientTimestamp,
      });
      if ('refusal' in evidence) throw new RouteError(409, 'WORKING_MEMORY_NOT_ACTIVE', evidence.refusal);
      await runDurableControlOperation({
        memory,
        attribution: evidence.attribution,
        surface: 'working_memory',
        operationId: b.operationId,
        chatId: b.chatId,
        clientTimestamp: b.clientTimestamp,
        action: b.action,
        controlType: 'working_memory',
        identity: `selection:${b.chatId}:${b.previewId}:${b.memoryId}:${b.action}`,
        payload: {
          chatId: b.chatId,
          previewId: b.previewId,
          memoryId: b.memoryId,
          clientTimestamp: b.clientTimestamp,
          outcome: 'observed',
        },
        run: () => undefined,
      });
      return ok({ observed: true });
    }

    // GET /api/memories/muted — the dismissal fingerprints, joined to their
    // discarded rows. POST /api/memories/muted/:id/unmute lifts only rows that
    // report canUnmute; sensitive secure erasure is permanent.
    if (pathname === '/api/memories/muted') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      return ok({ items: memory.store.listMutedProposals() });
    }
    const unmuteMatch = pathname.match(/^\/api\/memories\/muted\/([^/]+)\/unmute$/);
    if (unmuteMatch && req.method === 'POST') {
      const id = decodeURIComponent(unmuteMatch[1]);
      const lifted = memory.store.unmuteProposal(id);
      if (!lifted) throw new RouteError(404, 'NOT_FOUND', `no muted proposal for ${id}`);
      memory.logger.event({ type: 'memory.decision', action: 'unmute', id, via: 'ui' });
      return ok({ ok: true });
    }

    // Collection: /api/memories
    if (pathname === '/api/memories') {
      if (req.method === 'GET') {
        const scope = url.searchParams.get('scope') ?? undefined;
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const items = memory.store.list({
          scope: scope as MemoryScope | undefined,
          projectId,
          sessionId,
          status: status as MemoryStatus | undefined,
        });
        // Health decoration: the latest trace verdict per item (Board dot).
        const traceLabels = memory.store.latestTraceLabels();
        return ok(
          items.map((m) => {
            let out = traceLabels.has(m.id) ? { ...m, lastTraceLabel: traceLabels.get(m.id) } : m;
            // Revision decoration: a pending candidate that proposes to replace
            // an existing memory carries its target so the review card can show
            // the before → after contrast.
            if (out.status === 'candidate') {
              const target = memory.store.revisionTargetOf(out.id);
              if (target) out = { ...out, revisionOf: { id: target.id, content: target.content } };
            }
            return out;
          }),
        );
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const surface = controlSurface(b.surface);
        const via = surface ?? 'ui';
        const attribution = studyInteractionAttribution(policy, services);
        if (!b.content || !b.scope) {
          throw new RouteError(400, 'BAD_REQUEST', 'content and scope are required');
        }
        // `type` stays a DB column (capture still classifies), but the UI no
        // longer surfaces it — manual creations default to 'fact'.
        if (b.type === undefined) b.type = 'fact';
        assertEnum(b.scope, MEMORY_SCOPES, 'scope');
        assertEnum(b.type, MEMORY_TYPES, 'type');
        assertEnum(b.status, MEMORY_STATUSES, 'status');
        assertEnum(b.abstractionLevel, ABSTRACTION_LEVELS, 'abstractionLevel');
        assertString(b.content, 'content');
        assertString(b.detail, 'detail');
        assertString(b.projectId, 'projectId');
        assertString(b.sessionId, 'sessionId');
        assertString(b.topic, 'topic');
        assertString(b.provenanceSessionId, 'provenanceSessionId');
        assertNumber(b.provenanceTurn, 'provenanceTurn');
        if (b.scope === 'project' && !b.projectId) {
          throw new RouteError(400, 'BAD_REQUEST', "scope 'project' requires projectId");
        }
        if (b.scope === 'session' && !b.sessionId) {
          throw new RouteError(400, 'BAD_REQUEST', "scope 'session' requires sessionId");
        }
        const created = await runDurableControlOperation({
          memory,
          attribution,
          surface,
          operationId: b.operationId,
          action: 'create',
          controlType: 'crud',
          identity: `create:${String(b.scope)}`,
          payload: { scope: b.scope },
          run: () => memory.store.create({
            content: b.content as string,
            detail: b.detail as string | undefined,
            abstractionLevel: b.abstractionLevel as AbstractionLevel | undefined,
            sensitive: b.sensitive === true,
            scope: b.scope as MemoryScope,
            type: b.type as MemoryType,
            status: b.status as MemoryStatus | undefined,
            projectId: b.projectId as string | undefined,
            sessionId: b.sessionId as string | undefined,
            topic: b.topic as string | undefined,
            provenanceSessionId: b.provenanceSessionId as string | undefined,
            provenanceTurn: b.provenanceTurn as number | undefined,
          }, UI_ACTOR),
        });
        // Decision first, projection second: syncProjection may ingest a dirty
        // file and emit derived events — the causal order in the log must be
        // decision → derived, never the reverse.
        memory.logger.event({ type: 'memory.decision', ...attribution, action: 'create', id: created.id, toScope: created.scope, via });
        // Candidates are projected too (Pending review section), so every
        // create refreshes the file, not just active ones.
        memory.syncProjection(created.projectId);
        return ok(created, 201);
      }
      return fail(405, 'METHOD_NOT_ALLOWED', 'use GET or POST');
    }

    // Session exclusion set (REDESIGN D7): GET/PUT
    // /api/memories/session-exclusions/:sessionId — the ids muted for this
    // session. Default (no row / []) = everything active injects.
    const exclusionsMatch = pathname.match(/^\/api\/memories\/session-exclusions\/([^/]+)$/);
    if (exclusionsMatch) {
      const sessionId = decodeURIComponent(exclusionsMatch[1]);
      if (req.method === 'GET') {
        return ok({ sessionId, ids: memory.store.getSessionExclusions(sessionId) });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (!Array.isArray(b.ids) || b.ids.some((x) => typeof x !== 'string')) {
          throw new RouteError(400, 'BAD_REQUEST', 'ids must be an array of memory id strings');
        }
        const ids = b.ids as string[];
        memory.store.setSessionExclusions(sessionId, ids);
        memory.logger.event({ type: 'memory.exclude', sessionId, ids });
        return ok({ sessionId, ids });
      }
      return fail(405, 'METHOD_NOT_ALLOWED', 'use GET or PUT');
    }

    // POST /api/memories/find-duplicates { projectId? }
    if (pathname === '/api/memories/find-duplicates' && req.method === 'POST') {
      const b = await readBody(req);
      const projectId = typeof b.projectId === 'string' ? b.projectId : undefined;
      const active = memory.store
        .list({ status: 'active' })
        .filter((m) => (projectId ? m.scope === 'personal' || m.projectId === projectId : true));
      const groups = new Map<string, MemoryItem[]>();
      for (const m of active) {
        const key = m.content.trim().toLowerCase().replace(/\s+/g, ' ');
        const arr = groups.get(key);
        if (arr) arr.push(m);
        else groups.set(key, [m]);
      }
      const duplicates = [...groups.values()].filter((g) => g.length > 1);
      return ok({ duplicates });
    }

    // POST /api/memories/merge-duplicates { ids, keepId }
    if (pathname === '/api/memories/merge-duplicates' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = b.ids;
      const keepId = b.keepId;
      if (!Array.isArray(ids) || !keepId || typeof keepId !== 'string') {
        throw new RouteError(400, 'BAD_REQUEST', 'ids[] and keepId are required');
      }
      const keep = memory.store.getById(keepId);
      if (!keep) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${keepId}`);
      const affected = new Set<string | undefined>([keep.projectId]);
      for (const id of ids as string[]) {
        const dup = id !== keepId ? memory.store.getById(id) : null;
        if (dup) {
          affected.add(dup.projectId);
          memory.store.archive(id, UI_ACTOR);
        }
      }
      for (const p of affected) memory.syncProjection(p);
      return ok(memory.store.getById(keepId));
    }

    // GET /api/memories/:id/history — the full append-only version/usage log
    // (SPEC §4.11 option 乙): every change with before→after + actor + session,
    // and every use.
    const histMatch = pathname.match(/^\/api\/memories\/([^/]+)\/history$/);
    if (histMatch && req.method === 'GET') {
      const id = decodeURIComponent(histMatch[1]);
      const mem = memory.store.getById(id);
      if (!mem) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      return ok({ memory: mem, events: memory.store.getEvents(id) });
    }

    // POST /api/memories/:id/revert { toSeq } — roll back to a prior version
    // (a change event's snapshot). History is preserved; the rollback itself
    // is appended as a 'revert' event.
    const revertMatch = pathname.match(/^\/api\/memories\/([^/]+)\/revert$/);
    if (revertMatch && req.method === 'POST') {
      const id = decodeURIComponent(revertMatch[1]);
      const existing = memory.store.getById(id);
      if (!existing) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      const b = await readBody(req);
      if (typeof b.toSeq !== 'number' || !Number.isFinite(b.toSeq)) {
        throw new RouteError(400, 'BAD_REQUEST', 'toSeq (a history event seq) is required');
      }
      const surface = controlSurface(b.surface);
      const via = surface ?? 'ui';
      const attribution = studyInteractionAttribution(policy, services);
      const reverted = await runDurableControlOperation({
        memory,
        attribution,
        surface,
        operationId: b.operationId,
        action: 'revert',
        controlType: 'crud',
        identity: `memory:${id}:v${existing.version}:revert:${String(b.toSeq)}`,
        payload: { memoryId: id, toSeq: b.toSeq },
        run: () => {
          try {
            return memory.store.rollback(id, b.toSeq as number, UI_ACTOR);
          } catch (e) {
            if (e instanceof CandidateDismissalTransitionError) throw e;
            throw new RouteError(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'rollback failed');
          }
        },
      });
      memory.logger.event({
        type: 'memory.decision',
        ...attribution,
        action: 'revert',
        id,
        fromScope: existing.scope,
        toScope: reverted.scope,
        via,
      });
      memory.syncProjection(existing.projectId);
      if (reverted.projectId !== existing.projectId) memory.syncProjection(reverted.projectId);
      return ok(reverted);
    }

    // POST /api/memories/attention-resolve { kind, id, action, otherId? }
    // — the gate attention row's domain actions: validated against live
    // state, logged as memory.attention (never a generic edit).
    // conflict/revision/stale: action keep|archive. redundant: action
    // merge|keep with otherId (merge → LLM-drafted merge proposal on the
    // review lane; keep → similar_to acknowledgment, pair never re-rides).
    // POST /api/memories/pay-attention { id, sessionId } — audit follow-up ①:
    // the memory is right, the agent didn't comply. Queue the id; the NEXT
    // turn's injected list seeds it (source "pay attention") and the boot
    // reminder names it. Consumed once.
    if (pathname === '/api/memories/pay-attention' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.id !== 'string' || !b.id) throw new RouteError(400, 'BAD_REQUEST', 'id is required');
      if (typeof b.sessionId !== 'string' || !b.sessionId) throw new RouteError(400, 'BAD_REQUEST', 'sessionId is required');
      if (!services.auditAdmission) {
        throw new RouteError(503, 'NOT_AVAILABLE', 'Study Audit admission is unavailable');
      }
      const refusal = services.auditAdmission({ chatId: b.sessionId, memoryId: b.id });
      if (refusal) throw new RouteError(409, 'ENFORCE_NOT_ALLOWED', refusal);
      const attribution = studyInteractionAttribution(policy, services);
      const item = memory.store.getById(b.id);
      if (!item || item.status !== 'active') throw new RouteError(409, 'CONFLICT', 'only an active memory can be flagged');
      // Enforce (renamed from pay-attention, 2026-08-19 D1): entries carry the
      // violation quote so next run's order can cite the evidence. Legacy
      // queues of bare id strings still normalize on read.
      const quote = typeof b.quote === 'string' && b.quote.trim() ? b.quote.trim().slice(0, 300) : undefined;
      const operationId = durableOperationId({
        provided: b.operationId,
        attribution,
        surface: 'audit',
        controlType: 'audit',
        identity: `enforce:${b.sessionId}:${b.id}`,
      });
      await runDurableControlOperation({
        memory,
        attribution,
        surface: 'audit',
        operationId: operationId ?? undefined,
        action: 'enforce',
        controlType: 'audit',
        identity: `enforce:${b.sessionId}:${b.id}`,
        payload: { memoryId: b.id, chatId: b.sessionId },
        run: () => {
          const key = `pay_attention:${b.sessionId}`;
          const current = memory.store.getKv<Array<string | { id: string; quote?: string }>>(key) ?? [];
          const has = current.some((e) => (typeof e === 'string' ? e : e.id) === b.id);
          if (!has) memory.store.setKv(key, [...current, { id: b.id, ...(quote ? { quote } : {}) }]);
        },
      });
      memory.logger.event({
        type: 'memory.audit_action',
        ...attribution,
        chatId: b.sessionId,
        ...(operationId ? { operationId } : {}),
        id: b.id,
        action: 'enforce',
      });
      return ok({ queued: b.id });
    }

    // Session-start Memory Board gate receipt (2026-08-19 E1): the participant
    // reviewed the library before entering this session. Stored per task in kv.
    // The pending count is server-authoritative and intentionally ignores every
    // Board search/project lens: a hidden row cannot make the blocking gate pass.
    if (pathname === '/api/memories/board-review' && req.method === 'GET') {
      const taskId = url.searchParams.get('taskId');
      if (!taskId) throw new RouteError(400, 'BAD_REQUEST', 'taskId is required');
      if (!services.boardReviewAdmission) return fail(503, 'NOT_AVAILABLE', 'Study Board admission is unavailable');
      const refusal = services.boardReviewAdmission(taskId);
      if (refusal) return fail(409, 'BOARD_REVIEW_CLOSED', refusal);
      if (!services.boardBacklog) return fail(503, 'NOT_AVAILABLE', 'Memory Board backlog is unavailable');
      return ok(services.boardBacklog.reviewState(taskId));
    }
    if (pathname === '/api/memories/board-review/prepare' && req.method === 'POST') {
      if (!policy.studyMode || policy.condition !== 'memosync') {
        return fail(409, 'BOARD_REVIEW_NOT_ALLOWED', 'Opening Memory Board preparation is only available in the MemoSync study condition');
      }
      const b = await readBody(req);
      if (typeof b.taskId !== 'string' || !b.taskId) throw new RouteError(400, 'BAD_REQUEST', 'taskId is required');
      if (typeof b.chatId !== 'string' || !b.chatId) throw new RouteError(400, 'BAD_REQUEST', 'chatId is required');
      if (typeof b.reviewId !== 'string' || !b.reviewId) throw new RouteError(400, 'BAD_REQUEST', 'reviewId is required');
      if (typeof b.content !== 'string') throw new RouteError(400, 'BAD_REQUEST', 'content is required');
      if (b.attachments !== undefined && !Array.isArray(b.attachments)) {
        throw new RouteError(400, 'BAD_REQUEST', 'attachments must be an array');
      }
      if (!services.boardReviewAdmission) return fail(503, 'NOT_AVAILABLE', 'Study Board admission is unavailable');
      const refusal = services.boardReviewAdmission(b.taskId);
      if (refusal) return fail(409, 'BOARD_REVIEW_CLOSED', refusal);
      if (!services.boardBacklog) return fail(503, 'NOT_AVAILABLE', 'Memory Board backlog is unavailable');
      if (!services.openingPromptAdmission) {
        return fail(503, 'NOT_AVAILABLE', 'Opening prompt admission is unavailable');
      }
      const attachments = b.attachments ?? [];
      // A same-identity response-loss retry is owned by the already-durable
      // snapshot. Never re-read the now-mutable upload path merely to
      // acknowledge that exact claim.
      const existingOpeningPrompt = services.boardBacklog.recoverOpeningPrompt(b.taskId);
      let attachmentSnapshots: import('../study-opening-attachments').StudyOpeningAttachmentSnapshot[] | undefined;
      if (!existingOpeningPrompt) {
        const admission = services.openingPromptAdmission({
          chatId: b.chatId,
          reviewId: b.reviewId,
          content: b.content,
          attachments,
        });
        const promptRefusal = typeof admission === 'string' ? admission : admission?.refusal ?? null;
        if (promptRefusal) return fail(409, 'OPENING_PROMPT_REFUSED', promptRefusal);
        if (admission && typeof admission === 'object') attachmentSnapshots = admission.attachmentSnapshots;
      }
      try {
        services.boardBacklog.prepareOpeningPrompt({
          taskId: b.taskId,
          chatId: b.chatId,
          reviewId: b.reviewId,
          content: b.content,
          attachments,
          ...(attachmentSnapshots ? { attachmentSnapshots } : {}),
          ...(b.dispatch && typeof b.dispatch === 'object'
            ? { dispatch: b.dispatch as import('./board-backlog').MemoryBoardOpeningPromptInput['dispatch'] }
            : {}),
        });
      } catch (error) {
        return fail(409, 'BOARD_REVIEW_PREPARE_REFUSED', error instanceof Error ? error.message : 'Could not prepare the opening Memory Board');
      }
      services.resumeOpeningBoardPreparation?.();
      return ok(services.boardBacklog.reviewState(b.taskId));
    }
    if (pathname === '/api/memories/board-review/resume' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.taskId !== 'string' || !b.taskId) throw new RouteError(400, 'BAD_REQUEST', 'taskId is required');
      if (!services.boardReviewAdmission) return fail(503, 'NOT_AVAILABLE', 'Study Board admission is unavailable');
      const refusal = services.boardReviewAdmission(b.taskId);
      if (refusal) return fail(409, 'BOARD_REVIEW_CLOSED', refusal);
      if (!services.boardBacklog || !services.resumeOpeningBoardPreparation) {
        return fail(503, 'NOT_AVAILABLE', 'Opening Memory Board recovery is unavailable');
      }
      const openingPrompt = services.boardBacklog.reviewState(b.taskId).openingPrompt;
      if (!openingPrompt) return fail(409, 'BOARD_REVIEW_NOT_PREPARED', 'No waiting first message is prepared');
      services.resumeOpeningBoardPreparation();
      return ok(services.boardBacklog.reviewState(b.taskId));
    }
    if (pathname === '/api/memories/board-review' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.taskId !== 'string' || !b.taskId) throw new RouteError(400, 'BAD_REQUEST', 'taskId is required');
      if (!services.boardReviewAdmission) return fail(503, 'NOT_AVAILABLE', 'Study Board admission is unavailable');
      const refusal = services.boardReviewAdmission(b.taskId);
      if (refusal) return fail(409, 'BOARD_REVIEW_CLOSED', refusal);
      if (!services.boardBacklog) return fail(503, 'NOT_AVAILABLE', 'Memory Board backlog is unavailable');
      const openingPrompt = services.boardBacklog.reviewState(b.taskId).openingPrompt;
      const completion = openingPrompt
        ? (
            typeof b.chatId === 'string'
            && typeof b.reviewId === 'string'
            && b.chatId === openingPrompt.chatId
            && b.reviewId === openingPrompt.reviewId
              ? services.boardBacklog.completeOpeningPromptReview(openingPrompt)
              : { completed: false, state: services.boardBacklog.reviewState(b.taskId) }
          )
        : services.boardBacklog.completeReview(b.taskId);
      if (!completion.completed) {
        if (openingPrompt && completion.state.openingPrompt?.phase === 'preparing') {
          // A Long-term-ready CAS can be invalidated by a Board mutation even
          // when no original process waiter survived. Re-prime the durable
          // preparation; coordinator ownership keeps this single-run.
          services.resumeOpeningBoardPreparation?.();
        }
        const { pending } = completion.state;
        const currentOpeningPrompt = completion.state.openingPrompt;
        const message = currentOpeningPrompt
          && currentOpeningPrompt.phase !== 'long_term_ready'
          && currentOpeningPrompt.phase !== 'completed'
          ? 'The current message changed and is refreshing its Long-term Memory review.'
          : `${pending.total} memory review item${pending.total === 1 ? '' : 's'} still need attention.`;
        return fail(409, 'BOARD_REVIEW_PENDING', message);
      }
      return ok(completion.state);
    }

    // POST /api/memories/:id/draft-revision { sessionId? } — audit follow-up
    // ②: the memory itself is at fault. Draft a fix immediately (no streak
    // required); the proposal parks for the next step-one gate.
    const draftMatch = pathname.match(/^\/api\/memories\/([^/]+)\/draft-revision$/);
    if (draftMatch && req.method === 'POST') {
      if (!services?.revision) throw new RouteError(503, 'NO_LLM', 'revision drafting needs the LLM service');
      const id = decodeURIComponent(draftMatch[1]);
      const b = await readBody(req);
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      const attribution = studyInteractionAttribution(policy, services);
      if (policy.studyMode && policy.condition === 'memosync') {
        if (!sessionId) throw new RouteError(400, 'BAD_REQUEST', 'sessionId is required');
        if (!services.auditAdmission) {
          throw new RouteError(503, 'NOT_AVAILABLE', 'Study Audit admission is unavailable');
        }
        const refusal = services.auditAdmission({ chatId: sessionId, memoryId: id });
        if (refusal) throw new RouteError(409, 'AUDIT_ACTION_NOT_ALLOWED', refusal);
      }
      const operationId = durableOperationId({
        provided: b.operationId,
        attribution,
        surface: 'audit',
        controlType: 'audit',
        identity: `draft-fix:${sessionId ?? attribution.sessionId ?? 'unknown'}:${id}`,
      });
      const proposal = await runDurableControlOperation({
        memory,
        attribution,
        surface: 'audit',
        operationId: operationId ?? undefined,
        action: 'draft_fix',
        controlType: 'audit',
        identity: `draft-fix:${sessionId ?? attribution.sessionId ?? 'unknown'}:${id}`,
        payload: { memoryId: id, ...(sessionId ? { chatId: sessionId } : {}) },
        run: async () => {
          const drafted = await services.revision!.draftFor(id, { sessionId });
          if (!drafted) {
            throw new RouteError(409, 'CONFLICT', 'no fix could be drafted (open revision, unchanged draft, or the memory moved)');
          }
          return drafted;
        },
      });
      memory.logger.event({
        type: 'memory.audit_action',
        sessionId,
        ...(operationId ? { operationId } : {}),
        id,
        action: 'draft_fix',
      });
      return ok(proposal);
    }

    // POST /api/memories/revise-injection { instruction, selectedIds, poolIds }
    // — the Step 2 card's talking assistant: instructions change the
    // selection, questions get answered; either way a reply comes back. Pure
    // suggestion machinery: nothing is persisted here; the gate's Start is
    // the only commit point.
    if (pathname === '/api/memories/revise-injection' && req.method === 'POST') {
      if (!services?.reviseInjection) throw new RouteError(503, 'NO_LLM', 'injection revision needs the LLM service');
      const b = await readBody(req);
      if (typeof b.instruction !== 'string' || !b.instruction.trim()) {
        throw new RouteError(400, 'BAD_REQUEST', 'instruction is required');
      }
      const requestedPoolIds = Array.isArray(b.poolIds) ? b.poolIds.filter((x): x is string => typeof x === 'string') : [];
      const requestedIds = Array.isArray(b.selectedIds) ? b.selectedIds.filter((x): x is string => typeof x === 'string') : [];
      const attribution = studyInteractionAttribution(policy, services);
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      const previewId = typeof b.previewId === 'string' ? b.previewId : undefined;
      let effectivePoolIds = requestedPoolIds;
      if (policy.studyMode && policy.condition === 'memosync') {
        if (!sessionId || !previewId) {
          throw new RouteError(400, 'BAD_REQUEST', 'sessionId and previewId are required');
        }
        if (!services.workingMemorySelectionAdmission) {
          throw new RouteError(503, 'NOT_AVAILABLE', 'Working Memory admission is unavailable');
        }
        const refusal = services.workingMemorySelectionAdmission({ chatId: sessionId, previewId });
        if (refusal) throw new RouteError(409, 'WORKING_MEMORY_NOT_ACTIVE', refusal);
        if (!services.workingMemoryPool) {
          throw new RouteError(503, 'NOT_AVAILABLE', 'Working Memory pool authority is unavailable');
        }
        const authoritativePool = services.workingMemoryPool({ chatId: sessionId, previewId });
        if (!authoritativePool) {
          throw new RouteError(409, 'WORKING_MEMORY_NOT_ACTIVE', 'This Working Memory selection is no longer active.');
        }
        effectivePoolIds = authoritativePool;
      }
      const effectivePool = new Set(effectivePoolIds);
      const pool = effectivePoolIds
        .map((id) => memory.store.getById(id))
        .filter((m): m is NonNullable<typeof m> => Boolean(m && m.status === 'active'))
        .map((m) => ({ id: m.id, content: m.content }));
      const livePoolIds = pool.map((item) => item.id);
      const requestedSelection = new Set(requestedIds);
      const effectiveIds = livePoolIds.filter((id) => effectivePool.has(id) && requestedSelection.has(id));
      const operationId = durableOperationId({
        provided: b.operationId,
        attribution,
        surface: 'working_memory',
        controlType: 'working_memory',
        identity: `ask-agent:${sessionId ?? attribution.sessionId ?? 'unknown'}`,
      });
      const result = await runDurableControlOperation({
        memory,
        attribution,
        surface: 'working_memory',
        operationId: operationId ?? undefined,
        action: 'ask_agent',
        controlType: 'working_memory',
        identity: `ask-agent:${sessionId ?? attribution.sessionId ?? 'unknown'}`,
        payload: {
          ...(sessionId ? { chatId: sessionId } : {}),
          ...(previewId ? { previewId } : {}),
          requestedPoolIds,
          effectivePoolIds: livePoolIds,
          requestedIds,
          effectiveIds,
        },
        run: () => services.reviseInjection!.revise({ instruction: b.instruction as string, pool, selectedIds: effectiveIds }),
      });
      const revisedSelection = new Set(result.selectedIds);
      const effectiveResult = {
        ...result,
        selectedIds: livePoolIds.filter((id) => revisedSelection.has(id)),
      };
      // The Adjusting-stage act itself (selection still commits via Start →
      // memory.preview; without this the instruction would leave no trace).
      const before = new Set(effectiveIds);
      memory.logger.event({
        type: 'memory.revise_injection',
        ...(operationId ? { operationId } : {}),
        sessionId,
        instruction: b.instruction.trim(),
        beforeIds: effectiveIds,
        afterIds: effectiveResult.selectedIds,
        changed: effectiveResult.selectedIds.length !== effectiveIds.length || effectiveResult.selectedIds.some((id) => !before.has(id)),
      });
      return ok(effectiveResult);
    }

    // POST /api/memories/plan-injection-uses
    // In the formal MemoSync arm, task text and pool membership are owned by
    // the exact pending preview. Client text is display input only and never
    // becomes a treatment instruction. Non-study callers retain the legacy
    // task + selectedIds planning API.
    if (pathname === '/api/memories/plan-injection-uses' && req.method === 'POST') {
      const b = await readBody(req);
      const selectedIds = Array.isArray(b.selectedIds)
        ? b.selectedIds.filter((id): id is string => typeof id === 'string')
        : [];
      const seen = new Set<string>();
      const uniqueIds = selectedIds.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (policy.studyMode && policy.condition === 'memosync') {
        if (typeof b.sessionId !== 'string' || !b.sessionId) {
          throw new RouteError(400, 'BAD_REQUEST', 'sessionId is required');
        }
        if (typeof b.previewId !== 'string' || !b.previewId) {
          throw new RouteError(400, 'BAD_REQUEST', 'previewId is required');
        }
        if (!services.workingMemorySelectionAdmission || !services.workingMemoryPool || !services.workingMemoryUsePlan) {
          throw new RouteError(503, 'NOT_AVAILABLE', 'Working Memory planning authority is unavailable');
        }
        const refusal = services.workingMemorySelectionAdmission({
          chatId: b.sessionId,
          previewId: b.previewId,
        });
        if (refusal) throw new RouteError(409, 'WORKING_MEMORY_STALE', refusal);
        const pool = services.workingMemoryPool({ chatId: b.sessionId, previewId: b.previewId });
        if (!pool) throw new RouteError(409, 'WORKING_MEMORY_STALE', 'This Working Memory preview is no longer active');
        const poolIds = new Set(pool);
        return ok(await services.workingMemoryUsePlan({
          chatId: b.sessionId,
          previewId: b.previewId,
          selectedIds: uniqueIds.filter((id) => poolIds.has(id)),
        }));
      }

      if (!services.usePlan) throw new RouteError(503, 'NO_LLM', 'memory use planning needs the LLM service');
      if (typeof b.task !== 'string') throw new RouteError(400, 'BAD_REQUEST', 'task is required');
      const memories = uniqueIds
        .map((id) => memory.store.getById(id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item && item.status === 'active'))
        .map((item) => ({ id: item.id, content: item.content, hasDetail: Boolean(item.detail) }));
      return ok(await services.usePlan.plan({ task: b.task, memories }));
    }

    if (pathname === '/api/memories/attention-resolve' && req.method === 'POST') {
      if (!services?.maintenance) throw new RouteError(404, 'NOT_AVAILABLE', 'maintenance is not enabled in this condition');
      const b = await readBody(req);
      const kind = b.kind as AttentionKind;
      if (kind !== 'conflict' && kind !== 'stale' && kind !== 'redundant') {
        throw new RouteError(400, 'BAD_REQUEST', 'kind must be conflict | redundant | stale');
      }
      if (typeof b.id !== 'string' || !b.id) throw new RouteError(400, 'BAD_REQUEST', 'id is required');
      const boardBase = boardResolutionBase(b, policy, services);
      let boardResolution: MemoryBoardResolution | null = null;
      let boardAdmission: ReturnType<typeof assertPendingBoardResolution> = null;
      if (boardBase) {
        const raw = b.boardResolution as Record<string, unknown>;
        const suggestionKind = raw.suggestionKind;
        const expectedKind = kind === 'stale' ? 'staleness' : kind === 'redundant' ? 'redundancy' : 'conflict';
        if (suggestionKind !== expectedKind) {
          throw new RouteError(400, 'BAD_REQUEST', `boardResolution.suggestionKind must be ${expectedKind}`);
        }
        if (typeof raw.memoryId !== 'string' || !raw.memoryId) {
          throw new RouteError(400, 'BAD_REQUEST', 'boardResolution.memoryId is required');
        }
        if (raw.otherMemoryId !== undefined && typeof raw.otherMemoryId !== 'string') {
          throw new RouteError(400, 'BAD_REQUEST', 'boardResolution.otherMemoryId must be a string');
        }
        const topLevelOtherId = typeof b.otherId === 'string' ? b.otherId : undefined;
        if (raw.memoryId !== b.id || raw.otherMemoryId !== topLevelOtherId) {
          throw new RouteError(
            400,
            'BAD_REQUEST',
            'boardResolution memoryId/otherMemoryId must exactly match id/otherId',
          );
        }
        boardResolution = {
          ...boardBase,
          kind: 'checkup',
          suggestionKind: suggestionKind as 'conflict' | 'redundancy' | 'staleness',
          memoryId: raw.memoryId,
          ...(typeof raw.otherMemoryId === 'string' ? { otherMemoryId: raw.otherMemoryId } : {}),
        };
        boardAdmission = assertPendingBoardResolution(services, boardResolution);
      }
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      const surface = controlSurface(b.surface);
      const attribution = studyInteractionAttribution(policy, services);
      const meta = { ...UI_ACTOR, sessionId, surface, studyAttribution: attribution };

      // Retry after mutation-before-receipt: canonical memory state already
      // invalidated this transcript row and materialized a durable receipt.
      if (boardAdmission?.pending === false) {
        return ok(memory.store.getById(b.id) ?? { resolved: true });
      }

      if (kind === 'redundant') {
        if (typeof b.otherId !== 'string' || !b.otherId) {
          throw new RouteError(400, 'BAD_REQUEST', 'otherId is required for a redundant pair');
        }
        if (b.action !== 'merge' && b.action !== 'keep') {
          throw new RouteError(400, 'BAD_REQUEST', "action must be 'merge' or 'keep'");
        }
        return await runDurableControlOperation({
          memory,
          attribution,
          surface,
          operationId: b.operationId,
          action: b.action,
          controlType: 'checkup',
          identity: `${boardResolution?.gateId ?? 'chat'}:redundant:${b.id}:${b.otherId}:${b.action}`,
          payload: { kind, memoryId: b.id, otherMemoryId: b.otherId },
          run: async () => {
            try {
              if (b.action === 'keep') {
                services.maintenance!.keepBoth(b.id as string, b.otherId as string, meta);
                resolveBoardRow(services, boardResolution);
                return ok({ kept: [b.id, b.otherId] });
              }
              const proposal = await services.maintenance!.merge(b.id as string, b.otherId as string, meta);
              if (!proposal) {
                // Drafting raced a concurrent edit/revision — the card is stale.
                throw new RouteError(409, 'CONFLICT', 'merge draft could not bind (a memory moved) — re-open the card');
              }
              resolveBoardRow(services, boardResolution);
              return ok(proposal);
            } catch (e) {
              if (e instanceof RouteError) throw e;
              throw new RouteError(409, 'CONFLICT', e instanceof Error ? e.message : 'redundant action failed');
            }
          },
        });
      }

      if (b.action !== 'keep' && b.action !== 'archive') {
        throw new RouteError(400, 'BAD_REQUEST', "action must be 'keep' or 'archive'");
      }
      return await runDurableControlOperation({
        memory,
        attribution,
        surface,
        operationId: b.operationId,
        action: b.action,
        controlType: 'checkup',
        identity: `${boardResolution?.gateId ?? 'chat'}:${kind}:${b.id}:${b.action}`,
        payload: { kind, memoryId: b.id },
        run: () => {
          try {
            const result = b.action === 'keep'
              ? services.maintenance!.renew(b.id as string, meta)
              : services.maintenance!.archive(kind, b.id as string, meta);
            resolveBoardRow(services, boardResolution);
            return ok(result);
          } catch (e) {
            throw new RouteError(409, 'CONFLICT', e instanceof Error ? e.message : 'attention action failed');
          }
        },
      });
    }

    // POST /api/memories/:id/transfer-preview { targetScope, targetProjectId? }
    // — cross-context transfer judgment (DG3): as_is / rewrite / context_bound,
    // with the adapted form. LLM when available; verbatim as_is otherwise.
    const sanitizeMatch = pathname.match(/^\/api\/memories\/([^/]+)\/sanitize-preview$/);
    if (sanitizeMatch && req.method === 'POST') {
      const id = decodeURIComponent(sanitizeMatch[1]);
      const source = memory.store.getById(id);
      if (!source) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      // Never degrade to the raw text: a failed redaction that LOOKS clean is
      // exactly the accident this instrument exists to prevent (DG1). The
      // client's fallback is manual editing, not a fake proposal.
      if (!services.sanitize) {
        throw new RouteError(503, 'NO_LLM', 'sanitize needs the LLM service and none is configured');
      }
      try {
        const proposal = await services.sanitize.propose({ content: source.content, detail: source.detail });
        memory.logger.event({ type: 'memory.sanitize', id, redactions: proposal.redactions.length });
        return ok(proposal);
      } catch (e) {
        console.warn('[memory] sanitize LLM failed (surfacing, not degrading):', e);
        throw new RouteError(502, 'SANITIZE_FAILED', e instanceof Error ? e.message : 'sanitize failed');
      }
    }

    const previewMatch = pathname.match(/^\/api\/memories\/([^/]+)\/transfer-preview$/);
    if (previewMatch && req.method === 'POST') {
      const id = decodeURIComponent(previewMatch[1]);
      const source = memory.store.getById(id);
      if (!source) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      const b = await readBody(req);
      assertEnum(b.targetScope, MEMORY_SCOPES, 'targetScope');
      const targetScope = b.targetScope as MemoryScope;
      const targetProjectId = typeof b.targetProjectId === 'string' ? b.targetProjectId : undefined;
      const targetSessionId = typeof b.targetSessionId === 'string' ? b.targetSessionId : undefined;
      // The landing judgment needs the target context's existing actives
      // (excluding the source itself when moving within a scope).
      const targetExisting = (
        targetScope === 'personal'
          ? memory.store.list({ scope: 'personal', status: 'active' })
          : targetScope === 'session'
            ? (targetSessionId ? memory.store.list({ scope: 'session', sessionId: targetSessionId, status: 'active' }) : [])
            : targetProjectId
              ? memory.store.list({ scope: 'project', projectId: targetProjectId, status: 'active' })
              : []
      ).filter((m) => m.id !== source.id);
      const target = {
        scope: targetScope,
        projectId: targetProjectId,
        projectTitle: typeof b.targetProjectTitle === 'string' ? b.targetProjectTitle : undefined,
        existing: targetExisting,
      };
      const fallback = {
        verdict: 'as_is',
        portable: source.content,
        content: source.content,
        detail: source.detail,
        abstractionLevel: source.abstractionLevel,
        note: 'Transfer assistant unavailable — the memory would move verbatim; edit below if it needs adapting.',
        landing: { route: 'new' },
      };
      if (!services.transfer) return ok(fallback);
      // Encoder input (Transfer design 2026-08-08): the source context
      // profile — a few representative memories from the source's own shelf —
      // shows what is source-local and must be stripped.
      const profile = (
        source.scope === 'project' && source.projectId
          ? memory.store.list({ scope: 'project', projectId: source.projectId, status: 'active' })
          : source.scope === 'session' && source.sessionId
            ? memory.store.list({ scope: 'session', sessionId: source.sessionId, status: 'active' })
            : []
      )
        .filter((m) => m.id !== source.id)
        .sort((a, b2) => b2.usageCount + b2.reinforcedCount - (a.usageCount + a.reinforcedCount))
        .slice(0, 5);
      try {
        return ok(
          await services.transfer.propose(source, target, {
            projectTitle: typeof b.sourceProjectTitle === 'string' ? b.sourceProjectTitle : undefined,
            representative: profile,
          }),
        );
      } catch {
        return ok(fallback);
      }
    }

    // POST /api/memories/:id/transfer — commit a cross-context transfer: a NEW
    // memory in the target context, linked derived_from the source (the source
    // keeps serving its own context unless archiveOriginal).
    const transferMatch = pathname.match(/^\/api\/memories\/([^/]+)\/transfer$/);
    if (transferMatch && req.method === 'POST') {
      const id = decodeURIComponent(transferMatch[1]);
      const source = memory.store.getById(id);
      if (!source) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      const b = await readBody(req);
      const surface = controlSurface(b.surface);
      const attribution = studyInteractionAttribution(policy, services);
      const boardBase = boardResolutionBase(b, policy, services);
      const boardResolution: MemoryBoardTransferResolution | null = boardBase
        ? { ...boardBase, kind: 'transfer', sourceId: id }
        : null;
      const boardAdmission = assertPendingBoardTransfer(services, boardResolution);
      if (boardAdmission?.pending === false) {
        const result = boardAdmission.resultId ? memory.store.getById(boardAdmission.resultId) : null;
        return ok(result ? { ...result, relations: memory.store.getRelations(result.id) } : source);
      }
      if (boardAdmission?.pending === true) assertBoardTransferCommitSnapshot(b, boardAdmission.trusted);
      // Transcript Transfer cards carry the exact source snapshot they were
      // computed from. Board resurfacing is bound to that same durable row.
      if (b.sourceVersion !== undefined) {
        if (typeof b.sourceVersion !== 'number' || !Number.isInteger(b.sourceVersion) || b.sourceVersion < 1) {
          throw new RouteError(400, 'BAD_REQUEST', 'sourceVersion must be a positive integer');
        }
        if (source.status !== 'active' || source.version !== b.sourceVersion) {
          throw new RouteError(409, 'CONFLICT', 'source memory changed or is no longer active; review Transfer again');
        }
      }
      assertEnum(b.targetScope, MEMORY_SCOPES, 'targetScope');
      assertString(b.content, 'content');
      assertEnum(b.abstractionLevel, ABSTRACTION_LEVELS, 'abstractionLevel');
      const targetScope = b.targetScope as MemoryScope;
      // Session landings arrive from the in-flow Transfer card (the decode
      // step may judge a rule as only serving the current conversation).
      // Board-initiated transfers never offer session.
      if (targetScope === 'session' && typeof b.targetSessionId !== 'string') {
        throw new RouteError(400, 'BAD_REQUEST', "targetScope 'session' requires targetSessionId");
      }
      if (targetScope === 'project' && typeof b.targetProjectId !== 'string') {
        throw new RouteError(400, 'BAD_REQUEST', "targetScope 'project' requires targetProjectId");
      }
      if (typeof b.content !== 'string' || !b.content.trim()) {
        throw new RouteError(400, 'BAD_REQUEST', 'content is required');
      }
      // Landing (REDESIGN, paper §4.5): how the transferred form meets the
      // target's EXISTING memories — the capture gate's routing vocabulary,
      // reused. "reinforces" bumps the existing equivalent instead of
      // duplicating it; "conflicts" keeps both, linked and flagged for
      // arbitration; "new"/absent is the plain path.
      const landingRoute =
        b.landingRoute === 'reinforces' || b.landingRoute === 'conflicts' ? b.landingRoute : 'new';
      const landingTarget =
        landingRoute !== 'new' && typeof b.landingTargetId === 'string'
          ? memory.store.getById(b.landingTargetId)
          : null;
      // Transcript cards bind a landing judgment to the exact target snapshot
      // used by Decode. Board resurfacing cannot replace that trusted verdict.
      if (b.landingTargetVersion !== undefined) {
        if (
          typeof b.landingTargetVersion !== 'number'
          || !Number.isInteger(b.landingTargetVersion)
          || b.landingTargetVersion < 1
        ) {
          throw new RouteError(400, 'BAD_REQUEST', 'landingTargetVersion must be a positive integer');
        }
        if (
          !landingTarget
          || landingTarget.status !== 'active'
          || landingTarget.version !== b.landingTargetVersion
        ) {
          throw new RouteError(409, 'CONFLICT', 'landing target changed or is no longer active; review Transfer again');
        }
      }
      // CAS: a landing verdict only binds to a still-active target; a raced
      // archive degrades to the plain path rather than failing the transfer.
      const landingBinds = Boolean(landingTarget && landingTarget.status === 'active');

      return await runDurableControlOperation({
        memory,
        attribution,
        surface,
        operationId: b.operationId,
        action: 'transfer',
        controlType: 'transfer',
        identity: `${boardResolution?.gateId ?? 'chat'}:${source.id}:v${source.version}:${targetScope}`,
        payload: { memoryId: source.id, targetScope },
        run: async () => {

      let archivedOriginal = false;
      const archiveOriginalIfAsked = () => {
        if (b.archiveOriginal === true && memory.store.getById(source.id)?.status === 'active') {
          memory.store.archive(source.id, UI_ACTOR);
          archivedOriginal = true;
        }
      };

      // The preview receipt badges what THIS turn's transfer stage landed —
      // including reinforce-merges, which otherwise leave no visible trace.
      const landingChatId = typeof b.chatId === 'string' ? b.chatId : undefined;

      if (landingRoute === 'reinforces' && landingBinds) {
        // No new item: the target context already knows this — the transfer
        // is a re-observation of the existing memory (evidence it holds
        // across projects), linked for provenance.
        memory.store.recordDerivedReinforce(landingTarget!.id, source.id, UI_ACTOR);
        if (landingChatId) memory.noteTransferLanding(landingChatId, landingTarget!.id);
        archiveOriginalIfAsked();
        memory.syncProjection(source.projectId);
        memory.syncProjection(landingTarget!.projectId);
        memory.logger.event({
          type: 'memory.transfer',
          ...attribution,
          sourceId: source.id,
          newId: landingTarget!.id,
          fromScope: source.scope,
          targetScope,
          targetProjectId: landingTarget!.projectId,
          verdict: typeof b.verdict === 'string' ? `${b.verdict}+reinforces` : 'reinforces',
          edited: b.edited === true,
          archivedOriginal,
          surface,
        });
        resolveBoardRow(services, boardResolution, { resultId: landingTarget!.id });
        return ok({ ...memory.store.getById(landingTarget!.id)!, relations: memory.store.getRelations(landingTarget!.id) });
      }

      const created = memory.store.createDerivedMemory(
        {
          content: (b.content as string).trim(),
          detail: typeof b.detail === 'string' && b.detail.trim() ? b.detail : undefined,
          abstractionLevel: (b.abstractionLevel as AbstractionLevel) ?? source.abstractionLevel,
          scope: targetScope,
          type: source.type,
          topic: source.topic,
          sensitive: source.sensitive,
          projectId: targetScope === 'project' ? (b.targetProjectId as string) : undefined,
          sessionId: targetScope === 'session' ? (b.targetSessionId as string) : undefined,
          provenanceSessionId: source.provenanceSessionId,
          provenanceTurn: source.provenanceTurn,
        },
        source.id,
        UI_ACTOR,
        landingRoute === 'conflicts' && landingBinds
          ? { conflictsWith: landingTarget!.id }
          : undefined,
      );
      if (landingChatId) memory.noteTransferLanding(landingChatId, created.id);
      if (landingRoute === 'conflicts' && landingBinds) {
        memory.logger.event({
          type: 'memory.conflict',
          newId: created.id,
          staleId: landingTarget!.id,
        });
      }
      archiveOriginalIfAsked();
      memory.syncProjection(source.projectId);
      memory.syncProjection(created.projectId);
      memory.logger.event({
        type: 'memory.transfer',
        ...attribution,
        sourceId: source.id,
        newId: created.id,
        fromScope: source.scope,
        targetScope,
        targetProjectId: created.projectId,
        verdict:
          landingRoute === 'conflicts' && landingBinds
            ? typeof b.verdict === 'string'
              ? `${b.verdict}+conflicts`
              : 'conflicts'
            : typeof b.verdict === 'string'
              ? b.verdict
              : undefined,
        edited: b.edited === true,
        archivedOriginal,
        surface,
      });
      // The middle representation rides the transferred item as metadata
      // (Transfer design 2026-08-08: shown on cards, never a standalone item).
      if (typeof b.rule === 'string' && b.rule.trim()) {
        memory.store.setKv(`transfer_rule:${created.id}`, {
          rule: b.rule.trim(),
          ...(typeof b.applicability === 'string' && b.applicability.trim()
            ? { applicability: b.applicability.trim() }
            : {}),
          sourceId: source.id,
        });
      }
      resolveBoardRow(services, boardResolution, { resultId: created.id });
      // getById doesn't hydrate relations — attach the links so the client can
      // render provenance (and any conflict) immediately.
      return ok({ ...memory.store.getById(created.id)!, relations: memory.store.getRelations(created.id) }, 201);
        },
      });
    }

    // POST /api/memories/:id/transfer-decline { contextKey } — "not this one"
    // on the Transfer card: the (source, destination-context) pair is never
    // suggested again. contextKey = the destination projectId (or sessionId
    // for projectless chats).
    const declineMatch = pathname.match(/^\/api\/memories\/([^/]+)\/transfer-decline$/);
    if (declineMatch && req.method === 'POST') {
      const id = decodeURIComponent(declineMatch[1]);
      const source = memory.store.getById(id);
      if (!source) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      const b = await readBody(req);
      const surface = controlSurface(b.surface);
      const attribution = studyInteractionAttribution(policy, services);
      const boardBase = boardResolutionBase(b, policy, services);
      const boardResolution: MemoryBoardTransferResolution | null = boardBase
        ? { ...boardBase, kind: 'transfer', sourceId: id }
        : null;
      assertString(b.contextKey, 'contextKey');
      const boardAdmission = assertPendingBoardTransfer(services, boardResolution);
      if (boardAdmission?.pending === false) return ok({ declined: true });
      if (
        boardAdmission?.pending === true
        && b.contextKey !== boardAdmission.trusted.destinationContextKey
      ) {
        throw new RouteError(409, 'BOARD_GATE_STALE', 'Board Transfer destination no longer matches the reviewed suggestion');
      }
      return await runDurableControlOperation({
        memory,
        attribution,
        surface,
        operationId: b.operationId,
        action: 'transfer_decline',
        controlType: 'transfer',
        identity: `${boardResolution?.gateId ?? 'chat'}:${id}:decline:${String(b.contextKey)}`,
        payload: { memoryId: id, contextKey: b.contextKey },
        run: () => {
          memory.store.setKv(`${TRANSFER_DECLINED_PREFIX}${id}:${b.contextKey as string}`, 'declined');
          memory.logger.event({ type: 'memory.transfer_decline', ...attribution, id, contextKey: b.contextKey as string, surface });
          resolveBoardRow(services, boardResolution);
          return ok({ declined: true });
        },
      });
    }

    // GET /api/memories/md-status — every projection file (personal + each
    // project); the Board's file picker reads this. The files are a generated
    // export of SQLite state — read-only, never ingested.
    if (pathname === '/api/memories/md-status') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      const projectIds = new Set([
        ...memory.store
          .list()
          .map((m) => m.projectId)
          .filter((id): id is string => Boolean(id)),
        ...memory.file.listProjectedProjects(),
      ]);
      return ok({
        files: [
          { scope: 'personal' as const, path: memory.file.personalPath() },
          ...[...projectIds].sort().map((id) => ({
            scope: 'project' as const,
            projectId: id,
            path: memory.file.projectPath(id),
          })),
        ],
      });
    }

    // GET /api/memories/md-file — read-only view of a projection file.
    if (pathname === '/api/memories/md-file') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      const project = url.searchParams.get('project') || undefined;
      try {
        if (project) {
          return ok({ path: memory.file.projectPath(project), content: memory.file.readProjectRaw(project) });
        }
        return ok({ path: memory.file.personalPath(), content: memory.file.readPersonalRaw() });
      } catch (e) {
        throw new RouteError(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'bad project id');
      }
    }

    // POST /api/memories/md-import { text, scope, projectId? } — ingest an
    // external CLAUDE.md/.cursorrules: every bullet line becomes a candidate.
    if (pathname === '/api/memories/md-import' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.text !== 'string' || !b.text.trim()) throw new RouteError(400, 'BAD_REQUEST', 'text is required');
      if (b.scope !== 'personal' && b.scope !== 'project') {
        throw new RouteError(400, 'BAD_REQUEST', "scope must be 'personal' or 'project'");
      }
      if (b.scope === 'project' && (typeof b.projectId !== 'string' || !b.projectId)) {
        throw new RouteError(400, 'BAD_REQUEST', 'projectId is required for project scope');
      }
      const sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      const result = memory.importMarkdown(
        b.text,
        b.scope === 'personal' ? { scope: 'personal' } : { scope: 'project', projectId: b.projectId as string },
        { ...UI_ACTOR, sessionId },
      );
      return ok(result);
    }

    // GET/PUT /api/memories/evolution-policy — delegating mode (F4's two
    // control styles): Ask parks every proposal for review; Auto applies
    // non-sensitive proposals immediately with an "auto" badge + revert.
    // The setting is a control act — switching it is itself study data.
    if (pathname === '/api/memories/evolution-policy') {
      const KV_KEY = 'evolution_policy';
      if (req.method === 'GET') {
        return ok({ mode: memory.store.getKv<{ mode?: string }>(KV_KEY)?.mode === 'auto' ? 'auto' : 'ask' });
      }
      if (req.method === 'PUT') {
        if (policy.capture !== 'review') {
          throw new RouteError(403, 'CONDITION_LOCKED', 'evolution policy only exists where proposals have a review lane');
        }
        const b = await readBody(req);
        if (b.mode !== 'ask' && b.mode !== 'auto') throw new RouteError(400, 'BAD_REQUEST', "mode must be 'ask' or 'auto'");
        memory.store.setKv(KV_KEY, { mode: b.mode });
        memory.logger.event({ type: 'memory.setting', section: 'evolution_policy', value: { mode: b.mode } });
        return ok({ mode: b.mode });
      }
      return fail(405, 'METHOD_NOT_ALLOWED', 'use GET or PUT');
    }

    // POST /api/memories/:id/restore-candidate — inverse of a non-sensitive
    // soft dismissal, used by the reopened Candidate gate. Authority comes
    // from the server-side discarded row + suppression record; a sensitive
    // dismissal has no row or text left to reconstruct.
    const restoreCandidateMatch = pathname.match(/^\/api\/memories\/([^/]+)\/restore-candidate$/);
    if (restoreCandidateMatch && req.method === 'POST') {
      const id = decodeURIComponent(restoreCandidateMatch[1]);
      const existing = memory.store.getById(id);
      if (!existing) {
        throw new RouteError(410, 'CANDIDATE_NOT_RECOVERABLE', 'This dismissed candidate was permanently removed and cannot be restored.');
      }
      const body = await readBody(req);
      const surface = controlSurface(body.surface);
      const via = surface ?? 'ui';
      const attribution = studyInteractionAttribution(policy, services);
      const restored = await runDurableControlOperation({
        memory,
        attribution,
        surface,
        operationId: body.operationId,
        action: 'restore',
        controlType: 'crud',
        identity: `memory:${id}:v${existing.version}:restore`,
        payload: { memoryId: id },
        run: () => {
          try {
            return memory.store.restoreDismissedCandidate(id, UI_ACTOR);
          } catch (error) {
            throw new RouteError(409, 'CANDIDATE_NOT_RECOVERABLE', error instanceof Error ? error.message : 'candidate restore failed');
          }
        },
      });
      memory.logger.event({
        type: 'memory.decision',
        ...attribution,
        action: 'restore',
        id,
        fromScope: existing.scope,
        toScope: restored.scope,
        via,
      });
      memory.syncProjection(restored.projectId);
      return ok(restored);
    }

    // POST /api/memories/:id/revert-auto — one-click inverse of an
    // auto-applied proposal: back to the review lane; a revision's archived
    // target comes back to life in the same transaction.
    const revertAutoMatch = pathname.match(/^\/api\/memories\/([^/]+)\/revert-auto$/);
    if (revertAutoMatch && req.method === 'POST') {
      const id = decodeURIComponent(revertAutoMatch[1]);
      if (!memory.store.getById(id)) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
      const b = await readBody(req);
      const clientSessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      const surface = controlSurface(b.surface);
      const via = surface ?? 'ui';
      const attribution = studyInteractionAttribution(policy, services);
      const sessionId = attribution.sessionId ?? clientSessionId;
      const current = memory.store.getById(id)!;
      const outcome = await runDurableControlOperation({
        memory,
        attribution,
        surface,
        operationId: b.operationId,
        action: 'revert',
        controlType: 'crud',
        identity: `memory:${id}:v${current.version}:revert-auto`,
        payload: { memoryId: id },
        run: () => {
          try {
            return memory.store.revertAutoAccept(id, { ...UI_ACTOR, sessionId });
          } catch (e) {
            if (e instanceof CandidateDismissalTransitionError) throw e;
            throw new RouteError(400, 'BAD_REQUEST', e instanceof Error ? e.message : 'revert failed');
          }
        },
      });
      memory.logger.event({ type: 'memory.decision', ...attribution, sessionId, action: 'revert', id, via });
      memory.syncProjection(outcome.reverted.projectId);
      return ok(outcome);
    }

    // POST /api/memories/ui-monitor — monitoring-act telemetry (board visits,
    // trace expansions, citation hovers…). Pure logging: exempt from the
    // mutation lock so every arm records whatever surfaces it has.
    if (pathname === '/api/memories/ui-monitor' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.surface !== 'string' || !b.surface) {
        throw new RouteError(400, 'BAD_REQUEST', 'surface is required');
      }
      const chatId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      const eventId = typeof b.eventId === 'string' && b.eventId.trim() ? b.eventId.trim() : undefined;
      memory.logger.event({
        type: 'ui.monitor',
        ...(eventId ? { eventId } : {}),
        ...(typeof b.clientTimestamp === 'string' ? { clientTimestamp: b.clientTimestamp } : {}),
        ...(chatId ? { chatId } : {}),
        surface: b.surface,
        interaction: b.interaction === 'open' || b.interaction === 'click' || b.interaction === 'scroll' || b.interaction === 'hover'
          ? b.interaction
          : undefined,
        ids: Array.isArray(b.ids) ? (b.ids as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
        sessionId: chatId,
      });
      return ok({});
    }

    // POST /api/memories/surface-exposure — one client-observed visibility
    // transition for a memory surface (board, record, audit rows…). Pure
    // logging like ui-monitor; the client outbox delivers these in every
    // deployment, study or not.
    if (pathname === '/api/memories/surface-exposure' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.surface !== 'string' || !b.surface) {
        throw new RouteError(400, 'BAD_REQUEST', 'surface is required');
      }
      const action = b.action;
      if (action !== 'opened' && action !== 'hidden' && action !== 'visible' && action !== 'closed') {
        throw new RouteError(400, 'BAD_REQUEST', 'action must be opened|hidden|visible|closed');
      }
      const chatId = typeof b.chatId === 'string' && b.chatId ? b.chatId : undefined;
      const payload = (typeof b.payload === 'object' && b.payload !== null && !Array.isArray(b.payload)
        ? b.payload
        : {}) as Record<string, unknown>;
      memory.logger.event({
        type: 'ui.surface_exposure',
        ...(typeof b.eventId === 'string' && b.eventId.trim() ? { eventId: b.eventId.trim() } : {}),
        ...(typeof b.clientTimestamp === 'string' ? { clientTimestamp: b.clientTimestamp } : {}),
        ...(chatId ? { chatId, sessionId: chatId } : {}),
        surface: b.surface,
        action,
        ...(typeof payload.exposureId === 'string' ? { exposureId: payload.exposureId } : {}),
        ...(typeof payload.sequence === 'number' ? { sequence: payload.sequence } : {}),
        ...(payload.initiator === 'participant' || payload.initiator === 'system' ? { initiator: payload.initiator } : {}),
        ...(Array.isArray(payload.memoryIds)
          ? { memoryIds: (payload.memoryIds as unknown[]).filter((x): x is string => typeof x === 'string') }
          : {}),
        ...(typeof payload.closeReason === 'string' ? { closeReason: payload.closeReason } : {}),
      });
      return ok({});
    }

    // Item: /api/memories/:id  (PATCH | DELETE)
    const idMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (req.method === 'PATCH') {
        // Read the request before inspecting status so the discarded guard and
        // the synchronous store update share one current-state critical path.
        const rawPatch = await readBody(req);
        const existing = memory.store.getById(id);
        if (!existing) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
        // Surface is useful telemetry, but it is client-controlled. During the
        // blocking opening Board the durable receipt remains the authority, so
        // F12 cannot claim chat_gate and raw-accept a sensitive draft.
        const requestedSurface = controlSurface(rawPatch.surface);
        const blockingBoardReview = requestedSurface === 'board' || services.blockingBoardReviewRequired?.() === true;
        const via = blockingBoardReview ? 'board' : requestedSurface ?? 'ui';
        const attribution = studyInteractionAttribution(policy, services);
        const { surface: _surface, operationId: _operationId, ...patch } = rawPatch;
        assertEnum(patch.scope, MEMORY_SCOPES, 'scope');
        assertEnum(patch.type, MEMORY_TYPES, 'type');
        assertEnum(patch.status, MEMORY_STATUSES, 'status');
        assertEnum(patch.abstractionLevel, ABSTRACTION_LEVELS, 'abstractionLevel');
        assertString(patch.content, 'content');
        assertString(patch.detail, 'detail');
        assertString(patch.projectId, 'projectId');
        assertString(patch.sessionId, 'sessionId');
        assertString(patch.topic, 'topic');
        assertNumber(patch.provenanceTurn, 'provenanceTurn');
        const nextScope = (patch.scope as MemoryScope) ?? existing.scope;
        const nextProjectId = (patch.projectId as string) ?? existing.projectId;
        if (nextScope === 'project' && !nextProjectId) {
          throw new RouteError(400, 'BAD_REQUEST', "scope 'project' requires projectId");
        }
        const nextSessionId = (patch.sessionId as string) ?? existing.sessionId;
        if (nextScope === 'session' && !nextSessionId) {
          throw new RouteError(400, 'BAD_REQUEST', "scope 'session' requires sessionId");
        }
        if (existing.status === 'candidate' && existing.sensitive && blockingBoardReview) {
          if (patch.sensitive !== undefined && patch.sensitive !== true) {
            throw new RouteError(
              409,
              'SENSITIVE_REVIEW_REQUIRED',
              'A sensitive Board candidate cannot be re-labelled to bypass review; edit, sanitize, or dismiss it.',
            );
          }
          const touchesReviewedDraft = Object.prototype.hasOwnProperty.call(patch, 'content')
            || Object.prototype.hasOwnProperty.call(patch, 'detail');
          if ((touchesReviewedDraft || patch.status !== undefined) && patch.status !== 'active') {
            throw new RouteError(
              409,
              'SENSITIVE_REVIEW_REQUIRED',
              'A sensitive Board candidate cannot be saved in stages. Submit reviewed Content, explicit Detail, and Accept in one action, or dismiss it.',
            );
          }
          if (patch.status === 'active') {
            const reviewedContent = typeof patch.content === 'string' ? patch.content.trim() : '';
            const hasExplicitDetail = Object.prototype.hasOwnProperty.call(patch, 'detail') && typeof patch.detail === 'string';
            const reviewedDetail = hasExplicitDetail ? (patch.detail as string).trim() : '';
            const contentChanged = reviewedContent !== existing.content.trim();
            if (!reviewedContent || !hasExplicitDetail || !contentChanged) {
              throw new RouteError(
                409,
                'SENSITIVE_REVIEW_REQUIRED',
                'Edit or prepare a sanitized version, then accept that reviewed content in the same action.',
              );
            }
            // Persist only normalized reviewed text. replaceCandidateDraft
            // erases the sensitive predecessor from the item event history.
            patch.content = reviewedContent;
            patch.detail = reviewedDetail;
          }
        }
        const accepted = existing.status === 'candidate' && (patch.status as string) === 'active';
        const controlAction = accepted ? 'accept' : nextScope !== existing.scope ? 'rescope' : 'edit';
        // Accepting a REVISION candidate replaces its target(s): activation
        // and the archival(s) commit in ONE transaction (a mid-way failure
        // must never leave both memories active with the candidate spent).
        // A MERGE proposal revises two originals and archives both.
        let updated!: MemoryItem;
        let replaced: MemoryItem[] = [];
        await runDurableControlOperation({
          memory,
          attribution,
          surface: requestedSurface,
          operationId: rawPatch.operationId,
          action: controlAction,
          controlType: 'crud',
          identity: `memory:${id}:v${existing.version}:${controlAction}`,
          payload: { memoryId: id, fromScope: existing.scope, toScope: nextScope },
          run: () => {
            if (existing.status === 'candidate') {
              if (accepted && existing.sensitive && blockingBoardReview) {
                const outcome = memory.store.acceptReviewedSensitiveCandidate(
                  id,
                  patch as Partial<MemoryItem> & { content: string; detail: string },
                  UI_ACTOR,
                );
                updated = outcome.updated;
                replaced = outcome.replaced;
              } else {
                const { status: nextStatus, ...draftPatch } = patch;
                updated = Object.keys(draftPatch).length > 0
                  ? memory.store.replaceCandidateDraft(id, draftPatch as Partial<MemoryItem>, UI_ACTOR)
                  : existing;
                if (nextStatus !== undefined) {
                  if (accepted && memory.store.revisionTargetOf(id)) {
                    const outcome = memory.store.acceptRevision(id, UI_ACTOR);
                    updated = outcome.updated;
                    replaced = outcome.replaced;
                  } else {
                    updated = memory.store.update(id, { status: nextStatus as MemoryStatus }, UI_ACTOR);
                  }
                }
              }
            } else {
              updated = memory.store.update(id, patch as Partial<MemoryItem>, UI_ACTOR);
            }
          },
        });
        // Decisions log BEFORE the projections they trigger — syncProjection
        // may ingest a dirty file and emit derived memory.propose events, and
        // the log's order must reflect causality (decision unblocks derived).
        for (const r of replaced) {
          memory.logger.event({
            type: 'memory.decision',
            ...attribution,
            action: 'archive',
            id: r.id,
            fromScope: r.scope,
            via: 'revision_accept',
          });
        }
        memory.logger.event({
          type: 'memory.decision',
          ...attribution,
          action: controlAction,
          id,
          fromScope: existing.scope,
          toScope: updated.scope,
          via,
        });
        for (const r of replaced) memory.syncProjection(r.projectId);
        memory.syncProjection(existing.projectId);
        if (updated.projectId !== existing.projectId) memory.syncProjection(updated.projectId);
        return ok(replaced.length > 0 ? { ...updated, replacedId: replaced[0]!.id } : updated);
      }
      if (req.method === 'DELETE') {
        const existing = memory.store.getById(id);
        if (!existing) throw new RouteError(404, 'NOT_FOUND', `memory not found: ${id}`);
        const surface = controlSurface(url.searchParams.get('surface') ?? undefined);
        const via = surface ?? 'ui';
        const attribution = studyInteractionAttribution(policy, services);
        const action = existing.status === 'candidate' ? 'dismiss' : 'archive';
        await runDurableControlOperation({
          memory,
          attribution,
          surface,
          operationId: url.searchParams.get('operationId') ?? undefined,
          action,
          controlType: 'crud',
          identity: `memory:${id}:v${existing.version}:${action}`,
          payload: { memoryId: id, fromScope: existing.scope },
          run: () => {
            if (existing.status === 'candidate') {
              // The store owns the privacy decision: a durable sensitive tombstone
              // still requires hard erasure even if a legacy row was relabelled.
              // Ordinary candidates remain soft-dismissed so the gate can learn
              // from them (self-evolution M1).
              memory.store.dismissCandidateByPolicy(id, UI_ACTOR);
            } else {
              memory.store.archive(id, UI_ACTOR);
            }
          },
        });
        memory.logger.event({
          type: 'memory.decision',
          ...attribution,
          action,
          id,
          fromScope: existing.scope,
          via,
        });
        // Candidates are projected too (Pending review section) — a dismissed
        // one must leave the file now, not at the next unrelated mutation.
        // After the decision event: projection may emit derived events.
        memory.syncProjection(existing.projectId);
        return ok({ id });
      }
      return fail(405, 'METHOD_NOT_ALLOWED', 'use PATCH or DELETE');
    }

    return fail(404, 'NOT_FOUND', `unknown memory route: ${pathname}`);
  } catch (e) {
    if (e instanceof RouteError) return fail(e.status, e.code, e.message);
    if (e instanceof CandidateDismissalTransitionError) return fail(409, e.code, e.message);
    console.error('[memory] route error', e);
    return fail(500, 'INTERNAL_ERROR', 'Internal server error');
  } finally {
    releaseStudyMutation?.();
  }
}
