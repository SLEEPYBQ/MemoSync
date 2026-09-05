// Client data layer for the memory HTTP API. Same-origin relative fetch (Vite
// proxies /api to the Bun backend in dev; one origin in prod). Envelope:
// success = { data }, error = { error: { code, message } } — matches
// src/server/memory/routes.ts. Types are imported type-only from the server
// module (erased at build; no server code enters the client bundle).
import type {
  AbstractionLevel,
  MemoryEvent,
  MemoryItem,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "../../server/memory/types"
import type { ExpectedMemoryUse } from "../../shared/types"
import type {
  MemoryBoardBacklogSnapshot,
  MemoryBoardOpeningPromptState,
} from "../../server/memory/board-backlog"
import { isStaticMemoryMarkdownPath } from "../../shared/staticMemoryPath"
import { enqueueStudyTelemetry } from "../app/study/studyTelemetry"
import { notifyIfUnauthorized } from "./authGuard"

export type { AbstractionLevel, MemoryEvent, MemoryItem, MemoryScope, MemoryStatus, MemoryType }

export interface SearchResultMemory {
  id: string
  content: string
  scope: MemoryScope
  type: MemoryType
  topic?: string
  usageCount: number
  score: number
}

export interface CreateMemoryBody {
  content: string
  detail?: string
  abstractionLevel?: AbstractionLevel
  scope: MemoryScope
  /** Optional — the server defaults manual creations to 'fact'. */
  type?: MemoryType
  status?: MemoryStatus
  projectId?: string
  sessionId?: string
  topic?: string
}

export type MemoryControlSurface = "board" | "chat_gate"

export interface MemoryBoardActionContext {
  taskId: string
  chatId: string
  gateId: string
}

export interface MemoryBoardCheckupActionContext extends MemoryBoardActionContext {
  suggestionKind: "conflict" | "redundancy" | "staleness"
  memoryId: string
  otherMemoryId?: string
}

/** GET /api/memories/:id/history response — the per-item version/usage log (option 乙). */
export interface MemoryHistory {
  memory: MemoryItem
  events: MemoryEvent[]
}

export interface MutedProposal {
  memoryId: string
  content: string | null
  dismissedAt: string
  canUnmute: boolean
}

export interface MemoryBoardPendingCounts {
  candidates: number
  transfers: number
  checkups: number
  total: number
}

export interface MemoryBoardReviewStatus {
  reviewed: boolean
  pending: MemoryBoardPendingCounts
  backlog: MemoryBoardBacklogSnapshot
  openingPrompt?: MemoryBoardOpeningPromptState
}

async function unwrap<T>(res: Response): Promise<T> {
  notifyIfUnauthorized(res)
  let payload: { data?: T; error?: { code: string; message: string } }
  try {
    payload = await res.json()
  } catch {
    throw new Error(`Request failed (${res.status})`)
  }
  if (!res.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed (${res.status})`)
  }
  return payload.data as T
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][]
  const s = new URLSearchParams(entries).toString()
  return s ? `?${s}` : ""
}

function controlOperationId(label: string): string {
  return `control:${label}:${crypto.randomUUID()}`
}

export const memoriesApi = {
  list: (params: { scope?: string; projectId?: string; sessionId?: string; status?: string } = {}) =>
    fetch(`/api/memories${qs(params)}`).then((r) => unwrap<MemoryItem[]>(r)),

  create: (body: CreateMemoryBody, options: { surface?: MemoryControlSurface } = {}) =>
    fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...options, operationId: controlOperationId("crud-create") }),
    }).then((r) => unwrap<MemoryItem>(r)),

  update: (id: string, patch: Partial<CreateMemoryBody>, options: { surface?: MemoryControlSurface } = {}) =>
    fetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, ...options, operationId: controlOperationId(`crud-update:${id}`) }),
    }).then((r) => unwrap<MemoryItem>(r)),

  remove: (id: string, options: { surface?: MemoryControlSurface } = {}) =>
    fetch(`/api/memories/${encodeURIComponent(id)}${qs({
      surface: options.surface,
      operationId: controlOperationId(`crud-remove:${id}`),
    })}`, { method: "DELETE" }).then((r) => unwrap<{ id: string }>(r)),

  search: (q: string, project?: string) =>
    fetch(`/api/memories/search${qs({ q, project })}`).then((r) =>
      unwrap<{ query: string; memories: SearchResultMemory[] }>(r),
    ),

  history: (id: string) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/history`).then((r) => unwrap<MemoryHistory>(r)),

  revert: (id: string, toSeq: number, surface?: MemoryControlSurface) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toSeq, surface, operationId: controlOperationId(`crud-revert:${id}:${toSeq}`) }),
    }).then((r) => unwrap<MemoryItem>(r)),

  /** GET /api/memories/needs-attention — conflicted memories for the Board (A1). */
  needsAttention: (projectId?: string) =>
    fetch(`/api/memories/needs-attention${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`).then((r) =>
      unwrap<{ items: Array<{ memory: MemoryItem; supersededBy: MemoryItem[] }> }>(r),
    ),

  boardReview: (taskId: string) =>
    fetch(`/api/memories/board-review?taskId=${encodeURIComponent(taskId)}`, { cache: "no-store" }).then((r) =>
      unwrap<MemoryBoardReviewStatus>(r),
    ),

  prepareBoardReview: (
    taskId: string,
    chatId: string,
    reviewId: string,
    content: string,
    attachments: unknown[],
    dispatch?: import("../../server/memory/board-backlog").MemoryBoardOpeningPromptInput["dispatch"],
  ) =>
    fetch("/api/memories/board-review/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, chatId, reviewId, content, attachments, dispatch }),
    }).then((r) => unwrap<MemoryBoardReviewStatus>(r)),

  resumeBoardReview: (taskId: string) =>
    fetch("/api/memories/board-review/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => unwrap<MemoryBoardReviewStatus>(r)),

  completeBoardReview: (taskId: string, chatId?: string, reviewId?: string) =>
    fetch("/api/memories/board-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, chatId, reviewId }),
    }).then((r) => unwrap<MemoryBoardReviewStatus>(r)),

  /** Renew/Archive on a gate attention row — validated + logged as an attention act. */
  resolveAttention: (
    kind: "conflict" | "redundant" | "stale",
    id: string,
    action: "keep" | "archive" | "merge",
    sessionId?: string,
    otherId?: string,
    surface?: MemoryControlSurface,
    boardResolution?: MemoryBoardCheckupActionContext,
  ) =>
    fetch(`/api/memories/attention-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        id,
        action,
        sessionId,
        otherId,
        surface,
        boardResolution,
        operationId: controlOperationId(`checkup:${kind}:${id}:${action}`),
      }),
    }).then((r) => unwrap<MemoryItem>(r)),

  /** Audit follow-up ①: queue this memory for next turn's injected list + reminder. */
  /** Enforce this next run (renamed from pay-attention, 2026-08-19 D1): locks
   * the memory into the next run with a hard order citing the evidence. */
  enforce: (id: string, sessionId: string, quote?: string) =>
    fetch("/api/memories/pay-attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, sessionId, quote, operationId: controlOperationId(`audit-enforce:${id}`) }),
    }).then((r) => unwrap<{ queued: string }>(r)),
  payAttention: (id: string, sessionId: string) =>
    fetch("/api/memories/pay-attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, sessionId }),
    }).then((r) => unwrap<{ queued: string }>(r)),

  /** Audit follow-up ②: draft a fix for a memory the audit blamed; parks for the next gate. */
  draftRevision: (id: string, sessionId?: string) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/draft-revision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, operationId: controlOperationId(`audit-draft-fix:${id}`) }),
    }).then((r) => unwrap<MemoryItem>(r)),

  /** "Ask agent to revise" on the Step 2 gate: NL adjustment of the injected set. */
  reviseInjection: (
    instruction: string,
    selectedIds: string[],
    poolIds: string[],
    sessionId?: string,
    previewId?: string,
  ) =>
    fetch("/api/memories/revise-injection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction,
        selectedIds,
        poolIds,
        ...(sessionId ? { sessionId } : {}),
        ...(previewId ? { previewId } : {}),
        operationId: controlOperationId("working-memory-ask"),
      }),
    }).then((r) => unwrap<{ selectedIds: string[]; reply: string }>(r)),

  /** Explain how each newly selected memory should guide this turn. */
  planInjectionUses: (
    task: string,
    selectedIds: string[],
    context: { sessionId?: string; previewId?: string } = {},
  ) =>
    fetch("/api/memories/plan-injection-uses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, selectedIds, ...context }),
    }).then((r) => unwrap<ExpectedMemoryUse[]>(r)),

  /** Memory files: every projection file (personal + each project) — a generated, read-only export. */
  mdStatus: () =>
    fetch("/api/memories/md-status").then((r) =>
      unwrap<{
        files: Array<{ scope: "personal" | "project"; projectId?: string; path: string }>
      }>(r),
    ),

  /** Raw text of one projection file — the in-app viewer reads this. */
  mdFile: (target: { scope: "personal" } | { scope: "project"; projectId: string }) =>
    fetch(
      `/api/memories/md-file${target.scope === "project" ? `?project=${encodeURIComponent(target.projectId)}` : ""}`,
    ).then((r) => unwrap<{ path: string; content: string }>(r)),

  /** Import an external CLAUDE.md/.cursorrules: every bullet line becomes a candidate. */
  mdImport: (text: string, scope: "personal" | "project", projectId?: string) =>
    fetch("/api/memories/md-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, scope, projectId }),
    }).then((r) => unwrap<{ created: string[]; skipped: number }>(r)),

  /** Delegating mode (F4): Ask parks proposals for review; Auto applies them with revert. */
  getEvolutionPolicy: () =>
    fetch("/api/memories/evolution-policy").then((r) => unwrap<{ mode: "ask" | "auto" }>(r)),

  setEvolutionPolicy: (mode: "ask" | "auto") =>
    fetch("/api/memories/evolution-policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then((r) => unwrap<{ mode: "ask" | "auto" }>(r)),

  /** One-click inverse of an auto-applied proposal: back to the review lane. */
  revertAutoAccept: (
    id: string,
    options: { sessionId?: string; surface?: MemoryControlSurface } = {},
  ) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/revert-auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, operationId: controlOperationId(`crud-revert-auto:${id}`) }),
    }).then((r) => unwrap<{ reverted: MemoryItem; restored: MemoryItem | null }>(r)),

  /** Restore one non-sensitive soft-dismissed Candidate inside a reopened review. */
  restoreCandidate: (id: string, options: { surface?: MemoryControlSurface } = {}) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/restore-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, operationId: controlOperationId(`crud-restore:${id}`) }),
    }).then((r) => unwrap<MemoryItem>(r)),

  /** Muted proposals; canUnmute is server-authoritative per dismissal. */
  listMuted: () =>
    fetch("/api/memories/muted").then((r) =>
      unwrap<{ items: MutedProposal[] }>(r),
    ),
  unmute: (memoryId: string) =>
    fetch(`/api/memories/muted/${encodeURIComponent(memoryId)}/unmute`, { method: "POST" }).then((r) =>
      unwrap<{ ok: boolean }>(r),
    ),

  /** Auto-arm summary panel (baseline B1): prose summary + conversation-only control. */
  getSummary: (projectId?: string) =>
    fetch(`/api/memories/summary${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`).then((r) =>
      unwrap<{ text: string; updatedAt: string; stale: boolean }>(r),
    ),

  refreshSummary: (projectId?: string) =>
    fetch(`/api/memories/summary/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    }).then((r) => unwrap<{ text: string; updatedAt: string; stale: boolean }>(r)),

  summaryChat: (message: string, projectId?: string, sessionId?: string) =>
    fetch(`/api/memories/summary/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: `prompt:auto-summary:${crypto.randomUUID()}`,
        message,
        projectId,
        sessionId,
      }),
    }).then((r) =>
      unwrap<{ reply: string; applied: number; summary: { text: string; updatedAt: string; stale: boolean } }>(r),
    ),

  /** Static-arm memory file (baseline B2): the workspace MEMORY.md, user+agent shared. */
  getMemoryFile: (projectId: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/memory-file`).then((r) =>
      unwrap<{ path: string; content: string; mtimeMs: number; exists: boolean }>(r),
    ),

  saveMemoryFile: (
    projectId: string,
    content: string,
    options: { baseMtimeMs?: number; sessionId?: string; editDurationMs?: number; eventId?: string } = {},
  ) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/memory-file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, ...options }),
    }).then((r) => unwrap<{ path: string; mtimeMs: number }>(r)),

  /** The session's muted ids (REDESIGN D7) — [] means everything active injects. */
  getSessionExclusions: (sessionId: string) =>
    fetch(`/api/memories/session-exclusions/${encodeURIComponent(sessionId)}`).then((r) =>
      unwrap<{ sessionId: string; ids: string[] }>(r),
    ),

  setSessionExclusions: (sessionId: string, ids: string[]) =>
    fetch(`/api/memories/session-exclusions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => unwrap<{ sessionId: string; ids: string[] }>(r)),

  /**
   * Redaction proposal for a sensitive candidate (DG1 "confirm" branch).
   * Fails loudly when the LLM is unavailable — the caller's fallback is
   * manual editing, never a fake "clean" proposal.
   */
  sanitizePreview: (id: string) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/sanitize-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) =>
      unwrap<{ content: string; detail?: string; redactions: Array<{ placeholder: string; kind: string }> }>(r),
    ),

  /** Cross-context transfer judgment (DG3): as_is / rewrite / context_bound + adapted form. */
  transferPreview: (id: string, body: TransferTargetBody) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/transfer-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<TransferProposal>(r)),

  /** Commit a transfer: creates a derived memory in the target context, linked derived_from. */
  transfer: (
    id: string,
    body: TransferTargetBody & {
      /** Transcript-card CAS; required for chat-gate and Board suggestions. */
      sourceVersion?: number
      content: string
      detail?: string
      abstractionLevel?: AbstractionLevel
      verdict?: TransferProposal["verdict"]
      edited?: boolean
      archiveOriginal?: boolean
      /** Landing decision against the target context (REDESIGN §4.5). */
      landingRoute?: TransferLandingRoute
      landingTargetId?: string
      /** Transcript landing CAS; required when the suggestion names a target. */
      landingTargetVersion?: number
      /** The chat whose turn accepted this — badges the preview receipt. */
      chatId?: string
      surface?: MemoryControlSurface
      boardResolution?: MemoryBoardActionContext
    },
  ) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, operationId: controlOperationId(`transfer:${id}`) }),
    }).then((r) => unwrap<MemoryItem>(r)),

  /** "Not this one" on the Transfer card — the (source, destination) pair is never suggested again. */
  transferDecline: (
    id: string,
    contextKey: string,
    surface?: MemoryControlSurface,
    boardResolution?: MemoryBoardActionContext,
  ) =>
    fetch(`/api/memories/${encodeURIComponent(id)}/transfer-decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contextKey,
        surface,
        boardResolution,
        operationId: controlOperationId(`transfer-decline:${id}`),
      }),
    }).then((r) => unwrap<{ declined: boolean }>(r)),
}

