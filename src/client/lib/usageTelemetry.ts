export interface UsageTelemetryOutboxRequest {
  eventId: string
  endpoint: string
  body: Record<string, unknown>
}

interface StoredUsageTelemetryRequest extends UsageTelemetryOutboxRequest {
  enqueuedAt: number
}

type UsageTelemetryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
type UsageTelemetryFetch = (input: string, init?: RequestInit) => Promise<Response>

const DEFAULT_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_OUTBOX_MAX_ITEMS = 2_048
const DEFAULT_OUTBOX_MAX_BYTES = 2 * 1024 * 1024

export function storedRequests(storage: UsageTelemetryStorage, storageKey: string): StoredUsageTelemetryRequest[] {
  const raw = storage.getItem(storageKey)
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is StoredUsageTelemetryRequest => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
      const candidate = entry as Partial<StoredUsageTelemetryRequest>
      return typeof candidate.endpoint === "string"
        && Boolean(candidate.endpoint)
        && typeof candidate.eventId === "string"
        && Boolean(candidate.eventId)
        && typeof candidate.enqueuedAt === "number"
        && Number.isFinite(candidate.enqueuedAt)
        && Boolean(candidate.body)
        && typeof candidate.body === "object"
    })
  } catch {
    return []
  }
}

function saveRequests(
  storage: UsageTelemetryStorage,
  storageKey: string,
  requests: StoredUsageTelemetryRequest[],
): void {
  if (requests.length === 0) {
    storage.removeItem(storageKey)
    return
  }
  storage.setItem(storageKey, JSON.stringify(requests))
}

async function isAlreadyRecordedOperation(response: Response): Promise<boolean> {
  if (response.status !== 409) return false
  try {
    const body = await response.clone().json() as unknown
    if (!body || typeof body !== "object" || Array.isArray(body)) return false
    const error = (body as { error?: unknown }).error
    return Boolean(
      error
      && typeof error === "object"
      && !Array.isArray(error)
      && (error as { code?: unknown }).code === "OPERATION_ALREADY_RECORDED",
    )
  } catch {
    return false
  }
}

/**
 * Durable client delivery for local usage events. The caller
 * supplies a storage key; this module owns
 * persistence, ordered retry, and acknowledgement semantics behind one seam.
 */
export function createUsageTelemetryOutbox({
  storage,
  storageKey,
  fetcher = fetch,
  now = Date.now,
  onlineTarget = typeof window === "undefined" ? null : window,
  ttlMs = DEFAULT_OUTBOX_TTL_MS,
  maxItems = DEFAULT_OUTBOX_MAX_ITEMS,
  maxBytes = DEFAULT_OUTBOX_MAX_BYTES,
}: {
  storage: UsageTelemetryStorage
  storageKey: string
  fetcher?: UsageTelemetryFetch
  now?: () => number
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null
  ttlMs?: number
  maxItems?: number
  maxBytes?: number
}) {
  let flushInFlight: Promise<void> | null = null
  let started = false
  const retainCurrent = (requests: StoredUsageTelemetryRequest[]) => {
    const cutoff = now() - Math.max(0, ttlMs)
    return requests.filter((request) => request.enqueuedAt >= cutoff)
  }
  const bound = (requests: StoredUsageTelemetryRequest[]) => {
    const bounded = requests.slice(-Math.max(1, Math.floor(maxItems)))
    while (bounded.length > 0 && JSON.stringify(bounded).length > Math.max(1, Math.floor(maxBytes))) {
      bounded.shift()
    }
    return bounded
  }

  const flush = (): Promise<void> => {
    if (flushInFlight) return flushInFlight
    flushInFlight = (async () => {
      let requests = retainCurrent(storedRequests(storage, storageKey))
      saveRequests(storage, storageKey, requests)
      while (requests.length > 0) {
        const request = requests[0]!
        let response: Response
        try {
          response = await fetcher(request.endpoint, {
            method: "POST",
            keepalive: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request.body),
          })
        } catch {
          return
        }
        const acknowledged = response.ok
          || [400, 404, 410, 422].includes(response.status)
          || await isAlreadyRecordedOperation(response)
        if (!acknowledged) return
        // Enqueue may persist another event while this request is in flight.
        // Re-read before acknowledgement so removing the head never overwrites
        // a concurrently appended event with this flush's stale snapshot.
        const current = storedRequests(storage, storageKey)
        const acknowledgedIndex = current.findIndex((entry) => entry.eventId === request.eventId)
        if (acknowledgedIndex >= 0) current.splice(acknowledgedIndex, 1)
        saveRequests(storage, storageKey, current)
        requests = retainCurrent(storedRequests(storage, storageKey))
      }
    })().finally(() => {
      flushInFlight = null
    })
    return flushInFlight
  }

  const retryOnline = () => void flush()

  const persistStored = (incoming: StoredUsageTelemetryRequest[]): void => {
    let requests = retainCurrent(storedRequests(storage, storageKey))
    for (const request of retainCurrent(incoming)) {
      if (!requests.some((entry) => entry.eventId === request.eventId)) requests.push(request)
    }
    saveRequests(storage, storageKey, bound(requests))
  }

  const persist = (request: UsageTelemetryOutboxRequest): void => {
    persistStored([{
      eventId: request.eventId,
      endpoint: request.endpoint,
      body: request.body,
      enqueuedAt: now(),
    }])
  }

  return {
    persist,
    importStored(requests: StoredUsageTelemetryRequest[]): void {
      persistStored(requests)
    },
    async enqueue(request: UsageTelemetryOutboxRequest): Promise<void> {
      persist(request)
      await flush()
    },
    flush,
    async start(): Promise<void> {
      if (!started) {
        started = true
        onlineTarget?.addEventListener("online", retryOnline)
      }
      await flush()
    },
    stop(): void {
      if (!started) return
      started = false
      onlineTarget?.removeEventListener("online", retryOnline)
    },
  }
}

const PRODUCT_OUTBOX_KEY = "memosync:usage-outbox:v1"
let activeOutbox: ReturnType<typeof createUsageTelemetryOutbox> | null = null

export async function initializeUsageTelemetryOutbox({
  storage = typeof window === "undefined" ? null : window.localStorage,
  fetcher = fetch,
  onlineTarget = typeof window === "undefined" ? null : window,
}: {
  storage?: UsageTelemetryStorage | null
  fetcher?: UsageTelemetryFetch
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null
} = {}): Promise<void> {
  stopUsageTelemetryOutbox()
  if (!storage) return
  activeOutbox = createUsageTelemetryOutbox({ storage, storageKey: PRODUCT_OUTBOX_KEY, fetcher, onlineTarget })
  try { await activeOutbox.start() } catch { /* Storage may be unavailable. Usage logging is optional. */ }
}

export function enqueueUsageTelemetry(request: UsageTelemetryOutboxRequest): void {
  if (!activeOutbox) return
  void activeOutbox.enqueue(request).catch(() => { /* best-effort local logging */ })
}

export function stopUsageTelemetryOutbox(): void {
  activeOutbox?.stop()
  activeOutbox = null
}
