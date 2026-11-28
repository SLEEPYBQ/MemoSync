import * as Crypto from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import {
  EMPTY_DRAFT_STATE,
  MAX_DRAFT_STORAGE_CHUNKS,
  MAX_SECURE_STORE_DRAFT_BYTES,
  isDraftStateEmpty,
  parsePersistedDraftState,
  registerClientRequestIdGenerator,
  serializePersistedDraftState,
  serializePersistedDraftStateForStorage,
  splitStringByUtf8Bytes,
  utf8ByteLength,
  type PersistedDraftState,
} from "./chatState"

// Wire native CSPRNG UUIDv4 generation on Hermes (where `globalThis.crypto` is absent).
registerClientRequestIdGenerator(() => Crypto.randomUUID())

/**
 * Per-chat draft, in-flight send, pending dequeue-restore, and retry-key persistence.
 *
 * - Keeps an in-memory map for synchronous navigation across screens and notifies
 *   mounted subscribers so unmounted send/dequeue completions never clobber newer drafts.
 * - Serializes all `expo-secure-store` operations per chat via promise chains so
 *   rapid save -> clear transitions and multi-chunk writes can never interleave.
 * - Chunks serialized payloads exceeding the ~1,900-byte single-entry SecureStore
 *   ceiling across up to `MAX_DRAFT_STORAGE_CHUNKS` keys (~15 KB), falling back to
 *   compact hash-only metadata only past the multi-chunk cap.
 * - Debounces keystroke persistence while flushing immediately on send/blur/unmount.
 * - Maintains a compact index key so `hostStore.forget()` purges every user draft
 *   (and every chunk) from RAM and the OS Keychain/Keystore on device unpair or token revocation.
 */

export interface DraftStorageBackend {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

const SECURE_STORE_PREFIX = "memosync.draft."
const INDEX_KEY = "memosync.draft._index"
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}
const KEYSTROKE_DEBOUNCE_MS = 250
const MAX_INDEXED_CHATS = 40

type StoragePlan =
  | { kind: "delete" }
  | { kind: "single"; payload: string }
  | { kind: "chunked"; chunks: string[]; manifest: string }

const defaultStorageBackend: DraftStorageBackend = {
  getItemAsync: (key) => SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, SECURE_STORE_OPTIONS),
}

let storageBackend: DraftStorageBackend = defaultStorageBackend

const memoryDrafts = new Map<string, PersistedDraftState>()
const mutationVersions = new Map<string, number>()
const listeners = new Map<string, Set<(state: PersistedDraftState) => void>>()
const activeInFlightSends = new Map<string, string>()
const activeDequeues = new Map<string, Set<string>>()
const persistedChunkCounts = new Map<string, number>()
const keyQueues = new Map<string, Promise<void>>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingDebouncedPlans = new Map<string, StoragePlan>()
let indexedChatIdsCache: string[] | null = null

