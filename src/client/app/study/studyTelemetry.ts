import { generateUUID } from "../../lib/utils"

export type StudyTimedStage = "information" | "memory_questionnaire" | "monitoring_tlx" | "control_tlx" | "sus"

import { createUsageTelemetryOutbox as createStudyTelemetryOutbox, storedRequests, type UsageTelemetryOutboxRequest as StudyTelemetryOutboxRequest } from "../../lib/usageTelemetry"
export { createUsageTelemetryOutbox as createStudyTelemetryOutbox } from "../../lib/usageTelemetry"
export type { UsageTelemetryOutboxRequest as StudyTelemetryOutboxRequest } from "../../lib/usageTelemetry"
type StudyTelemetryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
type StudyTelemetryFetch = (input: string, init?: RequestInit) => Promise<Response>
const OUTBOX_STORAGE_PREFIX = "memosync:study-telemetry-outbox:v1:"
const OUTBOX_SCOPE_PREFIX = "memosync:study-telemetry-scope:v1:"
const PENDING_OUTBOX_STORAGE_KEY = "memosync:study-telemetry-pending:v1"

type StudyTelemetryOutbox = ReturnType<typeof createStudyTelemetryOutbox>
type StudyTelemetryCondition = "memosync"
type BrowserStudyTelemetryStorage = StudyTelemetryStorage & Pick<Storage, "key" | "length">

let activeStudyTelemetryOutbox: StudyTelemetryOutbox | null = null
let pendingStudyTelemetryStorage: BrowserStudyTelemetryStorage | null = null
let pendingStudyTelemetryWriter: StudyTelemetryOutbox | null = null

/** Enable the anonymous pre-scope queue synchronously before study UI effects
 * can emit. Its storage key contains no participant or condition identity. */
export function prepareStudyTelemetryOutbox(
  storage: BrowserStudyTelemetryStorage | null = typeof window === "undefined" ? null : window.localStorage,
): void {
  if (!storage) {
    pendingStudyTelemetryStorage = null
    pendingStudyTelemetryWriter = null
    return
  }
  if (pendingStudyTelemetryStorage === storage && pendingStudyTelemetryWriter) return
  pendingStudyTelemetryStorage = storage
  pendingStudyTelemetryWriter = createStudyTelemetryOutbox({
    storage,
    storageKey: PENDING_OUTBOX_STORAGE_KEY,
    // The pre-scope writer only uses synchronous persist(); it never starts or
    // sends until onboarding resolves the server-owned participant scope.
    fetcher: async () => new Response(null, { status: 503 }),
    onlineTarget: null,
  })
}

