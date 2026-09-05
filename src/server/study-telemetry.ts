import type {
  StudyCondition,
  StudyMemoryStore,
  StudyTelemetryEvent,
  StudyTelemetryKind,
} from "./experiment/study-memory-store"
import type { ExperimentDurableSinkInput, ExperimentEvent } from "./experiment/logger"
import { isStaticMemoryMarkdownPath } from "../shared/staticMemoryPath"

export type StudyTelemetryWindowState = "open" | "freezing" | "frozen" | "complete"

export interface StudyTelemetryClientInput {
  eventId?: string
  clientTimestamp?: string
  kind: Extract<StudyTelemetryKind, "monitoring" | "control" | "stage_enter" | "surface_exposure">
  surface: string
  action: string
  chatId?: string
  payload?: Record<string, unknown>
  /** Required only for task-bound post-session stage entry; server validates it. */
  taskId?: string
}

export interface StudyTelemetryServiceOptions {
  store: StudyMemoryStore
  participantId: string
  condition: StudyCondition
  activeTask: () => { taskId: string; state: StudyTelemetryWindowState } | null
  now?: () => string
}

export interface StudyParticipantPromptInput {
  /** Server-owned task window captured at transcript append time. */
  taskId: string
  turnId: string
  chatId: string
  content: string
  attachments: unknown[]
  /** Whether content is exact participant text or a legacy transcript fallback. */
  contentSource?: "participant" | "legacy_transcript"
  /** Server timestamp attached to the durable transcript row. */
  acceptedAt?: string
}

const CLIENT_MONITORING_ALLOWLIST: Record<StudyCondition, Readonly<Record<string, readonly string[]>>> = {
  memosync: {
    board: ["open", "scroll", "hover"],
    board_visit: ["open"],
    board_enter_session: ["click"],
    timeline: ["open", "click", "scroll"],
    timeline_slot_jump: ["click"],
    timeline_quote_jump: ["click"],
    detail_open: ["open"],
    preview_pool_expand: ["click"],
    needs_attention_view: ["open"],
    citation_hover: ["hover"],
    trace_jump: ["click"],
    trace_expand: ["click"],
  },
  auto: {
    summary_panel_open: ["open"],
    summary_panel: ["click", "scroll"],
  },
  static: {
    static_memory_panel_open: ["open"],
    static_memory_panel: ["click", "scroll"],
  },
}

const CLIENT_SURFACE_EXPOSURE_ALLOWLIST: Record<StudyCondition, readonly string[]> = {
  memosync: ["memory_board", "memory_record", "audit_card", "audit_group", "citation_hover"],
  auto: ["auto_summary_sidebar"],
  static: ["static_memory_sidebar"],
}

const SURFACE_EXPOSURE_TRANSITIONS = ["opened", "hidden", "visible", "closed"] as const
type SurfaceExposureTransition = typeof SURFACE_EXPOSURE_TRANSITIONS[number]
const SURFACE_EXPOSURE_CLOSE_REASONS = [
  "unmount",
  "pagehide",
  "toggle",
  "dialog",
  "popover",
  "route_change",
] as const

const SERVER_EVENT_ID_PREFIXES = ["control-operation:", "server:", "prompt:", "stage:first:"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class StudyTelemetryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "StudyTelemetryError"
  }
}

function requiredText(value: unknown, name: string, maxLength = 160): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new StudyTelemetryError(`${name} is invalid`, 400)
  }
  return value
}

function canonicalIso(value: unknown, name: string): string {
  const text = requiredText(value, name, 64)
  const parsed = new Date(text)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new StudyTelemetryError(`${name} must be a canonical ISO timestamp`, 400)
  }
  return text
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
}

const MEMORY_UPDATE_PROMPT_RULE_VERSION = "2026-08-20-v2"