export function secureStoreKeyForDraft(chatId: string): string {
  const encoded = chatId.replace(/[^a-zA-Z0-9._-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`)
  return `${SECURE_STORE_PREFIX}${encoded}`
}

export function secureStoreChunkKeyForDraft(chatId: string, chunkIndex: number): string {
  return `${secureStoreKeyForDraft(chatId)}.c${chunkIndex}`
}

function chunkKeyForBaseKey(baseKey: string, chunkIndex: number): string {
  return `${baseKey}.c${chunkIndex}`
}

function parseChunkManifest(raw: string | null): { count: number; length: number } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.v === "chunks" &&
      typeof parsed.n === "number" &&
      Number.isInteger(parsed.n) &&
      parsed.n >= 1 &&
      parsed.n <= MAX_DRAFT_STORAGE_CHUNKS &&
      typeof parsed.l === "number" &&
      Number.isInteger(parsed.l) &&
      parsed.l > 0
    ) {
      return { count: parsed.n, length: parsed.l }
    }
  } catch {
    // Not a chunk manifest.
  }
  return null
}

function prepareStoragePlan(state: PersistedDraftState | null): StoragePlan {
  if (!state || isDraftStateEmpty(state)) return { kind: "delete" }
  const full = serializePersistedDraftState(state)
  if (!full) return { kind: "delete" }
  if (utf8ByteLength(full) <= MAX_SECURE_STORE_DRAFT_BYTES) {
    return { kind: "single", payload: full }
  }
  const chunks = splitStringByUtf8Bytes(full, MAX_SECURE_STORE_DRAFT_BYTES)
  if (chunks.length > 0 && chunks.length <= MAX_DRAFT_STORAGE_CHUNKS) {
    return {
      kind: "chunked",
      chunks,
      manifest: JSON.stringify({ v: "chunks", n: chunks.length, l: full.length }),
    }
  }
  const compact = serializePersistedDraftStateForStorage(state, MAX_SECURE_STORE_DRAFT_BYTES)
  return compact ? { kind: "single", payload: compact } : { kind: "delete" }
}

function bumpVersion(chatId: string): number {
  const next = (mutationVersions.get(chatId) ?? 0) + 1
  mutationVersions.set(chatId, next)
  return next
}

function notifyListeners(chatId: string, state: PersistedDraftState): void {
  const chatListeners = listeners.get(chatId)
  if (!chatListeners) return
  for (const listener of [...chatListeners]) {
    listener(state)
  }
}

function enqueueKeyOp<T>(key: string, op: () => Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(op)
  const tracked = run.then(
    () => undefined,
    () => undefined,
  )
  const cleanup = tracked.finally(() => {
    if (keyQueues.get(key) === cleanup) {
      keyQueues.delete(key)
    }
  })
  keyQueues.set(key, cleanup)
  return run
}

async function readIndexUnlocked(): Promise<string[]> {
  if (indexedChatIdsCache !== null) return [...indexedChatIdsCache]
  try {
    const raw = await storageBackend.getItemAsync(INDEX_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
        indexedChatIdsCache = cleaned
        return [...cleaned]
      }
    }
  } catch {
    // Corrupt or unavailable index — treat as empty.
  }
  indexedChatIdsCache = []
  return []
}

async function detectExistingChunkCountUnlocked(chatId: string, baseKey: string): Promise<number> {
  const known = persistedChunkCounts.get(chatId)
  if (known !== undefined) return known
  try {
    const existingRaw = await storageBackend.getItemAsync(baseKey)
    const manifest = parseChunkManifest(existingRaw)
    const count = manifest ? manifest.count : 0
    persistedChunkCounts.set(chatId, count)
    return count
  } catch {
    return 0
  }
}

async function deleteChunkKeysUnlocked(baseKey: string, fromIndex: number, toExclusive: number): Promise<void> {
  for (let i = fromIndex; i < toExclusive; i += 1) {
    try {
      await storageBackend.deleteItemAsync(chunkKeyForBaseKey(baseKey, i))
    } catch {
      // Ignore best-effort chunk cleanup errors.
    }
  }
}

function recordIndexedChat(chatId: string): void {
  void enqueueKeyOp(INDEX_KEY, async () => {
    const list = await readIndexUnlocked()
    const filtered = list.filter((id) => id !== chatId)
    filtered.push(chatId)
    const evicted: string[] = []
    while (filtered.length > MAX_INDEXED_CHATS) {
      const oldest = filtered.shift()
      if (oldest) evicted.push(oldest)
    }
    indexedChatIdsCache = filtered
    try {
      await storageBackend.setItemAsync(INDEX_KEY, JSON.stringify(filtered))
    } catch {
      // Ignore keychain write failure; memory state remains authoritative.
    }
    for (const evictedId of evicted) {
      const evictedKey = secureStoreKeyForDraft(evictedId)
      void enqueueKeyOp(evictedKey, async () => {
        const chunkCount = await detectExistingChunkCountUnlocked(evictedId, evictedKey)
        try {
          await storageBackend.deleteItemAsync(evictedKey)
        } catch {
          // Ignore best-effort cleanup errors.
        }
        await deleteChunkKeysUnlocked(evictedKey, 0, chunkCount)
        persistedChunkCounts.delete(evictedId)
      })
    }
  })
}

function removeIndexedChat(chatId: string): void {
  void enqueueKeyOp(INDEX_KEY, async () => {
    const list = await readIndexUnlocked()
    const filtered = list.filter((id) => id !== chatId)
    if (filtered.length === list.length) return
    indexedChatIdsCache = filtered
    try {
      if (filtered.length === 0) {
        await storageBackend.deleteItemAsync(INDEX_KEY)
      } else {
        await storageBackend.setItemAsync(INDEX_KEY, JSON.stringify(filtered))
      }
    } catch {
      // Ignore best-effort index cleanup errors.
    }
  })
}

function enqueueDiskWrite(chatId: string, plan: StoragePlan): void {
  const key = secureStoreKeyForDraft(chatId)
  if (plan.kind === "delete") {
    void enqueueKeyOp(key, async () => {
      const prevChunks = await detectExistingChunkCountUnlocked(chatId, key)
      try {
        await storageBackend.deleteItemAsync(key)
      } catch {
        // Ignore keychain hiccups.
      }
      await deleteChunkKeysUnlocked(key, 0, prevChunks)
      persistedChunkCounts.delete(chatId)
    })
    removeIndexedChat(chatId)
    return
  }
  if (plan.kind === "single") {
    void enqueueKeyOp(key, async () => {
      const prevChunks = await detectExistingChunkCountUnlocked(chatId, key)
      try {
        await storageBackend.setItemAsync(key, plan.payload)
      } catch {
        // Ignore keychain hiccups; in-memory copy remains live.
        return
      }
      await deleteChunkKeysUnlocked(key, 0, prevChunks)
      persistedChunkCounts.set(chatId, 0)
    })
    recordIndexedChat(chatId)
    return
  }
  void enqueueKeyOp(key, async () => {
    const prevChunks = await detectExistingChunkCountUnlocked(chatId, key)
    try {
      for (let i = 0; i < plan.chunks.length; i += 1) {
        await storageBackend.setItemAsync(chunkKeyForBaseKey(key, i), plan.chunks[i]!)
      }
      await storageBackend.setItemAsync(key, plan.manifest)
    } catch {
      // Ignore keychain hiccups; in-memory copy remains live.
      return
    }
    await deleteChunkKeysUnlocked(key, plan.chunks.length, prevChunks)
    persistedChunkCounts.set(chatId, plan.chunks.length)
  })
  recordIndexedChat(chatId)
}

function cancelDebounce(chatId: string): void {
  const timer = debounceTimers.get(chatId)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(chatId)
  }
  pendingDebouncedPlans.delete(chatId)
}

export function subscribeDraftState(
  chatId: string,
  listener: (state: PersistedDraftState) => void,
): () => void {
  let set = listeners.get(chatId)
  if (!set) {
    set = new Set()
    listeners.set(chatId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(chatId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(chatId)
  }
}

export function markInFlightSendActive(chatId: string, clientRequestId: string): void {
  activeInFlightSends.set(chatId, clientRequestId)
}

export function clearInFlightSendActive(chatId: string, clientRequestId?: string): void {
  if (!clientRequestId || activeInFlightSends.get(chatId) === clientRequestId) {
    activeInFlightSends.delete(chatId)
  }
}

export function isInFlightSendActive(chatId: string, clientRequestId?: string): boolean {
  const activeId = activeInFlightSends.get(chatId)
  if (!activeId) return false
  return clientRequestId ? activeId === clientRequestId : true
}

export function markDequeueActive(chatId: string, queuedMessageId: string): void {
  let set = activeDequeues.get(chatId)
  if (!set) {
    set = new Set()
    activeDequeues.set(chatId, set)
  }
  set.add(queuedMessageId)
}

export function clearDequeueActive(chatId: string, queuedMessageId?: string): void {
  if (!queuedMessageId) {
    activeDequeues.delete(chatId)
    return
  }
  const set = activeDequeues.get(chatId)
  if (!set) return
  set.delete(queuedMessageId)
  if (set.size === 0) activeDequeues.delete(chatId)
}

export function isDequeueActive(chatId: string, queuedMessageId: string): boolean {
  return Boolean(activeDequeues.get(chatId)?.has(queuedMessageId))
}

export function getCachedDraftState(chatId: string): PersistedDraftState | null {
  return memoryDrafts.get(chatId) ?? null
}

export async function loadPersistedDraftState(chatId: string): Promise<PersistedDraftState | null> {
  const cached = memoryDrafts.get(chatId)
  if (cached) return cached
  const versionAtStart = mutationVersions.get(chatId) ?? 0
  const key = secureStoreKeyForDraft(chatId)
  try {
    const rawPayload = await enqueueKeyOp(key, async () => {
      const baseRaw = await storageBackend.getItemAsync(key)
      if (!baseRaw) {
        persistedChunkCounts.set(chatId, 0)
        return null
      }
      const manifest = parseChunkManifest(baseRaw)
      if (!manifest) {
        persistedChunkCounts.set(chatId, 0)
        return baseRaw
      }
      persistedChunkCounts.set(chatId, manifest.count)
      const parts: string[] = []
      for (let i = 0; i < manifest.count; i += 1) {
        const part = await storageBackend.getItemAsync(chunkKeyForBaseKey(key, i))
        if (part === null) return null
        parts.push(part)
      }
      const joined = parts.join("")
      return joined.length === manifest.length ? joined : null
    })
    // If a save or clear ran while reading Keychain, never clobber the newer state.
    if ((mutationVersions.get(chatId) ?? 0) !== versionAtStart) {
      return memoryDrafts.get(chatId) ?? null
    }
    const parsed = parsePersistedDraftState(rawPayload)
    if (parsed) {
      memoryDrafts.set(chatId, parsed)
      return parsed
    }
  } catch {
    // Keychain unavailable or corrupt entry — degrade to empty draft.
  }
  return null
}

export function savePersistedDraftState(
  chatId: string,
  state: PersistedDraftState,
  options?: { immediate?: boolean },
): void {
  const immediate = options?.immediate !== false
  bumpVersion(chatId)
  if (isDraftStateEmpty(state)) {
    cancelDebounce(chatId)
    memoryDrafts.delete(chatId)
    enqueueDiskWrite(chatId, { kind: "delete" })
    notifyListeners(chatId, EMPTY_DRAFT_STATE)
    return
  }
  memoryDrafts.set(chatId, state)
  const plan = prepareStoragePlan(state)
  notifyListeners(chatId, state)
  if (immediate) {
    cancelDebounce(chatId)
    enqueueDiskWrite(chatId, plan)
    return
  }
  pendingDebouncedPlans.set(chatId, plan)
  const existingTimer = debounceTimers.get(chatId)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    if (debounceTimers.get(chatId) !== timer) return
    debounceTimers.delete(chatId)
    const pendingPlan = pendingDebouncedPlans.get(chatId) ?? { kind: "delete" as const }
    pendingDebouncedPlans.delete(chatId)
    enqueueDiskWrite(chatId, pendingPlan)
  }, KEYSTROKE_DEBOUNCE_MS)
  debounceTimers.set(chatId, timer)
}

/** Update draft state atomically against the live store entry (safe from
 * unmounted components or async callbacks). */
export function updatePersistedDraftState(
  chatId: string,
  updater: (current: PersistedDraftState) => PersistedDraftState,
  options?: { immediate?: boolean },
): PersistedDraftState {
  const current = memoryDrafts.get(chatId) ?? EMPTY_DRAFT_STATE
  const next = updater(current)
  if (next === current) return current
  savePersistedDraftState(chatId, next, options)
  return next
}

export function flushPersistedDraftState(chatId: string): void {
  const timer = debounceTimers.get(chatId)
  if (!timer) return
  clearTimeout(timer)
  debounceTimers.delete(chatId)
  const pendingPlan = pendingDebouncedPlans.get(chatId) ?? { kind: "delete" as const }
  pendingDebouncedPlans.delete(chatId)
  enqueueDiskWrite(chatId, pendingPlan)
}

export function clearPersistedDraftState(chatId: string): void {
  bumpVersion(chatId)
  cancelDebounce(chatId)
  memoryDrafts.delete(chatId)
  enqueueDiskWrite(chatId, { kind: "delete" })
  notifyListeners(chatId, EMPTY_DRAFT_STATE)
}

/** Purge every draft, chunk, and retry key from RAM and OS Keychain (e.g. on device unpair). */
export async function clearAllPersistedDrafts(): Promise<void> {
  for (const chatId of [...debounceTimers.keys()]) {
    cancelDebounce(chatId)
  }
  const chatIdsToClear = new Set<string>([
    ...memoryDrafts.keys(),
    ...listeners.keys(),
    ...activeInFlightSends.keys(),
    ...activeDequeues.keys(),
    ...persistedChunkCounts.keys(),
  ])
  memoryDrafts.clear()
  activeInFlightSends.clear()
  activeDequeues.clear()
  persistedChunkCounts.clear()

  const persistedIds = await enqueueKeyOp(INDEX_KEY, async () => {
    const ids = await readIndexUnlocked()
    indexedChatIdsCache = []
    try {
      await storageBackend.deleteItemAsync(INDEX_KEY)
    } catch {
      // Ignore best-effort keychain delete failure.
    }
    return ids
  })

  for (const chatId of persistedIds) {
    chatIdsToClear.add(chatId)
  }

  for (const chatId of chatIdsToClear) {
    bumpVersion(chatId)
    notifyListeners(chatId, EMPTY_DRAFT_STATE)
  }

  await Promise.all(
    [...chatIdsToClear].map((chatId) => {
      const key = secureStoreKeyForDraft(chatId)
      return enqueueKeyOp(key, async () => {
        try {
          await storageBackend.deleteItemAsync(key)
        } catch {
          // Ignore individual keychain delete failures.
        }
        await deleteChunkKeysUnlocked(key, 0, MAX_DRAFT_STORAGE_CHUNKS)
      })
    }),
  )
}

/** Flush any debounced writes and wait for all queued storage operations to settle. */
export async function flushAllDraftWrites(): Promise<void> {
  for (const chatId of [...debounceTimers.keys()]) {
    flushPersistedDraftState(chatId)
  }
  while (keyQueues.size > 0) {
    await Promise.all([...keyQueues.values()])
  }
}

/** Test-only hook to swap the storage backend and reset module caches. */
export function setDraftStorageBackendForTesting(backend?: DraftStorageBackend): void {
  for (const chatId of [...debounceTimers.keys()]) {
    cancelDebounce(chatId)
  }
  memoryDrafts.clear()
  mutationVersions.clear()
  listeners.clear()
  activeInFlightSends.clear()
  activeDequeues.clear()
  persistedChunkCounts.clear()
  keyQueues.clear()
  indexedChatIdsCache = null
  storageBackend = backend ?? defaultStorageBackend
}