function clearStudyTelemetryScopes(storage: BrowserStudyTelemetryStorage): void {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (
      key === PENDING_OUTBOX_STORAGE_KEY
      || key?.startsWith(OUTBOX_STORAGE_PREFIX)
      || key?.startsWith(OUTBOX_SCOPE_PREFIX)
    ) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

/**
 * Initialize only after the server-owned onboarding status resolves. A new
 * participant begins at `information`, which resets every old origin-local
 * scope before any study interaction is possible. Returning participants
 * reuse their condition scope and flush it on app initialization.
 */
export async function initializeStudyTelemetryOutbox({
  condition,
  resetForNewParticipant,
  storage = typeof window === "undefined" ? null : window.localStorage,
  fetcher = fetch,
  onlineTarget = typeof window === "undefined" ? null : window,
  randomId = generateUUID,
}: {
  condition: StudyTelemetryCondition
  resetForNewParticipant: boolean
  storage?: BrowserStudyTelemetryStorage | null
  fetcher?: StudyTelemetryFetch
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null
  randomId?: () => string
}): Promise<void> {
  activeStudyTelemetryOutbox?.stop()
  activeStudyTelemetryOutbox = null
  if (!storage) {
    prepareStudyTelemetryOutbox(null)
    return
  }
  prepareStudyTelemetryOutbox(storage)
  // Information means a new server-owned participant. Clear anonymous pending
  // evidence before creating any scoped outbox so an old participant's events
  // can never be rebound to the new allocation.
  if (resetForNewParticipant) clearStudyTelemetryScopes(storage)
  const scopeKey = `${OUTBOX_SCOPE_PREFIX}${condition}`
  let scope = storage.getItem(scopeKey)
  if (!scope) {
    scope = randomId()
    storage.setItem(scopeKey, scope)
  }
  const scopedOutbox = createStudyTelemetryOutbox({
    storage,
    storageKey: `${OUTBOX_STORAGE_PREFIX}${condition}:${scope}`,
    fetcher,
    onlineTarget,
  })
  const pending = storedRequests(storage, PENDING_OUTBOX_STORAGE_KEY)
  scopedOutbox.importStored(pending)
  // importStored is synchronous and durable. Only after the complete pending
  // set exists under the resolved scope may the anonymous key be removed.
  storage.removeItem(PENDING_OUTBOX_STORAGE_KEY)
  activeStudyTelemetryOutbox = scopedOutbox
  await scopedOutbox.start()
}

export function enqueueStudyTelemetry(request: StudyTelemetryOutboxRequest): void {
  if (activeStudyTelemetryOutbox) {
    void activeStudyTelemetryOutbox.enqueue(request)
    return
  }
  // In a study bootstrap, prepareStudyTelemetryOutbox has installed a durable
  // anonymous writer. Outside study mode it remains null, so ordinary product
  // use does not accumulate study events.
  pendingStudyTelemetryWriter?.persist(request)
}

export function stopStudyTelemetryOutbox(): void {
  activeStudyTelemetryOutbox?.stop()
  activeStudyTelemetryOutbox = null
  pendingStudyTelemetryStorage = null
  pendingStudyTelemetryWriter = null
}

/** Retry the independent onboarding lookup without blocking the study route.
 * The anonymous queue remains active between attempts; an online event wakes a
 * delayed retry immediately. */
export function startStudyTelemetryBootstrap({
  condition,
  loadOnboarding,
  storage = typeof window === "undefined" ? null : window.localStorage,
  fetcher = fetch,
  onlineTarget = typeof window === "undefined" ? null : window,
  randomId = generateUUID,
  retryDelayMs = (attempt) => Math.min(5_000, 250 * (2 ** Math.max(0, attempt - 1))),
}: {
  condition: StudyTelemetryCondition
  loadOnboarding: () => Promise<{ stage: string }>
  storage?: BrowserStudyTelemetryStorage | null
  fetcher?: StudyTelemetryFetch
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null
  randomId?: () => string
  retryDelayMs?: (attempt: number) => number
}): { ready: Promise<"ready" | "stopped">; stop(): void } {
  prepareStudyTelemetryOutbox(storage)
  let stopped = false
  let settled = false
  let inFlight = false
  let retryRequested = false
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let resolveReady!: (status: "ready" | "stopped") => void
  const ready = new Promise<"ready" | "stopped">((resolve) => { resolveReady = resolve })

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }
  const detach = () => {
    clearRetry()
    onlineTarget?.removeEventListener("online", trigger)
  }
  const finish = (status: "ready" | "stopped") => {
    if (settled) return
    settled = true
    detach()
    resolveReady(status)
  }
  const run = async () => {
    if (stopped || settled || inFlight) return
    inFlight = true
    retryRequested = false
    attempts += 1
    let failed = false
    try {
      const state = await loadOnboarding()
      if (stopped) return
      await initializeStudyTelemetryOutbox({
        condition,
        resetForNewParticipant: state.stage === "information",
        storage,
        fetcher,
        onlineTarget,
        randomId,
      })
      if (stopped) {
        stopStudyTelemetryOutbox()
        return
      }
      finish("ready")
    } catch {
      failed = true
    } finally {
      inFlight = false
      if (stopped || settled) return
      if (retryRequested) {
        retryRequested = false
        trigger()
      } else if (failed) {
        retryTimer = setTimeout(trigger, Math.max(0, retryDelayMs(attempts)))
      }
    }
  }
  function trigger() {
    if (stopped || settled) return
    clearRetry()
    if (inFlight) {
      retryRequested = true
      return
    }
    void run()
  }

  onlineTarget?.addEventListener("online", trigger)
  trigger()
  return {
    ready,
    stop() {
      if (stopped) return
      stopped = true
      detach()
      stopStudyTelemetryOutbox()
      finish("stopped")
    },
  }
}

/**
 * Stage entry is measurement evidence, not navigation authority. Retry a
 * transient failure with the same semantic stage key; the server owns the
 * deterministic id and keeps the first accepted timestamp across reloads.
 */
export async function recordStudyStageEntered(stage: StudyTimedStage, taskId?: string): Promise<void> {
  const body = {
    eventId: `stage-entry:${generateUUID()}`,
    kind: "stage_enter",
    surface: "study",
    action: stage,
    clientTimestamp: new Date().toISOString(),
    ...(taskId ? { taskId } : {}),
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch("/api/study/telemetry", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (response.ok || (response.status >= 400 && response.status < 500)) return
    } catch {
      // A reload will issue the same stage entry again; bounded retries cover
      // ordinary boot/proxy races without keeping a page alive forever.
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
  }
}
