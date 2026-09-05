import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StudyQuestionnaireAnswerV2 } from "../shared/studyTasks"
import type { ExperimentEvent } from "./experiment/logger"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import type { MemoryItem } from "./memory/types"
import { StudyQuestionnaireService, type PublicStudyQuestionnaire } from "./study-questionnaire-service"
import { StudySurveyService } from "./study-survey-service"
import { StudyOnboardingService } from "./study-onboarding"
import { handleStudyRequest, type StudyRouteDeps } from "./study-routes"
import { StudyRegistry } from "./study-registry"
import { guideReceiptKey } from "./study-ui-receipts"
import { StudyTelemetryError, StudyTelemetryService } from "./study-telemetry"

const TASK_ID = "038-S1"
const NEXT_TASK_ID = "038-S2"

let tempDir: string
let store: StudyMemoryStore
let registry: StudyRegistry
let questionnaire: StudyQuestionnaireService
let survey: StudySurveyService
let onboarding: StudyOnboardingService
let events: ExperimentEvent[]
let currentMemory: MemoryItem | null
let generatedIds: string[]
let clock: string[]

function memoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "M-01",
    content: "Use pnpm in every project.",
    scope: "personal",
    type: "preference",
    status: "active",
    abstractionLevel: "general",
    sensitive: false,
    usageCount: 0,
    reinforcedCount: 0,
    citedInCurrentSession: 0,
    version: 3,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T10:10:00.000Z",
    ...overrides,
  } as MemoryItem
}

function recordFocus(overrides: {
  injectionId?: string
  turn?: number
  version?: number
  content?: string
} = {}): void {
  const turn = overrides.turn ?? 1
  const version = overrides.version ?? 1
  store.recordFocusDelivery({
    injectionId: overrides.injectionId ?? `inj-${turn}`,
    taskId: TASK_ID,
    chatId: "chat-1",
    turnId: `turn-${turn}`,
    turn,
    focusedAt: `2026-08-15T10:0${turn}:00.000Z`,
    condition: "memosync",
    engine: "claude",
    mode: "skills",
    outcome: "delivered",
    deliveryStage: "queued_to_claude",
    deliveryHash: `delivery-${turn}`,
    visiblePoolHash: `pool-${turn}`,
    items: [{
      identity: { scheme: "store", id: "M-01" },
      version,
      content: overrides.content ?? "Use pnpm.",
      scope: "project",
      sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: version },
    }],
  })
}

function routeDeps(overrides: Partial<StudyRouteDeps> = {}): StudyRouteDeps {
  return {
    registry,
    questionnaire,
    survey,
    onboarding,
    uiReceipts: {
      has: (key) => key === guideReceiptKey(),
      record: () => undefined,
    },
    adminKey: "let-me-in",
    assignedProject: () => ({ projectId: "proj-apartment", starterReady: true }),
    ...overrides,
  }
}

function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  deps: StudyRouteDeps = routeDeps(),
): Promise<Response | null> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handleStudyRequest(request, new URL(request.url), deps)
}

async function responseData<T>(response: Response | null): Promise<T> {
  expect(response).not.toBeNull()
  const body = await response!.json() as { data: T }
  return body.data
}

type OnboardingResponse = {
  stage: "information" | "consent" | "briefing" | "complete"
  information?: {
    prolificId: string
    age: number
    gender: string
    agentMemoryExperience: string
    agentUseFrequency: string
    agentTools: string[]
  }
}

function completeAnswer(item: PublicStudyQuestionnaire["items"][number]): StudyQuestionnaireAnswerV2 {
  return {
    probeId: item.probeId,
    snapshotId: item.snapshotId,
    desired: {
      rating: 3,
      presence: "present",
      correctedContent: "Use pnpm for every install.",
      scope: "personal",
    },
    assessed: {
      rating: 2,
      presence: "present",
      believedContent: "The agent remembers pnpm only for this project.",
      scope: "project",
    },
    execution: 2,
  }
}

function attentionResponse(questionnaire: PublicStudyQuestionnaire) {
  const instructed = questionnaire.attentionCheck.options.find((option) =>
    questionnaire.attentionCheck.prompt.includes(`select ${option.label}.`)
  )
  if (!instructed) throw new Error("test questionnaire has no instructed attention-check option")
  return {
    checkId: questionnaire.attentionCheck.checkId,
    selectedValue: instructed.value,
  }
}