export interface TransferTargetBody {
  targetScope: "personal" | "project" | "session"
  targetProjectId?: string
  /** Required for a session landing (the in-flow Transfer card only). */
  targetSessionId?: string
  targetProjectTitle?: string
  sourceProjectTitle?: string
  /** The middle representation — stored as metadata on the transferred item. */
  rule?: string
  applicability?: string
}

export type TransferLandingRoute = "new" | "reinforces" | "conflicts"

export interface TransferLanding {
  route: TransferLandingRoute
  /** The target-context memory this landing relates to (reinforces/conflicts). */
  targetId?: string
  targetContent?: string
}

export interface TransferProposal {
  verdict: "as_is" | "rewrite" | "context_bound"
  /** The abstract rule — the context-free middle representation. */
  portable: string
  /** When the rule applies; absent = unconditional. */
  applicability?: string
  /** The form localized for the target context (editable). */
  content: string
  detail?: string
  abstractionLevel: AbstractionLevel
  note: string
  /** How the instantiated form meets the target's existing memories. */
  landing: TransferLanding
}

// Monitoring-act telemetry (metamemory mediator data): fire-and-forget, never
// blocks or surfaces errors — losing a beacon is better than jank.
// The guide tour renders the same components against fake data; it mutes the
// beacons wholesale so the study's monitoring metrics never count tour clicks.
let uiMonitorSuppressed = false
export function setUiMonitorSuppressed(suppressed: boolean): void {
  uiMonitorSuppressed = suppressed
}