export function isExplicitMemoryUpdateRequest(content: string): boolean {
  const text = content.normalize("NFKC")
  if (/\b(?:do\s+not|don['’]?t|never)\s+(?:remember|forget|update|change|edit|add|save|remove|delete|revise)\b/i.test(text)) return false
  if (/(?:不要|别|无需|不用)(?:再)?(?:记住|忘记|更新|修改|编辑|添加|保存|删除|移除)/u.test(text)) return false
  if (/\b(?:what|whether|if)\b[\s\S]{0,24}\b(?:you\s+)?remember\b/i.test(text)) return false
  if (/(?:你|agent).{0,8}(?:记得|记住了)(?:什么|哪些|吗)/iu.test(text)) return false
  if (/\b(?:please\s+)?(?:remember|forget)\b[\s\S]{1,160}/i.test(text)) return true
  if (/(?:请|帮我|需要|要)?(?:记住|忘记).{1,80}/u.test(text)) return true
  const verb = "(?:update|change|edit|add|save|remove|delete|revise)"
  const memory = "(?:memory|memories|MEMORY\\.md)"
  if (new RegExp(`\\b${verb}\\b[\\s\\S]{0,64}\\b${memory}\\b`, "i").test(text)) return true
  if (new RegExp(`\\b${memory}\\b[\\s\\S]{0,64}\\b${verb}\\b`, "i").test(text)) return true
  return /(?:更新|修改|编辑|添加|保存|删除|移除).{0,24}(?:记忆|memory)|(?:记忆|memory).{0,24}(?:更新|修改|编辑|添加|保存|删除|移除)/iu.test(text)
}

/**
 * Deep module for participant interaction evidence. Callers supply only the
 * observed action. Study identity, lifecycle admission, timestamps and the
 * durable SQLite representation remain local to this implementation.
 */
export class StudyTelemetryService {
  private readonly now: () => string

  constructor(private readonly options: StudyTelemetryServiceOptions) {
    requiredText(options.participantId, "participantId", 200)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  private assertClientEventId(eventId: string): void {
    if (SERVER_EVENT_ID_PREFIXES.some((prefix) => eventId.startsWith(prefix))) {
      throw new StudyTelemetryError("eventId uses a server-owned namespace", 400)
    }
  }

  private assertMonitoringAllowed(surface: string, action: string): void {
    const actions = CLIENT_MONITORING_ALLOWLIST[this.options.condition][surface]
    if (!actions?.includes(action)) {
      throw new StudyTelemetryError(`Monitoring ${surface}/${action} is not available in this condition.`, 400)
    }
  }

  private resolveMonitoringTask(chatId: string | null, clientTimestamp: string | null): string {
    const active = this.options.activeTask()
    const boundTaskIds = chatId === null
      ? []
      : this.options.store.listStudyTelemetryTaskIdsForChat(chatId)
    if (boundTaskIds.length > 1) {
      throw new StudyTelemetryError("This chat has ambiguous durable study-task evidence.", 422)
    }
    const boundTaskId = boundTaskIds[0] ?? null
    if (boundTaskId === null) {
      if (!active || active.state !== "open") {
        throw new StudyTelemetryError("The Monitoring event has no durable open task binding.", 409)
      }
      const exposedAt = this.options.store.getStudySessionExposureAt(active.taskId)
      if (clientTimestamp !== null && exposedAt !== null && Date.parse(clientTimestamp) < Date.parse(exposedAt)) {
        throw new StudyTelemetryError("The Monitoring event falls outside the active server-observed task window.", 422)
      }
      return active.taskId
    }
    if (active?.taskId === boundTaskId && active.state === "open") return boundTaskId

    const frozen = this.options.store.getTaskFreezeSnapshot(boundTaskId)
    if (!frozen) {
      throw new StudyTelemetryError("The bound study task has not reached a durable freeze boundary.", 409)
    }
    const exposedAt = this.options.store.getStudySessionExposureAt(boundTaskId)
    if (exposedAt === null || clientTimestamp === null) {
      throw new StudyTelemetryError("Late Monitoring requires a complete server-observed task window.", 422)
    }
    const clientTime = Date.parse(clientTimestamp)
    if (clientTime < Date.parse(exposedAt) || clientTime > Date.parse(frozen.frozenAt)) {
      throw new StudyTelemetryError("Late Monitoring falls outside its server-observed task window.", 422)
    }
    return boundTaskId
  }

  /**
   * Bind delayed semantic Control evidence to an already observed chat/task
   * window. Unlike Monitoring's active-session fallback, a server logger event
   * cannot establish its own chat authority after the fact.
   */
  private resolveHistoricalControlTask(
    chatId: string | null,
    clientTimestamp: string | null,
    receivedAt: string,
    allowUnboundActive = false,
  ): string {
    if (chatId === null || clientTimestamp === null) {
      throw new StudyTelemetryError("Late Control requires chatId and clientTimestamp.", 422)
    }
    const boundTaskIds = this.options.store.listStudyTelemetryTaskIdsForChat(chatId)
    if (boundTaskIds.length === 0 && allowUnboundActive) {
      const active = this.options.activeTask()
      if (!active || active.state !== "open") {
        throw new StudyTelemetryError("Late Control has no durable chat/task binding.", 422)
      }
      const exposedAt = this.options.store.getStudySessionExposureAt(active.taskId)
      const clientAt = Date.parse(clientTimestamp)
      const openedAt = exposedAt === null ? Number.NaN : Date.parse(exposedAt)
      const closedAt = Date.parse(receivedAt)
      if (
        !Number.isFinite(clientAt)
        || !Number.isFinite(openedAt)
        || !Number.isFinite(closedAt)
        || clientAt < openedAt
        || clientAt > closedAt
      ) {
        throw new StudyTelemetryError("Late Control falls outside its active server-observed task window.", 422)
      }
      return active.taskId
    }
    if (boundTaskIds.length !== 1) {
      throw new StudyTelemetryError(
        boundTaskIds.length === 0
          ? "Late Control has no durable chat/task binding."
          : "Late Control has ambiguous durable chat/task evidence.",
        422,
      )
    }
    const taskId = boundTaskIds[0]!
    const exposedAt = this.options.store.getStudySessionExposureAt(taskId)
    if (exposedAt === null) {
      throw new StudyTelemetryError("Late Control has no durable task-window opening.", 422)
    }
    const clientAt = Date.parse(clientTimestamp)
    const openedAt = Date.parse(exposedAt)
    const active = this.options.activeTask()
    const freeze = this.options.store.getTaskFreezeSnapshot(taskId)
    const closedAt = freeze
      ? Date.parse(freeze.frozenAt)
      : active?.taskId === taskId && active.state === "open"
        ? Date.parse(receivedAt)
        : Number.NaN
    if (
      !Number.isFinite(clientAt)
      || !Number.isFinite(openedAt)
      || !Number.isFinite(closedAt)
      || clientAt < openedAt
      || clientAt > closedAt
    ) {
      throw new StudyTelemetryError("Late Control falls outside its durable chat/task window.", 422)
    }
    return taskId
  }

  private isHistoricalWorkingMemoryToggle(event: ExperimentEvent): boolean {
    if (
      event.type !== "study.control_operation"
      || event.surface !== "working_memory"
      || event.controlType !== "working_memory"
      || (event.action !== "add" && event.action !== "remove")
      || !event.operationId.startsWith("control:working-memory-selection:")
      || typeof event.chatId !== "string"
      || typeof event.clientTimestamp !== "string"
      || !isRecord(event.payload)
    ) return false
    return event.payload.chatId === event.chatId
      && event.payload.clientTimestamp === event.clientTimestamp
      && event.payload.outcome === "observed"
      && typeof event.payload.previewId === "string"
      && Boolean(event.payload.previewId)
      && typeof event.payload.memoryId === "string"
      && Boolean(event.payload.memoryId)
  }

  recordClient(raw: unknown): { created: boolean; event: StudyTelemetryEvent } {
    if (!isRecord(raw)) throw new StudyTelemetryError("Telemetry payload must be an object.", 400)
    const forbidden = ["participantId", "participant_id", "condition", "task_id", "sessionId", "recordedAt"]
      .find((key) => key in raw)
    if (forbidden) throw new StudyTelemetryError(`${forbidden} is assigned by the study server`, 400)
    const input = raw as unknown as StudyTelemetryClientInput
    const eventId = requiredText(input.eventId, "eventId", 200)
    this.assertClientEventId(eventId)
    if (input.kind === "stage_enter") return this.recordStageEntry(input)
    if ("taskId" in raw) throw new StudyTelemetryError("taskId is assigned by the study server", 400)
    const clientTimestamp = input.clientTimestamp === undefined
      ? null
      : canonicalIso(input.clientTimestamp, "clientTimestamp")
    const chatId = input.chatId === undefined ? null : requiredText(input.chatId, "chatId", 200)
    const surface = requiredText(input.surface, "surface")
    const action = requiredText(input.action, "action")
    const rawPayload = input.payload ?? {}
    if (!isRecord(rawPayload)) throw new StudyTelemetryError("payload must be an object", 400)
    if (input.kind === "surface_exposure") {
      return this.recordSurfaceExposure({
        eventId,
        clientTimestamp,
        chatId,
        surface,
        action,
        payload: rawPayload,
      })
    }
    if (input.kind === "control") {
      throw new StudyTelemetryError("Client telemetry cannot author Control evidence.", 400)
    }
    if (input.kind !== "monitoring") {
      throw new StudyTelemetryError("This telemetry kind is not admitted in an open session.", 400)
    }
    this.assertMonitoringAllowed(surface, action)
    const payloadKeys = Object.keys(rawPayload)
    if (payloadKeys.some((key) => key !== "memoryIds")) {
      throw new StudyTelemetryError("Monitoring payload accepts only memoryIds.", 400)
    }
    if (
      rawPayload.memoryIds !== undefined
      && (
        !Array.isArray(rawPayload.memoryIds)
        || rawPayload.memoryIds.length > 500
        || rawPayload.memoryIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)
      )
    ) {
      throw new StudyTelemetryError("Monitoring memoryIds are invalid.", 400)
    }
    const payload = rawPayload.memoryIds === undefined
      ? {}
      : { memoryIds: [...rawPayload.memoryIds as string[]] }
    const existing = this.options.store.getStudyTelemetryEvent(eventId)
    if (existing) {
      const incoming = { clientTimestamp, chatId, kind: input.kind, surface, action, payload }
      const stored = {
        clientTimestamp: existing.clientTimestamp,
        chatId: existing.chatId,
        kind: existing.kind,
        surface: existing.surface,
        action: existing.action,
        payload: existing.payload,
      }
      if (stableJson(incoming) !== stableJson(stored)) {
        throw new StudyTelemetryError("A telemetry event id was reused with different evidence.", 422)
      }
      return { created: false, event: existing }
    }
    const taskId = this.resolveMonitoringTask(chatId, clientTimestamp)
    const event: StudyTelemetryEvent = {
      eventId,
      recordedAt: canonicalIso(this.now(), "server timestamp"),
      clientTimestamp,
      participantId: this.options.participantId,
      taskId,
      sessionId: taskId,
      chatId,
      condition: this.options.condition,
      kind: input.kind,
      surface,
      action,
      payload,
    }
    return this.options.store.recordStudyTelemetryEvent(event)
  }

  private recordSurfaceExposure(input: {
    eventId: string
    clientTimestamp: string | null
    chatId: string | null
    surface: string
    action: string
    payload: Record<string, unknown>
  }): { created: boolean; event: StudyTelemetryEvent } {
    if (!CLIENT_SURFACE_EXPOSURE_ALLOWLIST[this.options.condition].includes(input.surface)) {
      throw new StudyTelemetryError(`Surface exposure ${input.surface} is not available in this condition.`, 400)
    }
    if (!input.chatId) throw new StudyTelemetryError("Surface exposure requires chatId.", 400)
    if (!input.clientTimestamp) throw new StudyTelemetryError("Surface exposure requires clientTimestamp.", 400)
    if (!SURFACE_EXPOSURE_TRANSITIONS.includes(input.action as SurfaceExposureTransition)) {
      throw new StudyTelemetryError("Surface exposure transition is invalid.", 400)
    }
    const transition = input.action as SurfaceExposureTransition
    const allowedKeys = new Set(["exposureId", "sequence", "initiator", "memoryIds", "closeReason"])
    if (Object.keys(input.payload).some((key) => !allowedKeys.has(key))) {
      throw new StudyTelemetryError("Surface exposure payload contains an unknown field.", 400)
    }
    const exposureId = requiredText(input.payload.exposureId, "exposureId", 160)
    const sequence = input.payload.sequence
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0 || (sequence as number) > 1_000_000) {
      throw new StudyTelemetryError("Surface exposure sequence is invalid.", 400)
    }
    const initiator = input.payload.initiator
    if (initiator !== "participant" && initiator !== "system") {
      throw new StudyTelemetryError("Surface exposure initiator is invalid.", 400)
    }
    const memoryIds = input.payload.memoryIds
    if (
      memoryIds !== undefined
      && (
        !Array.isArray(memoryIds)
        || memoryIds.length > 500
        || memoryIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)
        || new Set(memoryIds).size !== memoryIds.length
      )
    ) {
      throw new StudyTelemetryError("Surface exposure memoryIds are invalid.", 400)
    }
    const closeReason = input.payload.closeReason
    if (
      closeReason !== undefined
      && !SURFACE_EXPOSURE_CLOSE_REASONS.includes(closeReason as typeof SURFACE_EXPOSURE_CLOSE_REASONS[number])
    ) {
      throw new StudyTelemetryError("Surface exposure closeReason is invalid.", 400)
    }
    if ((transition === "closed") !== (closeReason !== undefined)) {
      throw new StudyTelemetryError("Surface exposure closeReason is required only for closed.", 400)
    }
    if (input.eventId !== `surface-exposure:${exposureId}:${sequence}`) {
      throw new StudyTelemetryError("Surface exposure eventId does not match its exposure and sequence.", 400)
    }
    const payload = {
      exposureId,
      sequence: sequence as number,
      initiator,
      ...(memoryIds === undefined ? {} : { memoryIds: [...memoryIds as string[]] }),
      ...(closeReason === undefined ? {} : { closeReason }),
    }
    const existing = this.options.store.getStudyTelemetryEvent(input.eventId)
    if (existing) {
      const incoming = {
        clientTimestamp: input.clientTimestamp,
        chatId: input.chatId,
        kind: "surface_exposure",
        surface: input.surface,
        action: transition,
        payload,
      }
      const stored = {
        clientTimestamp: existing.clientTimestamp,
        chatId: existing.chatId,
        kind: existing.kind,
        surface: existing.surface,
        action: existing.action,
        payload: existing.payload,
      }
      if (stableJson(incoming) !== stableJson(stored)) {
        throw new StudyTelemetryError("A telemetry event id was reused with different evidence.", 422)
      }
      return { created: false, event: existing }
    }

    const prior = this.options.store.listStudySurfaceExposureEvents(exposureId)
    let taskId: string
    if (sequence === 0) {
      if (transition !== "opened" || prior.length !== 0) {
        throw new StudyTelemetryError("A surface exposure must begin with sequence 0 opened.", 422)
      }
      taskId = this.resolveMonitoringTask(input.chatId, input.clientTimestamp)
    } else {
      if (prior.length !== sequence) {
        throw new StudyTelemetryError("Surface exposure sequence is not contiguous.", 422)
      }
      const first = prior[0]!
      const previous = prior[prior.length - 1]!
      const previousSequence = previous.payload.sequence
      const previousTime = previous.clientTimestamp ? Date.parse(previous.clientTimestamp) : Number.NaN
      const currentTime = Date.parse(input.clientTimestamp)
      const equalTimeInitialHidden = sequence === 1
        && previous.action === "opened"
        && transition === "hidden"
        && currentTime === previousTime
      if (
        first.surface !== input.surface
        || first.chatId !== input.chatId
        || first.payload.initiator !== initiator
        || stableJson(first.payload.memoryIds ?? []) !== stableJson(memoryIds ?? [])
        || previousSequence !== sequence - 1
        || previous.action === "closed"
        || !Number.isFinite(previousTime)
        || currentTime < previousTime
        || (currentTime === previousTime && !equalTimeInitialHidden)
      ) {
        throw new StudyTelemetryError("Surface exposure transition conflicts with its durable state.", 422)
      }
      const allowed = previous.action === "hidden"
        ? transition === "visible" || transition === "closed"
        : transition === "hidden" || transition === "closed"
      if (!allowed) throw new StudyTelemetryError("Surface exposure transition is out of order.", 422)
      if (!first.taskId) throw new StudyTelemetryError("Surface exposure opening has no durable task binding.", 422)
      taskId = first.taskId
    }
    return this.options.store.recordStudyTelemetryEvent({
      eventId: input.eventId,
      recordedAt: canonicalIso(this.now(), "server timestamp"),
      clientTimestamp: input.clientTimestamp,
      participantId: this.options.participantId,
      taskId,
      sessionId: taskId,
      chatId: input.chatId,
      condition: this.options.condition,
      kind: "surface_exposure",
      surface: input.surface,
      action: transition,
      payload,
    })
  }

  recordStaticEditEntered(raw: unknown): { created: boolean; event: StudyTelemetryEvent } {
    if (this.options.condition !== "static") {
      throw new StudyTelemetryError("Static edit entry is available only in the Static condition.", 404)
    }
    if (!isRecord(raw)) throw new StudyTelemetryError("Static edit entry must be an object.", 400)
    const operationId = requiredText(raw.operationId, "operationId", 200)
    if (!operationId.startsWith("control:static-edit:")) {
      throw new StudyTelemetryError("operationId is not a Static memory edit operation", 400)
    }
    const path = requiredText(raw.path, "path", 500)
    if (!isStaticMemoryMarkdownPath(path)) {
      throw new StudyTelemetryError("path is not a Static memory Markdown path", 422)
    }
    const chatId = requiredText(raw.chatId, "chatId", 200)
    const clientTimestamp = canonicalIso(raw.clientTimestamp, "clientTimestamp")
    const eventId = `${operationId}:entered`
    const existing = this.options.store.getStudyTelemetryEvent(eventId)
    if (existing) {
      const sameEvidence = existing.participantId === this.options.participantId
        && existing.condition === "static"
        && existing.chatId === chatId
        && existing.clientTimestamp === clientTimestamp
        && existing.kind === "stage_enter"
        && existing.surface === "static_memory"
        && existing.action === "edit_entered"
        && existing.payload.operationId === operationId
        && existing.payload.path === path
      if (!sameEvidence) {
        throw new StudyTelemetryError("A Static edit entry id was reused with different evidence.", 422)
      }
      return { created: false, event: existing }
    }
    const attempted = this.options.store.getStudyTelemetryEvent(`control-operation:${operationId}:attempted`)
    const recordedAt = canonicalIso(this.now(), "server timestamp")
    let taskId: string
    if (attempted) {
      const matchesOperation = attempted.participantId === this.options.participantId
        && attempted.condition === "static"
        && attempted.taskId !== null
        && attempted.sessionId === attempted.taskId
        && attempted.chatId === chatId
        && attempted.kind === "control"
        && attempted.surface === "static_memory"
        && attempted.action === "edit"
        && attempted.payload.operationId === operationId
        && attempted.payload.outcome === "attempted"
        && attempted.payload.controlType === "static_edit"
        && attempted.payload.path === path
      if (!matchesOperation) {
        throw new StudyTelemetryError("Static edit entry conflicts with its durable operation evidence.", 422)
      }
      taskId = attempted.taskId!
    } else {
      const active = this.options.activeTask()
      if (!active || active.state !== "open") {
        throw new StudyTelemetryError("Static edit entry has no durable attempted operation or open task.", 422)
      }
      const boundTaskIds = this.options.store.listStudyTelemetryTaskIdsForChat(chatId)
      if (boundTaskIds.length > 1 || (boundTaskIds.length === 1 && boundTaskIds[0] !== active.taskId)) {
        throw new StudyTelemetryError("Static edit entry has no durable attempted operation for its bound task.", 422)
      }
      taskId = active.taskId
    }
    return this.options.store.recordStudyTelemetryEvent({
      eventId,
      recordedAt,
      clientTimestamp,
      participantId: this.options.participantId,
      taskId,
      sessionId: taskId,
      chatId,
      condition: this.options.condition,
      kind: "stage_enter",
      surface: "static_memory",
      action: "edit_entered",
      payload: { operationId, path },
    })
  }

  recordServerStageEntered(
    stage: "information" | "session_exposure" | "memory_questionnaire" | "monitoring_tlx" | "control_tlx" | "sus",
    taskId?: string,
  ): { created: boolean; event: StudyTelemetryEvent } {
    return this.recordStageEntry({
      kind: "stage_enter",
      surface: "study",
      action: stage,
      ...(taskId ? { taskId } : {}),
    }, true)
  }

  recordServerEvent(input: ExperimentDurableSinkInput): { created: boolean; event: StudyTelemetryEvent } | void {
    if (input.condition !== this.options.condition) {
      throw new StudyTelemetryError("Experiment logger condition does not match the durable study allocation.", 500)
    }
    if (input.participant !== null && input.participant !== this.options.participantId) {
      throw new StudyTelemetryError("Experiment logger participant does not match the durable study allocation.", 500)
    }
    const mapped = this.mapServerEvent(input.event)
    if (!mapped) return
    if (input.event.type === "ui.monitor") {
      const eventId = requiredText(input.event.eventId, "eventId", 200)
      if (!eventId.startsWith("monitor:")) {
        throw new StudyTelemetryError("ui.monitor requires a monitor: eventId", 400)
      }
    }
    if (input.event.type === "study.participant_prompt") {
      const eventId = requiredText(input.event.eventId, "eventId", 200)
      if (!eventId.startsWith("prompt:auto-summary:")) {
        throw new StudyTelemetryError("Auto summary prompts require a prompt:auto-summary: eventId", 400)
      }
    }
    const lateBindableMonitoring = input.event.type === "ui.monitor"
    const historicalWorkingMemoryToggle = this.isHistoricalWorkingMemoryToggle(input.event)
    const claimedTaskId = !lateBindableMonitoring && "taskId" in input.event && typeof input.event.taskId === "string"
      ? input.event.taskId
      : null
    const chatId = "chatId" in input.event && typeof input.event.chatId === "string"
      ? input.event.chatId
      : "sessionId" in input.event && typeof input.event.sessionId === "string" && input.event.sessionId !== claimedTaskId
        ? input.event.sessionId
        : null
    const rawEvent = JSON.parse(JSON.stringify(input.event)) as Record<string, unknown>
    if (lateBindableMonitoring) {
      delete rawEvent.taskId
      if (chatId !== null) rawEvent.sessionId = chatId
    }
    const payload = {
      sourceEventType: input.event.type,
      ...mapped.payload,
      raw: rawEvent,
    }
    const clientTimestamp = "clientTimestamp" in input.event && typeof input.event.clientTimestamp === "string"
      ? canonicalIso(input.event.clientTimestamp, "clientTimestamp")
      : null
    const suppliedEventId = input.event.type === "study.control_operation"
      ? `control-operation:${requiredText(input.event.operationId, "operationId", 200)}:${input.event.phase}`
      : "eventId" in input.event && typeof input.event.eventId === "string"
        ? requiredText(input.event.eventId, "eventId", 200)
        : null
    let staticEntryTaskId: string | null = null
    if (
      input.event.type === "study.control_operation"
      && input.event.phase === "attempted"
      && input.event.controlType === "static_edit"
    ) {
      const entry = this.options.store.getStudyTelemetryEvent(`${input.event.operationId}:entered`)
      if (entry) {
        const path = isRecord(input.event.payload) ? input.event.payload.path : null
        const matchesEntry = entry.participantId === this.options.participantId
          && entry.condition === "static"
          && entry.taskId === input.event.taskId
          && entry.sessionId === input.event.sessionId
          && entry.chatId === (input.event.chatId ?? null)
          && entry.kind === "stage_enter"
          && entry.surface === input.event.surface
          && entry.action === "edit_entered"
          && entry.payload.operationId === input.event.operationId
          && entry.payload.path === path
          && input.event.surface === "static_memory"
          && input.event.action === "edit"
          && input.event.controlType === "static_edit"
        if (!matchesEntry) {
          throw new StudyTelemetryError("Static edit operation conflicts with its durable entry evidence.", 422)
        }
        staticEntryTaskId = entry.taskId
      }
    }
    let attemptedPhase: StudyTelemetryEvent | null = null
    if (input.event.type === "study.control_operation" && input.event.phase !== "attempted") {
      const operationId = requiredText(input.event.operationId, "operationId", 200)
      const attempted = this.options.store.getStudyTelemetryEvent(`control-operation:${operationId}:attempted`)
      if (!attempted) {
        throw new StudyTelemetryError(`Control operation ${operationId} has no durable attempted phase.`, 409)
      }
      const opposite = input.event.phase === "completed" ? "failed" : "completed"
      if (this.options.store.getStudyTelemetryEvent(`control-operation:${operationId}:${opposite}`)) {
        throw new StudyTelemetryError(`Control operation ${operationId} already has a terminal outcome.`, 409)
      }
      attemptedPhase = attempted
    }
    if (suppliedEventId) {
      const existing = this.options.store.getStudyTelemetryEvent(suppliedEventId)
      if (existing) {
        const incoming = {
          participantId: this.options.participantId,
          condition: this.options.condition,
          ...(claimedTaskId === null ? {} : { taskId: claimedTaskId, sessionId: claimedTaskId }),
          chatId,
          clientTimestamp,
          kind: mapped.kind,
          surface: mapped.surface,
          action: mapped.action,
          payload,
        }
        const stored = {
          participantId: existing.participantId,
          condition: existing.condition,
          ...(claimedTaskId === null ? {} : { taskId: existing.taskId, sessionId: existing.sessionId }),
          chatId: existing.chatId,
          clientTimestamp: existing.clientTimestamp,
          kind: existing.kind,
          surface: existing.surface,
          action: existing.action,
          payload: existing.payload,
        }
        if (stableJson(incoming) !== stableJson(stored)) {
          throw new StudyTelemetryError("A telemetry event id was reused with different evidence.", 422)
        }
        return { created: false, event: existing }
      }
    }
    const active = this.options.activeTask()
    const taskId = lateBindableMonitoring
      ? this.resolveMonitoringTask(chatId, clientTimestamp)
      : historicalWorkingMemoryToggle
        ? this.resolveHistoricalControlTask(chatId, clientTimestamp, canonicalIso(input.recordedAt, "server timestamp"))
      : staticEntryTaskId !== null
        ? staticEntryTaskId
      : active?.state === "open"
        ? active.taskId
        : null
    if (taskId === null) {
      throw new StudyTelemetryError("The current study session is not open for interaction telemetry.", 409)
    }
    if (claimedTaskId !== null && claimedTaskId !== taskId) {
      throw new StudyTelemetryError("Experiment event task does not match the active study window.", 409)
    }
    if (historicalWorkingMemoryToggle && attemptedPhase && input.event.type === "study.control_operation") {
      const samePhaseBinding = attemptedPhase.taskId === taskId
        && attemptedPhase.sessionId === taskId
        && attemptedPhase.chatId === chatId
        && attemptedPhase.clientTimestamp === clientTimestamp
        && attemptedPhase.surface === mapped.surface
        && attemptedPhase.action === mapped.action
        && attemptedPhase.payload.operationId === input.event.operationId
        && attemptedPhase.payload.controlType === input.event.controlType
        && attemptedPhase.payload.previewId === input.event.payload?.previewId
        && attemptedPhase.payload.memoryId === input.event.payload?.memoryId
      if (!samePhaseBinding) {
        throw new StudyTelemetryError("Working Memory Control phase evidence has inconsistent attribution.", 422)
      }
    }
    return this.options.store.recordStudyTelemetryEvent({
      eventId: suppliedEventId ?? `server:${crypto.randomUUID()}`,
      recordedAt: canonicalIso(input.recordedAt, "server timestamp"),
      clientTimestamp,
      participantId: this.options.participantId,
      taskId,
      sessionId: taskId,
      chatId,
      condition: this.options.condition,
      kind: mapped.kind,
      surface: mapped.surface,
      action: mapped.action,
      payload,
    })
  }

  private persistParticipantPrompt(
    input: StudyParticipantPromptInput,
    authority: "live" | "recovered_transcript",
  ): { created: boolean; event: StudyTelemetryEvent } {
    const taskId = requiredText(input.taskId, "taskId", 100)
    const chatId = requiredText(input.chatId, "chatId", 200)
    const turnId = requiredText(input.turnId, "turnId", 200)
    if (!Array.isArray(input.attachments)) throw new StudyTelemetryError("attachments must be an array", 400)
    if (typeof input.content !== "string" || input.content.length > 200_000) {
      throw new StudyTelemetryError("content is invalid", 400)
    }
    const content = input.content
    if (content.trim().length === 0 && input.attachments.length === 0) {
      throw new StudyTelemetryError("A participant prompt needs text or an attachment.", 400)
    }
    const contentSource = input.contentSource ?? "participant"
    if (contentSource !== "participant" && contentSource !== "legacy_transcript") {
      throw new StudyTelemetryError("contentSource is invalid", 400)
    }
    const acceptedAt = input.acceptedAt === undefined
      ? canonicalIso(this.now(), "server timestamp")
      : canonicalIso(input.acceptedAt, "acceptedAt")
    const eventId = `prompt:${this.options.participantId}:${taskId}:${chatId}:${turnId}`
    const memoryUpdateCandidate = (this.options.condition === "auto" || this.options.condition === "static")
      && isExplicitMemoryUpdateRequest(content)
    const payload = {
      turnId,
      content,
      contentSource,
      attachments: JSON.parse(JSON.stringify(input.attachments)) as unknown[],
      memoryUpdateCandidate: {
        matched: memoryUpdateCandidate,
        ruleVersion: MEMORY_UPDATE_PROMPT_RULE_VERSION,
        authority: "candidate_only",
      },
    }
    const existing = this.options.store.getStudyTelemetryEvent(eventId)
    if (existing) {
      const legacyComparable = { ...payload } as Record<string, unknown>
      delete legacyComparable.contentSource
      delete legacyComparable.turnId
      const samePayload = stableJson(existing.payload) === stableJson(payload)
        || (existing.payload.contentSource === undefined && stableJson(existing.payload) === stableJson(legacyComparable))
      const sameIdentity = existing.participantId === this.options.participantId
        && existing.taskId === taskId
        && existing.sessionId === taskId
        && existing.chatId === chatId
        && existing.kind === "participant_prompt"
        && existing.surface === "main_chat"
        && existing.action === "submit"
      if (!samePayload || !sameIdentity) {
        throw new StudyTelemetryError("A transcript turn id was reused with different participant prompt evidence.", 409)
      }
      return { created: false, event: existing }
    }
    if (authority === "live") {
      const active = this.options.activeTask()
      if (!active || active.state !== "open" || active.taskId !== taskId) {
        throw new StudyTelemetryError("The current study session is not open for a participant prompt.", 409)
      }
    } else {
      const exposedAt = this.options.store.getStudySessionExposureAt(taskId)
      const freeze = this.options.store.getTaskFreezeSnapshot(taskId)
      const active = this.options.activeTask()
      const windowEnd = freeze?.frozenAt
        ?? (active?.taskId === taskId && (active.state === "open" || active.state === "freezing")
          ? canonicalIso(this.now(), "server timestamp")
          : null)
      const acceptedAtMs = Date.parse(acceptedAt)
      const exposedAtMs = exposedAt === null ? Number.NaN : Date.parse(exposedAt)
      const windowEndMs = windowEnd === null ? Number.NaN : Date.parse(windowEnd)
      if (
        !Number.isFinite(acceptedAtMs)
        || !Number.isFinite(exposedAtMs)
        || !Number.isFinite(windowEndMs)
        || acceptedAtMs < exposedAtMs
        || acceptedAtMs > windowEndMs
      ) {
        throw new StudyTelemetryError("Recovered participant prompt falls outside its durable task window.", 422)
      }
    }
    return this.options.store.recordStudyTelemetryEvent({
      eventId,
      recordedAt: acceptedAt,
      clientTimestamp: null,
      participantId: this.options.participantId,
      taskId,
      sessionId: taskId,
      chatId,
      condition: this.options.condition,
      kind: "participant_prompt",
      surface: "main_chat",
      action: "submit",
      payload,
    })
  }

  recordParticipantPrompt(input: StudyParticipantPromptInput): { created: boolean; event: StudyTelemetryEvent } {
    return this.persistParticipantPrompt(input, "live")
  }

  /** Trusted repair seam for a transcript row admitted by the server reconciler. */
  recordRecoveredParticipantPrompt(input: StudyParticipantPromptInput): { created: boolean; event: StudyTelemetryEvent } {
    return this.persistParticipantPrompt(input, "recovered_transcript")
  }

  private mapServerEvent(event: ExperimentEvent): {
    kind: "monitoring" | "control" | "participant_prompt"
    surface: string
    action: string
    payload: Record<string, unknown>
  } | null {
    if (this.options.condition === "auto" && event.type === "study.participant_prompt") {
      const requestEventId = requiredText(event.eventId, "eventId", 200)
      return {
        kind: "participant_prompt",
        surface: event.surface,
        action: event.action,
        payload: {
          content: requiredText(event.content, "content", 200_000),
          projectId: requiredText(event.projectId, "projectId", 200),
          clientEventId: requestEventId,
        },
      }
    }
    if (event.type === "study.control_operation") {
      return {
        kind: "control",
        surface: event.surface,
        action: event.action,
        payload: {
          ...(event.payload ?? {}),
          operationId: event.operationId,
          outcome: event.phase,
          controlType: event.controlType,
          ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        },
      }
    }
    if (
      event.type === "ui.monitor"
      && (event.interaction === "open" || event.interaction === "click" || event.interaction === "scroll" || event.interaction === "hover")
    ) {
      this.assertMonitoringAllowed(event.surface, event.interaction)
      return {
        kind: "monitoring",
        surface: event.surface,
        action: event.interaction,
        payload: event.ids ? { memoryIds: [...event.ids] } : {},
      }
    }
    if (
      this.options.condition === "auto"
      && event.type === "memory.control_request"
      && event.via === "auto_summary_chat"
      && event.requestedAction === "update_memory"
    ) {
      return {
        kind: "control",
        surface: "auto_summary_chat",
        action: "update_memory",
        payload: {
          applied: event.applied ?? null,
          causalRequestId: event.causalRequestId ?? null,
        },
      }
    }
    if (this.options.condition === "static" && event.type === "memory.static_edit") {
      return {
        kind: "control",
        surface: "static_memory",
        action: "edit_submitted",
        payload: {
          operationId: event.eventId ?? null,
          projectId: event.projectId,
          path: event.path,
          durationMs: event.durationMs ?? null,
        },
      }
    }
    if (this.options.condition === "memosync" && event.type === "memory.interrupt") {
      return {
        kind: "control",
        surface: "inline_citation",
        action: "interrupt",
        payload: { memoryId: event.id, turn: event.turn ?? null, interruptId: event.interruptId ?? null },
      }
    }
    if (this.options.condition === "memosync" && event.type === "memory.resume") {
      return {
        kind: "control",
        surface: "interrupt_recovery",
        action: "resume",
        payload: { memoryId: event.id, interruptId: event.interruptId, enforced: event.enforced },
      }
    }
    if (this.options.condition === "memosync" && event.type === "memory.audit_action") {
      // Routes with phased `study.control_operation` evidence keep this
      // compatibility event in JSONL only. Mapping it again would count the
      // same participant action twice in the canonical durable ledger.
      if (event.operationId) return null
      return {
        kind: "control",
        surface: "audit",
        action: event.action,
        payload: { memoryId: event.id },
      }
    }
    if (
      this.options.condition === "memosync"
      && event.type === "memory.preview"
      && event.decision !== undefined
      && event.decision !== "auto_go_on"
      && event.decision !== "expired"
    ) {
      if (event.operationId) return null
      return {
        kind: "control",
        surface: "working_memory",
        action: event.decision,
        payload: {
          turn: event.turn ?? null,
          memoryIds: [...event.memoryIds],
          selectedIds: event.selectedIds ? [...event.selectedIds] : null,
        },
      }
    }
    if (this.options.condition === "memosync" && event.type === "memory.revise_injection") {
      if (event.operationId) return null
      return {
        kind: "control",
        surface: "working_memory",
        action: "ask_agent",
        payload: {
          instruction: event.instruction,
          beforeIds: [...event.beforeIds],
          afterIds: [...event.afterIds],
          changed: event.changed,
        },
      }
    }
    if (this.options.condition === "memosync" && event.type === "memory.preparation_reopen") {
      return {
        kind: "control",
        surface: "chat_gate",
        action: "review_again",
        payload: { from: event.from, revision: event.revision, turn: event.turn ?? null },
      }
    }
    return null
  }

  private recordStageEntry(
    input: StudyTelemetryClientInput,
    serverObserved = false,
  ): { created: boolean; event: StudyTelemetryEvent } {
    const stage = requiredText(input.action, "stage")
    const valid = ["information", "session_exposure", "memory_questionnaire", "monitoring_tlx", "control_tlx", "sus"]
    if (!valid.includes(stage)) {
      throw new StudyTelemetryError("This study stage is not supported.", 400)
    }
    const studyWide = stage === "information" || stage === "sus"
    const taskId = studyWide ? null : requiredText(input.taskId, "taskId", 100)
    const eventId = serverObserved
      ? `stage:first:${this.options.participantId}:${taskId ?? "study"}:${stage}`
      : requiredText(input.eventId, "eventId", 200)
    const existing = this.options.store.getStudyTelemetryEvent(eventId)
    if (existing) {
      const validExisting = existing.participantId === this.options.participantId
        && existing.condition === this.options.condition
        && existing.taskId === taskId
        && existing.sessionId === taskId
        && existing.chatId === null
        && existing.kind === "stage_enter"
        && existing.surface === "study"
        && existing.action === stage
        && stableJson(existing.payload) === stableJson({})
      if (!validExisting) {
        throw new StudyTelemetryError("A stage event id is already bound to different durable evidence.", 422)
      }
      return { created: false, event: existing }
    }
    const active = this.options.activeTask()
    if (stage === "information") {
      if (this.options.store.getSusSubmission()) {
        throw new StudyTelemetryError("The study is already complete.", 409)
      }
    } else if (stage === "sus") {
      if (active !== null || this.options.store.getSusSubmission()) {
        throw new StudyTelemetryError("The final usability questionnaire is not open.", 409)
      }
    } else if (stage === "session_exposure") {
      if (!active || active.taskId !== taskId || active.state !== "open") {
        throw new StudyTelemetryError("This study session exposure is not open for the active task.", 409)
      }
    } else {
      if (!active || active.taskId !== taskId || active.state !== "frozen") {
        throw new StudyTelemetryError("This post-session stage is not open for the active task.", 409)
      }
      const snapshot = this.options.store.getTaskFreezeSnapshot(taskId!)
      if (!snapshot) throw new StudyTelemetryError("The frozen session snapshot is unavailable.", 409)
      const questionnaire = this.options.store.getQuestionnaireSubmission(snapshot.snapshotId)
      const monitoring = this.options.store.getRawTlxSubmission(snapshot.snapshotId, "monitoring")
      const control = this.options.store.getRawTlxSubmission(snapshot.snapshotId, "control")
      if (stage === "memory_questionnaire" && questionnaire) {
        throw new StudyTelemetryError("The memory questionnaire is already submitted.", 409)
      }
      if (stage === "monitoring_tlx" && (!questionnaire || monitoring)) {
        throw new StudyTelemetryError("The Monitoring workload stage is not open.", 409)
      }
      if (stage === "control_tlx" && (!monitoring || control)) {
        throw new StudyTelemetryError("The Control workload stage is not open.", 409)
      }
    }
    return this.options.store.recordStudyTelemetryEvent({
      eventId,
      recordedAt: canonicalIso(this.now(), "server timestamp"),
      clientTimestamp: input.clientTimestamp === undefined
        ? null
        : canonicalIso(input.clientTimestamp, "clientTimestamp"),
      participantId: this.options.participantId,
      taskId,
      sessionId: taskId,
      chatId: null,
      condition: this.options.condition,
      kind: "stage_enter",
      surface: "study",
      action: stage,
      payload: {},
    })
  }
}