describe("study routes with StudyQuestionnaireService", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "memosync-study-routes-"))
    store = new StudyMemoryStore(join(tempDir, "study.sqlite"))
    registry = new StudyRegistry(undefined, [TASK_ID, NEXT_TASK_ID])
    events = []
    currentMemory = memoryItem()
    generatedIds = ["snapshot-1", "submission-1", "generated-3"]
    clock = ["2026-08-15T10:15:00.000Z", "2026-08-15T10:20:00.000Z"]
    questionnaire = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: (event) => events.push(event) },
      memoryStore: { getById: () => currentMemory },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      getChatInfo: (chatId) => chatId === "chat-1"
        ? { title: "Apartment site", projectId: "proj-apartment" }
        : undefined,
      now: () => clock.shift() ?? "2026-08-15T10:30:00.000Z",
      randomId: () => generatedIds.shift() ?? "generated-fallback",
    })
    let surveyId = 0
    survey = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: (event) => events.push(event) },
      now: () => "2026-08-15T10:25:00.000Z",
      randomId: () => `survey-${++surveyId}`,
      nextSessionPreparer: null,
    })
    onboarding = new StudyOnboardingService({
      store,
      allocationParticipantId: "P-017",
      now: () => "2026-08-19T10:00:00.000Z",
    })
    onboarding.saveInformation({
      prolificId: "60baf0123456789abcdef0123",
      age: 29,
      gender: "Woman",
      agentMemoryExperience: "Occasional",
      agentUseFrequency: "Weekly",
      agentTools: ["Claude Code"],
    })
    onboarding.recordConsent()
    onboarding.recordBriefing()
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("the active brief names the one persistent project assigned to both sessions", async () => {
    const first = await responseData<{
      id: string
      projectSlug: string
      projectTitle: string
      projectId: string | null
      starterReady: boolean
    }>(await call("GET", "/api/study/task/038-S1"))

    expect(first).toMatchObject({
      id: "038-S1",
      projectSlug: "apartment",
      projectTitle: "Apartment rentals",
      projectId: "proj-apartment",
      starterReady: true,
    })

    registry.noteSessionComplete(TASK_ID, "2026-08-15T10:10:00.000Z")
    const second = await responseData<{
      id: string
      projectSlug: string
      projectTitle: string
      projectId: string | null
      starterReady: boolean
    }>(await call("GET", "/api/study/task/038-S2"))
    expect(second).toMatchObject({
      id: "038-S2",
      projectSlug: "apartment",
      projectTitle: "Apartment rentals",
      projectId: "proj-apartment",
      starterReady: true,
    })
  })

  test("records server-observed session and questionnaire exposure before returning their GET payloads", async () => {
    const times = ["2026-08-20T09:00:00.000Z", "2026-08-20T09:10:00.000Z"]
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "memosync",
      activeTask: () => {
        const taskId = registry.activeTaskId()
        if (!taskId) return null
        const state = registry.freezeState(taskId)
        return state ? { taskId, state } : null
      },
      now: () => times.shift()!,
    })
    const deps = routeDeps({ telemetry })

    expect((await call("GET", `/api/study/task/${TASK_ID}`, undefined, {}, deps))!.status).toBe(200)
    recordFocus()
    await questionnaire.freeze(TASK_ID)
    expect((await call("GET", `/api/study/questionnaire?taskId=${TASK_ID}`, undefined, {}, deps))!.status).toBe(200)

    expect(store.listStudyTelemetryEvents().map(({ action, recordedAt }) => ({ action, recordedAt }))).toEqual([
      { action: "session_exposure", recordedAt: "2026-08-20T09:00:00.000Z" },
      { action: "memory_questionnaire", recordedAt: "2026-08-20T09:10:00.000Z" },
    ])
  })

  test("stores resumable onboarding under the server-owned allocation and gates study routes until briefing and Guide completion", async () => {
    const intakeStore = new StudyMemoryStore(join(tempDir, "onboarding.sqlite"))
    const fresh = new StudyOnboardingService({
      store: intakeStore,
      allocationParticipantId: "P-017",
      now: () => "2026-08-19T11:00:00.000Z",
    })
    const receipts = new Set<string>()
    const deps = routeDeps({
      onboarding: fresh,
      uiReceipts: { has: (key) => receipts.has(key), record: (key) => receipts.add(key) },
    })
    const information = {
      prolificId: "  60baf0123456789abcdef0123  ",
      age: 29,
      gender: "Woman",
      agentMemoryExperience: "Occasional",
      agentUseFrequency: "Weekly",
      agentTools: ["Claude Code", "Codex"],
    }

    expect(await responseData<OnboardingResponse>(await call("GET", "/api/study/onboarding", undefined, {}, deps))).toEqual({ stage: "information" })
    const lockedSessionRequests: Array<[string, string, unknown?]> = [
      ["GET", "/api/study/progress"],
      ["GET", "/api/study/task/038-S1"],
      ["POST", "/api/study/task/038-S1/acknowledge", {}],
      ["POST", "/api/study/freeze", { taskId: "038-S1" }],
      ["GET", "/api/study/questionnaire?taskId=038-S1"],
      ["POST", "/api/study/quiz", { taskId: "038-S1", snapshotId: "fabricated", answers: [] }],
      ["GET", "/api/study/post-session?taskId=038-S1"],
      ["POST", "/api/study/raw-tlx", { taskId: "038-S1", snapshotId: "fabricated", response: {} }],
      ["POST", "/api/study/sus", { taskId: "038-S1", response: {} }],
    ]
    for (const [method, path, body] of lockedSessionRequests) {
      expect((await call(method, path, body, {}, deps))!.status).toBe(409)
    }
    expect((await call("POST", "/api/study/onboarding/consent", { consented: true }, {}, deps))!.status).toBe(409)
    expect((await call("PUT", "/api/study/onboarding/information", { ...information, participantId: "P-018" }, {}, deps))!.status).toBe(400)
    expect(await responseData<OnboardingResponse>(await call("PUT", "/api/study/onboarding/information", information, {}, deps))).toEqual({
      stage: "consent",
      information: { ...information, prolificId: "60baf0123456789abcdef0123" },
    })
    expect((await call("POST", "/api/study/onboarding/consent", { consented: false }, {}, deps))!.status).toBe(400)
    expect(await responseData<OnboardingResponse>(await call("POST", "/api/study/onboarding/consent", { consented: true }, {}, deps))).toEqual({
      stage: "briefing",
      information: { ...information, prolificId: "60baf0123456789abcdef0123" },
    })
    expect((await call("POST", "/api/study/guide-complete", {}, {}, deps))!.status).toBe(409)
    expect(await responseData<OnboardingResponse>(await call("POST", "/api/study/onboarding/briefing", {}, {}, deps))).toEqual({
      stage: "complete",
      information: { ...information, prolificId: "60baf0123456789abcdef0123" },
    })
    expect((await call("GET", "/api/study/progress", undefined, {}, deps))!.status).toBe(409)
    expect(await responseData(await call("POST", "/api/study/guide-complete", {}, {}, deps))).toMatchObject({ completed: true })
    expect((await call("GET", "/api/study/progress", undefined, {}, deps))!.status).toBe(200)
    expect((await call("PUT", "/api/study/onboarding/information", { ...information, age: 30 }, {}, deps))!.status).toBe(409)
    expect(await responseData<OnboardingResponse>(await call("PUT", "/api/study/onboarding/information", information, {}, deps))).toMatchObject({ stage: "complete" })
  })

  test("reports the assigned starter as unavailable when boot readiness is not proven", async () => {
    const task = await responseData<{ starterReady: boolean }>(await call(
      "GET",
      "/api/study/task/038-S1",
      undefined,
      {},
      routeDeps({ assignedProject: () => ({ projectId: "proj-apartment", starterReady: false }) }),
    ))
    expect(task.starterReady).toBe(false)
  })

  test("records only whitelisted UI copy attempts under the server-derived active task", async () => {
    const attempts: unknown[] = []
    const accepted = await call(
      "POST",
      "/api/study/instruction-guard-event",
      { taskId: "098-S2", action: "keyboard_copy", surface: "task_page" },
      {},
      routeDeps({ instructionGuard: { recordUiAttempt: (attempt) => attempts.push(attempt) } }),
    )
    expect(accepted!.status).toBe(200)
    expect(attempts).toEqual([{
      taskId: "038-S1",
      action: "keyboard_copy",
      surface: "task_page",
    }])

    const invalid = await call(
      "POST",
      "/api/study/instruction-guard-event",
      { action: "read_dom", surface: "task_page" },
      {},
      routeDeps({ instructionGuard: { recordUiAttempt: (attempt) => attempts.push(attempt) } }),
    )
    expect(invalid!.status).toBe(400)
    expect(attempts).toHaveLength(1)
  })

  test("accepts durable telemetry without trusting browser study identity", async () => {
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "static",
      activeTask: () => ({ taskId: registry.activeTaskId()!, state: "open" }),
      now: () => "2026-08-20T10:00:00.000Z",
    })
    const deps = {
      ...routeDeps(),
      telemetry,
    } as StudyRouteDeps & { telemetry: StudyTelemetryService }
    const accepted = await call("POST", "/api/study/telemetry", {
      eventId: "static-scroll-1",
      kind: "monitoring",
      surface: "static_memory_panel",
      action: "scroll",
      chatId: "chat-1",
      participantId: "forged-participant",
      condition: "memosync",
      taskId: "098-S2",
    }, {}, deps)

    expect(accepted!.status).toBe(400)
    expect(store.listStudyTelemetryEvents()).toEqual([])

    telemetry.recordServerStageEntered("session_exposure", "038-S1")

    const stored = await call("POST", "/api/study/telemetry", {
      eventId: "static-scroll-1",
      kind: "monitoring",
      surface: "static_memory_panel",
      action: "scroll",
      chatId: "chat-1",
    }, {}, deps)
    expect(stored!.status).toBe(200)
    expect(store.listStudyTelemetryEvents().find((event) => event.eventId === "static-scroll-1")).toMatchObject({
      participantId: "P-017",
      condition: "static",
      taskId: "038-S1",
      sessionId: "038-S1",
    })

    const entered = await call("POST", "/api/study/static-edit-entered", {
      operationId: "control:static-edit:route-1",
      path: "MEMORY.md",
      chatId: "chat-1",
      clientTimestamp: "2026-08-20T10:00:00.000Z",
    }, {}, deps)
    expect(entered!.status).toBe(200)
    expect(store.listStudyTelemetryEvents().find((event) => event.eventId === "control:static-edit:route-1:entered")).toMatchObject({
      kind: "stage_enter",
      surface: "static_memory",
      action: "edit_entered",
      payload: { operationId: "control:static-edit:route-1", path: "MEMORY.md" },
    })
  })

  test("rejects Monitoring payloads that masquerade as phased Control operations", async () => {
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "memosync",
      activeTask: () => ({ taskId: registry.activeTaskId()!, state: "open" }),
    })
    const deps = routeDeps({ telemetry })

    for (const outcome of ["attempted", "completed"] as const) {
      const response = await call("POST", "/api/study/telemetry", {
        eventId: `forged-board-${outcome}`,
        kind: "monitoring",
        surface: "board",
        action: "scroll",
        payload: {
          operationId: "forged-control-operation",
          outcome,
          controlType: "crud",
        },
      }, {}, deps)
      expect(response!.status).toBe(400)
    }
    expect(store.listStudyTelemetryEvents()).toEqual([])
  })

  test("stores guide completion and per-task brief acknowledgement in server-side study state", async () => {
    // A materially older tutorial must never satisfy the redesigned Guide.
    // Existing participants and QA runs need to see the new interaction model.
    const receipts = new Set<string>(["guide:2026-08-19-v6"])
    const deps = routeDeps({
      onboarding,
      uiReceipts: {
        has: (key) => receipts.has(key),
        record: (key) => receipts.add(key),
      },
    })

    expect(await responseData<{ version: string; completed: boolean }>(
      await call("GET", "/api/study/guide-status", undefined, {}, deps),
    )).toEqual({ version: "2026-08-22-v10", completed: false })
    await call("POST", "/api/study/guide-complete", {}, {}, deps)
    expect(await responseData<{ completed: boolean }>(
      await call("GET", "/api/study/guide-status", undefined, {}, deps),
    )).toMatchObject({ completed: true })

    const before = await responseData<{ briefAcknowledged: boolean }>(
      await call("GET", "/api/study/task/038-S1", undefined, {}, deps),
    )
    expect(before.briefAcknowledged).toBe(false)
    await call("POST", "/api/study/task/038-S1/acknowledge", {}, {}, deps)
    const after = await responseData<{ briefAcknowledged: boolean }>(
      await call("GET", "/api/study/task/038-S1", undefined, {}, deps),
    )
    expect(after.briefAcknowledged).toBe(true)
  })

  test("freeze and GET expose the same immutable public snapshot", async () => {
    recordFocus()

    const freezeResponse = await call("POST", "/api/study/freeze", { taskId: TASK_ID })
    expect(freezeResponse!.status).toBe(200)
    const frozen = await responseData<PublicStudyQuestionnaire>(freezeResponse)
    expect(frozen).toEqual({
      snapshotId: "snapshot-1",
      taskId: TASK_ID,
      frozenAt: "2026-08-15T10:15:00.000Z",
      questionnaireVersion: 2,
      attentionCheck: {
        checkId: "attention-038-s1",
        prompt: "This is an attention check. To show that you are reading carefully, select Option B.",
        options: [
          { value: "option_a", label: "Option A" },
          { value: "option_b", label: "Option B" },
          { value: "option_c", label: "Option C" },
          { value: "option_d", label: "Option D" },
        ],
      },
      submitted: false,
      items: [{
        probeId: expect.any(String),
        snapshotId: "snapshot-1",
        cue: "Use pnpm.",
      }],
    })
    expect(Object.keys(frozen.items[0]!)).toEqual(["probeId", "snapshotId", "cue"])

    currentMemory = memoryItem({ content: "Changed after freeze.", version: 99 })
    recordFocus({ injectionId: "inj-after-freeze", turn: 2, version: 99, content: "Changed cue." })

    const loaded = await responseData<PublicStudyQuestionnaire>(
      await call("GET", `/api/study/questionnaire?taskId=${TASK_ID}`),
    )
    const compatibilityAlias = await responseData<PublicStudyQuestionnaire>(
      await call("GET", `/api/study/injected?taskId=${TASK_ID}`),
    )
    const retriedFreeze = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    expect(loaded).toEqual(frozen)
    expect(compatibilityAlias).toEqual(frozen)
    expect(retriedFreeze).toEqual(frozen)
    expect(store.getTaskFreezeSnapshot(TASK_ID)!.items[0]).toMatchObject({
      cue: { content: "Use pnpm." },
      object: { content: "Use pnpm in every project.", version: 3 },
      history: [{ injectionId: "inj-1" }],
    })
  })

  test("a direct freeze POST records questionnaire entry before exposing the questionnaire", async () => {
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "memosync",
      activeTask: () => {
        const taskId = registry.activeTaskId()
        if (!taskId) return null
        const state = registry.freezeState(taskId)
        return state ? { taskId, state } : null
      },
      now: () => "2026-08-20T11:00:00.000Z",
    })
    recordFocus()

    const frozen = await call(
      "POST",
      "/api/study/freeze",
      { taskId: TASK_ID },
      {},
      routeDeps({ telemetry }),
    )

    expect(frozen!.status).toBe(200)
    expect(store.listStudyTelemetryEvents().map(({ action }) => action)).toEqual(["memory_questionnaire"])
  })

  test("submits complete canonical answers without advancing before workload", async () => {
    recordFocus()
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    const answer = completeAnswer(frozen.items[0]!)

    const submitResponse = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [answer],
      attentionCheck: attentionResponse(frozen),
    })

    expect(submitResponse!.status).toBe(200)
    expect(await responseData<{ recorded: number; created: boolean; submissionId: string }>(submitResponse)).toEqual({
      recorded: 1,
      created: true,
      submissionId: "submission-1",
    })
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)?.answers).toEqual([answer])
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)?.questionnaireVersion).toBe(2)
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)?.attentionCheck).toEqual({
      ...attentionResponse(frozen),
      passed: true,
    })
    expect(registry.taskStatus(TASK_ID)).toBe("active")
    expect(registry.taskStatus(NEXT_TASK_ID)).toBe("locked")
    expect(events.find((event) => event.type === "quiz.answer")).toMatchObject({
      type: "quiz.answer",
      schemaVersion: 2,
      questionnaireVersion: 2,
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      probeId: answer.probeId,
      desired: answer.desired,
      assessed: answer.assessed,
      execution: answer.execution,
      controlApplicable: true,
    })
    expect(events.find((event) => event.type === "quiz.submit")).toMatchObject({
      type: "quiz.submit",
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      submissionId: "submission-1",
      items: 1,
      chats: [{ chatId: "chat-1", title: "Apartment site", projectId: "proj-apartment" }],
    })
  })

  test("requires the session attention check but records an incorrect response without blocking completion", async () => {
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    const missing = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
    })
    expect(missing!.status).toBe(400)

    const correct = attentionResponse(frozen).selectedValue
    const incorrect = frozen.attentionCheck.options.find((option) => option.value !== correct)!
    const response = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: {
        checkId: frozen.attentionCheck.checkId,
        selectedValue: incorrect.value,
      },
    })
    expect(response!.status).toBe(200)
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)?.attentionCheck).toEqual({
      checkId: frozen.attentionCheck.checkId,
      selectedValue: incorrect.value,
      passed: false,
    })
  })

  test("rejects v1 vocabulary and illegal v2 states at the submit seam", async () => {
    recordFocus()
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    const item = frozen.items[0]!
    const base = completeAnswer(item)
    const rejected = [
      // v1 categorical vocabulary, including the removed not_intended branch.
      { ...base, desired: { kind: "not_intended", presence: "absent", scope: null } },
      { ...base, desired: { kind: "accurate", presence: "present", scope: "project" } },
      { ...base, execution: "unsure" },
      { ...base, execution: "full" },
      // Optional explanations may be null, but malformed values and illegal scope states are rejected.
      { ...base, desired: { rating: 2, presence: "present", correctedContent: 42, scope: "project" } },
      { ...base, assessed: { rating: 3, presence: "present", believedContent: [], scope: "project" } },
      { ...base, assessed: { rating: "unknown", presence: "unknown", believedContent: null, scope: "session" } },
      // Midpoint-encoded unknown.
      { ...base, assessed: { rating: 3, presence: "unknown", believedContent: null, scope: null } },
    ]
    for (const answer of rejected) {
      const response = await call("POST", "/api/study/quiz", {
        taskId: TASK_ID,
        snapshotId: frozen.snapshotId,
        answers: [answer],
        attentionCheck: attentionResponse(frozen),
      })
      expect(response!.status).toBe(400)
    }
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)).toBeNull()
  })

  test("allows a frozen zero-item questionnaire without skipping workload", async () => {
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    expect(frozen.items).toEqual([])

    const submitResponse = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: attentionResponse(frozen),
    })

    expect(submitResponse!.status).toBe(200)
    expect(await responseData<{ recorded: number; created: boolean; submissionId: string }>(submitResponse)).toEqual({
      recorded: 0,
      created: true,
      submissionId: "submission-1",
    })
    expect(registry.taskStatus(NEXT_TASK_ID)).toBe("locked")
    expect(events.filter((event) => event.type === "quiz.answer")).toEqual([])
    expect(events.find((event) => event.type === "quiz.submit")).toMatchObject({ items: 0 })
  })

  test("persists both Raw TLX blocks before exposing the next session", async () => {
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: attentionResponse(frozen),
    })

    expect(await responseData<{ requiredStep: string }>(
      await call("GET", `/api/study/post-session?taskId=${TASK_ID}`),
    )).toMatchObject({ requiredStep: "monitoring_tlx" })

    const ratings = {
      mentalDemand: 60,
      physicalDemand: 5,
      temporalDemand: 40,
      performance: 25,
      effort: 55,
      frustration: 20,
    }
    const monitoring = await call("POST", "/api/study/raw-tlx", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "monitoring", ratings },
    })
    expect(await responseData<{ requiredStep: string }>(monitoring)).toMatchObject({
      requiredStep: "control_tlx",
    })
    expect(registry.taskStatus(NEXT_TASK_ID)).toBe("locked")

    const control = await call("POST", "/api/study/raw-tlx", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "control", ratings },
    })
    expect(await responseData<{ requiredStep: string; nextTaskId: string }>(control)).toMatchObject({
      requiredStep: "next_session",
      nextTaskId: NEXT_TASK_ID,
    })
    expect(registry.taskStatus(NEXT_TASK_ID)).toBe("active")
  })

  test("direct post-session POST transitions durably expose each next stage without GET", async () => {
    let tick = 0
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "memosync",
      activeTask: () => {
        const taskId = registry.activeTaskId()
        if (!taskId) return null
        const state = registry.freezeState(taskId)
        return state ? { taskId, state } : null
      },
      now: () => `2026-08-20T12:0${tick++}:00.000Z`,
    })
    const deps = routeDeps({ telemetry })
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }, {}, deps),
    )
    expect((await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: attentionResponse(frozen),
    }, {}, deps))!.status).toBe(200)

    const ratings = {
      mentalDemand: 60,
      physicalDemand: 5,
      temporalDemand: 40,
      performance: 25,
      effort: 55,
      frustration: 20,
    }
    expect((await call("POST", "/api/study/raw-tlx", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "monitoring", ratings },
    }, {}, deps))!.status).toBe(200)
    expect((await call("POST", "/api/study/raw-tlx", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "control", ratings },
    }, {}, deps))!.status).toBe(200)

    expect(store.listStudyTelemetryEvents().map(({ action }) => action)).toEqual([
      "memory_questionnaire",
      "monitoring_tlx",
      "control_tlx",
    ])
  })

  test("a failed next-stage receipt is recoverable and blocks the next durable submission", async () => {
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "memosync",
      activeTask: () => {
        const taskId = registry.activeTaskId()
        if (!taskId) return null
        const state = registry.freezeState(taskId)
        return state ? { taskId, state } : null
      },
      now: () => "2026-08-20T13:00:00.000Z",
    })
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }, {}, routeDeps({ telemetry })),
    )
    const failMonitoringEntry = {
      recordServerStageEntered: (stage: Parameters<StudyTelemetryService["recordServerStageEntered"]>[0], taskId?: string) => {
        if (stage === "monitoring_tlx") {
          throw new StudyTelemetryError("study.sqlite unavailable", 503)
        }
        return telemetry.recordServerStageEntered(stage, taskId)
      },
    } as StudyTelemetryService
    const unavailable = routeDeps({ telemetry: failMonitoringEntry })

    const quiz = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: attentionResponse(frozen),
    }, {}, unavailable)
    expect(quiz!.status).toBe(503)
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)).not.toBeNull()
    expect(store.listStudyTelemetryEvents().map(({ action }) => action)).toEqual(["memory_questionnaire"])

    const ratings = {
      mentalDemand: 60,
      physicalDemand: 5,
      temporalDemand: 40,
      performance: 25,
      effort: 55,
      frustration: 20,
    }
    const refusedMonitoring = await call("POST", "/api/study/raw-tlx", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "monitoring", ratings },
    }, {}, unavailable)
    expect(refusedMonitoring!.status).toBe(503)
    expect(store.getRawTlxSubmission(frozen.snapshotId, "monitoring")).toBeNull()

    const recovered = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: attentionResponse(frozen),
    }, {}, routeDeps({ telemetry }))
    expect(recovered!.status).toBe(200)
    expect(store.listStudyTelemetryEvents().map(({ action }) => action)).toEqual([
      "memory_questionnaire",
      "monitoring_tlx",
    ])
  })

  test("the final Control TLX POST records SUS entry before returning the SUS stage", async () => {
    let tick = 0
    const telemetry = new StudyTelemetryService({
      store,
      participantId: "P-017",
      condition: "memosync",
      activeTask: () => {
        const taskId = registry.activeTaskId()
        if (!taskId) return null
        const state = registry.freezeState(taskId)
        return state ? { taskId, state } : null
      },
      now: () => new Date(Date.UTC(2026, 7, 20, 14, tick++)).toISOString(),
    })
    const deps = routeDeps({ telemetry })
    const ratings = {
      mentalDemand: 60,
      physicalDemand: 5,
      temporalDemand: 40,
      performance: 25,
      effort: 55,
      frustration: 20,
    }
    const completeTask = async (taskId: string) => {
      const frozen = await responseData<PublicStudyQuestionnaire>(
        await call("POST", "/api/study/freeze", { taskId }, {}, deps),
      )
      expect((await call("POST", "/api/study/quiz", {
        taskId,
        snapshotId: frozen.snapshotId,
        answers: [],
        attentionCheck: attentionResponse(frozen),
      }, {}, deps))!.status).toBe(200)
      expect((await call("POST", "/api/study/raw-tlx", {
        taskId,
        snapshotId: frozen.snapshotId,
        response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "monitoring", ratings },
      }, {}, deps))!.status).toBe(200)
      return call("POST", "/api/study/raw-tlx", {
        taskId,
        snapshotId: frozen.snapshotId,
        response: { instrument: "raw_tlx", instrumentVersion: 1, activity: "control", ratings },
      }, {}, deps)
    }

    expect(await responseData<{ requiredStep: string }>(await completeTask(TASK_ID))).toMatchObject({
      requiredStep: "next_session",
    })
    expect(await responseData<{ requiredStep: string }>(await completeTask(NEXT_TASK_ID))).toMatchObject({
      requiredStep: "sus",
    })
    expect(store.listStudyTelemetryEvents().map(({ taskId, action }) => ({ taskId, action }))).toEqual([
      { taskId: TASK_ID, action: "memory_questionnaire" },
      { taskId: TASK_ID, action: "monitoring_tlx" },
      { taskId: TASK_ID, action: "control_tlx" },
      { taskId: NEXT_TASK_ID, action: "memory_questionnaire" },
      { taskId: NEXT_TASK_ID, action: "monitoring_tlx" },
      { taskId: NEXT_TASK_ID, action: "control_tlx" },
      { taskId: null, action: "sus" },
    ])
  })

  test("rejects a stale snapshot and any answer set that does not exactly match the frozen probes", async () => {
    recordFocus()
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    const answer = completeAnswer(frozen.items[0]!)

    const stale = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: "stale-snapshot",
      answers: [answer],
      attentionCheck: attentionResponse(frozen),
    })
    expect(stale!.status).toBe(409)

    const missing = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [],
      attentionCheck: attentionResponse(frozen),
    })
    expect(missing!.status).toBe(400)

    const duplicate = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [answer, answer],
      attentionCheck: attentionResponse(frozen),
    })
    expect(duplicate!.status).toBe(400)

    const wrongProbe = await call("POST", "/api/study/quiz", {
      taskId: TASK_ID,
      snapshotId: frozen.snapshotId,
      answers: [{ ...answer, probeId: "probe-not-frozen" }],
      attentionCheck: attentionResponse(frozen),
    })
    expect(wrongProbe!.status).toBe(400)
    expect(store.getQuestionnaireSubmission(frozen.snapshotId)).toBeNull()
    expect(registry.questionnairePending()).toBe(true)
  })

  test("admin unfreeze removes an unanswered snapshot and reopens the task", async () => {
    const frozen = await responseData<PublicStudyQuestionnaire>(
      await call("POST", "/api/study/freeze", { taskId: TASK_ID }),
    )
    expect(store.getFreezeSnapshot(frozen.snapshotId)).not.toBeNull()

    const disabled = await call(
      "POST",
      "/api/study/unfreeze",
      { taskId: TASK_ID },
      {},
      routeDeps({ adminKey: undefined }),
    )
    expect(disabled!.status).toBe(404)
    expect((await call("POST", "/api/study/unfreeze", { taskId: TASK_ID }))!.status).toBe(403)
    expect((await call(
      "POST",
      "/api/study/unfreeze",
      { taskId: TASK_ID },
      { "x-study-admin": "wrong" },
    ))!.status).toBe(403)

    const reopened = await call(
      "POST",
      "/api/study/unfreeze",
      { taskId: TASK_ID },
      { "x-study-admin": "let-me-in" },
    )
    expect(reopened!.status).toBe(200)
    expect(await responseData<{ unfrozen: boolean }>(reopened)).toEqual({ unfrozen: true })
    expect(store.getTaskFreezeSnapshot(TASK_ID)).toBeNull()
    expect(registry.freezeState(TASK_ID)).toBe("open")
    expect((await call("GET", `/api/study/questionnaire?taskId=${TASK_ID}`))!.status).toBe(409)
    expect(events.at(-1)).toEqual({ type: "study.unfreeze", taskId: TASK_ID })
    expect((await call(
      "POST",
      "/api/study/unfreeze",
      { taskId: TASK_ID },
      { "x-study-admin": "let-me-in" },
    ))!.status).toBe(409)
  })
})