export function isUiMonitorSuppressed(): boolean {
  return uiMonitorSuppressed
}

export function recordStaticMemoryEditEntered(operationId: string, sessionId: string | undefined, path: string): void {
  if (uiMonitorSuppressed || !isStaticMemoryMarkdownPath(path)) return
  enqueueStudyTelemetry({
    eventId: `${operationId}:entered`,
    endpoint: "/api/study/static-edit-entered",
    body: {
      operationId,
      clientTimestamp: new Date().toISOString(),
      ...(sessionId ? { chatId: sessionId } : {}),
      path,
    },
  })
}

export function recordWorkingMemorySelection(input: {
  chatId: string
  previewId: string
  memoryId: string
  action: "add" | "remove"
}): void {
  if (uiMonitorSuppressed) return
  const operationId = controlOperationId(`working-memory-selection:${input.action}:${input.memoryId}`)
  enqueueStudyTelemetry({
    eventId: operationId,
    endpoint: "/api/memories/working-memory-selection",
    body: { operationId, clientTimestamp: new Date().toISOString(), ...input },
  })
}

export function recordUiMonitor(
  surface: string,
  extra: { ids?: string[]; sessionId?: string; interaction?: "open" | "click" | "scroll" | "hover" } = {},
): void {
  if (uiMonitorSuppressed) return
  const eventId = `monitor:${crypto.randomUUID()}`
  enqueueStudyTelemetry({
    eventId,
    endpoint: "/api/memories/ui-monitor",
    body: {
      eventId,
      clientTimestamp: new Date().toISOString(),
      surface,
      ...extra,
    },
  })
}
