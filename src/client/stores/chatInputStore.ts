import { create, type StoreApi } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { ChatAttachment } from "../../shared/types"

interface DraftRevision {
  textKey: string | null
  textRevision: number
  attachmentKey: string | null
  attachmentRevision: number
}

interface ChatInputState {
  lastDeletedUploadId?: string
  drafts: Record<string, string>
  attachmentDrafts: Record<string, ChatAttachment[]>
  draftRevisions: Record<string, number>
  attachmentDraftRevisions: Record<string, number>
  setDraft: (chatId: string, value: string) => void
  clearDraft: (chatId: string) => void
  getDraft: (chatId: string) => string
  setAttachmentDrafts: (chatId: string, attachments: ChatAttachment[], edited?: boolean) => void
  clearAttachmentDrafts: (chatId: string) => void
  retireSubmittedAttachments: (key: string, submitted: readonly ChatAttachment[]) => void
  migrateAttachmentDrafts: (
    sourceKey: string,
    targetKey: string,
    migrate: (source: ChatAttachment[], target: ChatAttachment[]) => { source: ChatAttachment[]; target: ChatAttachment[] } | null,
  ) => boolean
  getAttachmentDrafts: (chatId: string) => ChatAttachment[]
  getDraftRevision: (textKey: string | null, attachmentKey: string | null) => DraftRevision
  clearSubmittedDraft: (revision: DraftRevision) => boolean
}

function sameAttachments(left: ChatAttachment[], right: ChatAttachment[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return item.id === other.id && item.kind === other.kind && item.displayName === other.displayName
      && item.absolutePath === other.absolutePath && item.relativePath === other.relativePath
      && item.contentUrl === other.contentUrl && item.mimeType === other.mimeType && item.size === other.size
      && item.uploadSha256 === other.uploadSha256
  })
}

// One cross-tab notice, not a permanent tombstone per upload. Remove only that
// ID from each in-memory bucket; the deleting tab already persisted its edit.
export const DELETED_UPLOAD_NOTIFICATION = "memosync.last-deleted-upload"
function listenForDeletedUploads(setLocal: StoreApi<ChatInputState>["setState"]) {
  if (typeof window === "undefined") return
  window.addEventListener?.("storage", event => {
    if (event.key !== DELETED_UPLOAD_NOTIFICATION || !event.newValue) return
    const id = event.newValue
    setLocal(state => {
      const changed = Object.entries(state.attachmentDrafts).filter(([, items]) => items.some(item => item.id === id))
      if (!changed.length) return state
      const attachmentDrafts = { ...state.attachmentDrafts }
      const attachmentDraftRevisions = { ...state.attachmentDraftRevisions }
      for (const [key, items] of changed) {
        const remaining = items.filter(item => item.id !== id)
        if (remaining.length) attachmentDrafts[key] = remaining
        else delete attachmentDrafts[key]
        attachmentDraftRevisions[key] = (attachmentDraftRevisions[key] ?? 0) + 1
      }
      return { attachmentDrafts, attachmentDraftRevisions, lastDeletedUploadId: id }
    })
  })
}

// Revisions are tab-local counters, so a tab whose memory lags storage would
// allocate losing revisions for fresh edits. Allocate above the latest
// persisted revision instead — the merge write is synchronous, so this read
// sees every write any tab has committed.
const allocateRevision = (key: string, memoryRevision: number | undefined, field: "draftRevisions" | "attachmentDraftRevisions") => {
  let persisted = 0
  if (typeof localStorage !== "undefined") {
    try {
      const parsed = JSON.parse(localStorage.getItem("chat-input-drafts") ?? "null") as { state?: Record<string, Record<string, number>> } | null
      persisted = parsed?.state?.[field]?.[key] ?? 0
    } catch { /* unreadable storage allocates from memory alone */ }
  }
  return Math.max(memoryRevision ?? 0, persisted) + 1
}

interface DraftBucketState {
  drafts: Record<string, string>
  attachmentDrafts: Record<string, ChatAttachment[]>
  draftRevisions: Record<string, number>
  attachmentDraftRevisions: Record<string, number>
}

// Every edit bumps its key's revision, so the newer side of any divergence is
// the one with the higher revision — per key, never wholesale. A missing
// content key with the winning revision is a deletion and stays deleted.
function mergeBucketMaps<T>(memory: Record<string, T>, stored: Record<string, T>, memoryRevisions: Record<string, number>, storedRevisions: Record<string, number>) {
  const merged: Record<string, T> = {}
  const keys = new Set([...Object.keys(memory), ...Object.keys(stored)])
  for (const key of keys) {
    const keepMemory = (memoryRevisions[key] ?? 0) >= (storedRevisions[key] ?? 0)
    const winner = keepMemory ? memory : stored
    if (winner[key] !== undefined) merged[key] = winner[key]
  }
  return merged
}

function mergeRevisionMaps(memory: Record<string, number>, stored: Record<string, number>) {
  const merged: Record<string, number> = { ...stored }
  for (const [key, revision] of Object.entries(memory)) merged[key] = Math.max(revision, merged[key] ?? 0)
  return merged
}

function mergeDraftBuckets(memory: DraftBucketState, stored: DraftBucketState): DraftBucketState {
  return {
    drafts: mergeBucketMaps(memory.drafts, stored.drafts, memory.draftRevisions, stored.draftRevisions),
    attachmentDrafts: mergeBucketMaps(memory.attachmentDrafts, stored.attachmentDrafts, memory.attachmentDraftRevisions, stored.attachmentDraftRevisions),
    draftRevisions: mergeRevisionMaps(memory.draftRevisions, stored.draftRevisions),
    attachmentDraftRevisions: mergeRevisionMaps(memory.attachmentDraftRevisions, stored.attachmentDraftRevisions),
  }
}

function parsePersistedBuckets(raw: string | null): DraftBucketState | null {
  if (!raw) return null
  try {
    const state = (JSON.parse(raw) as { state?: Partial<DraftBucketState> }).state
    if (!state || typeof state !== "object") return null
    return {
      drafts: state.drafts ?? {},
      attachmentDrafts: state.attachmentDrafts ?? {},
      draftRevisions: state.draftRevisions ?? {},
      attachmentDraftRevisions: state.attachmentDraftRevisions ?? {},
    }
  } catch { return null }
}

// A write that only ever advances its own keys. Whole-snapshot persistence
// would otherwise resurrect buckets another tab has since edited or removed.
const mergingStorage = {
  getItem: (name: string) => typeof localStorage === "undefined" ? null : localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    if (typeof localStorage === "undefined") return
    const incoming = parsePersistedBuckets(value)
    if (!incoming) return localStorage.setItem(name, value)
    const stored = parsePersistedBuckets(localStorage.getItem(name))
    if (!stored) return localStorage.setItem(name, value)
    const merged = mergeDraftBuckets(incoming, stored)
    let rest: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(value) as { state?: Record<string, unknown>; version?: number }
      const { drafts: _d, attachmentDrafts: _a, draftRevisions: _r, attachmentDraftRevisions: _ar, ...stateRest } = parsed.state ?? {}
      rest = { ...parsed, state: stateRest }
    } catch { /* fall through to the canonical shape */ }
    localStorage.setItem(name, JSON.stringify({
      ...(rest as object),
      state: { ...(rest as { state?: object }).state, ...merged },
    }))
  },
  removeItem: (name: string) => { if (typeof localStorage !== "undefined") localStorage.removeItem(name) },
}

// Another tab's write never reaches this one through zustand. Adopt its keys
// revision by revision; this tab's own newer keys always survive the merge.
function listenForDraftWrites(setLocal: StoreApi<ChatInputState>["setState"]) {
  if (typeof window === "undefined") return
  window.addEventListener?.("storage", event => {
    if (event.key !== "chat-input-drafts" || !event.newValue) return
    const stored = parsePersistedBuckets(event.newValue)
    if (!stored) return
    setLocal(state => mergeDraftBuckets(state, stored))
  })
}

export const useChatInputStore = create<ChatInputState>()((setLocal, getLocal, api) => {
  // Use the setter outside persist for notifications. Persisting here would
  // replace unrelated drafts on disk with this tab's older snapshot.
  listenForDeletedUploads(setLocal)
  listenForDraftWrites(setLocal)
  return persist<ChatInputState>(
    (set, get) => ({
      drafts: {},
      attachmentDrafts: {},
      draftRevisions: {},
      attachmentDraftRevisions: {},

      setDraft: (chatId, value) =>
        set((state) => {
          if ((state.drafts[chatId] ?? "") === value) return state
          const draftRevisions = { ...state.draftRevisions, [chatId]: allocateRevision(chatId, state.draftRevisions[chatId], "draftRevisions") }
          if (!value) {
            const { [chatId]: _, ...rest } = state.drafts
            return { drafts: rest, draftRevisions }
          }
          return { drafts: { ...state.drafts, [chatId]: value }, draftRevisions }
        }),

      clearDraft: (chatId) => get().setDraft(chatId, ""),

      getDraft: (chatId) => get().drafts[chatId] ?? "",

      setAttachmentDrafts: (chatId, attachments, edited = false) =>
        set((state) => {
          if (!edited && sameAttachments(state.attachmentDrafts[chatId] ?? [], attachments)) return state
          const attachmentDraftRevisions = {
            ...state.attachmentDraftRevisions,
            [chatId]: allocateRevision(chatId, state.attachmentDraftRevisions[chatId], "attachmentDraftRevisions"),
          }
          if (attachments.length === 0) {
            const { [chatId]: _, ...rest } = state.attachmentDrafts
            return { attachmentDrafts: rest, attachmentDraftRevisions }
          }
          return {
            attachmentDraftRevisions,
            attachmentDrafts: {
              ...state.attachmentDrafts,
              [chatId]: attachments,
            },
          }
        }),

      clearAttachmentDrafts: (chatId) => get().setAttachmentDrafts(chatId, []),

      retireSubmittedAttachments: (key, submitted) => {
        // Match the physical upload, not the exact URL: rebinding only swaps the
        // project segment of contentUrl for the same file. An accepted send
        // consumed that file, and keeping the chip would invite a duplicate.
        const sent = new Map(submitted.map(item => [item.id, item]))
        const current = get().getAttachmentDrafts(key)
        const remaining = current.filter(item => {
          const accepted = sent.get(item.id)
          return !accepted || accepted.relativePath !== item.relativePath
            || accepted.absolutePath !== item.absolutePath || accepted.size !== item.size
        })
        if (remaining.length !== current.length) get().setAttachmentDrafts(key, remaining)
      },

      // A migration writes nobody's edits: resolve it against the latest
      // persisted snapshot, then mirror the same move inside this tab's memory.
      // Routing it through ordinary setters would persist this tab's stale
      // whole snapshot over unrelated keys other tabs have since replaced.
      migrateAttachmentDrafts: (sourceKey, targetKey, migrate) => {
        let persisted: { state?: { attachmentDrafts?: Record<string, ChatAttachment[]>; attachmentDraftRevisions?: Record<string, number> }; version?: number } | null = null
        try {
          const raw = localStorage.getItem("chat-input-drafts")
          if (raw) persisted = JSON.parse(raw)
        } catch { persisted = null }
        const storedDrafts = persisted?.state?.attachmentDrafts
        if (!storedDrafts) return false
        // Even with nothing left to move — another tab already migrated — the
        // composer must render the reconciled buckets, not this tab's stale
        // memory. Reconcile first, persist only when there is work to do.
        const reconcileMemory = () => setLocal(state => {
          const storedRevisionsNow = { ...(persisted?.state?.attachmentDraftRevisions ?? {}) }
          const attachmentDrafts = { ...state.attachmentDrafts }
          const attachmentDraftRevisions = { ...state.attachmentDraftRevisions }
          for (const key of [sourceKey, targetKey]) {
            const items = (storedDrafts[key] ?? []).filter(item => item.id !== state.lastDeletedUploadId)
            if (items.length) attachmentDrafts[key] = items
            else delete attachmentDrafts[key]
            if (storedRevisionsNow[key] !== undefined) attachmentDraftRevisions[key] = Math.max(attachmentDraftRevisions[key] ?? 0, storedRevisionsNow[key]!)
          }
          return { attachmentDrafts, attachmentDraftRevisions }
        })
        const applyMove = (
          drafts: Record<string, ChatAttachment[]>, revisions: Record<string, number>,
          source: ChatAttachment[], target: ChatAttachment[],
        ) => {
          const moved = migrate(source, target)
          if (!moved) return null
          const nextDrafts = { ...drafts }
          const nextRevisions = { ...revisions }
          if (moved.source.length) nextDrafts[sourceKey] = moved.source
          else delete nextDrafts[sourceKey]
          if (moved.target.length) nextDrafts[targetKey] = moved.target
          else delete nextDrafts[targetKey]
          if (!sameAttachments(source, moved.source)) nextRevisions[sourceKey] = (revisions[sourceKey] ?? 0) + 1
          if (!sameAttachments(target, moved.target)) nextRevisions[targetKey] = (revisions[targetKey] ?? 0) + 1
          return { attachmentDrafts: nextDrafts, attachmentDraftRevisions: nextRevisions }
        }
        const storedRevisions = { ...(persisted?.state?.attachmentDraftRevisions ?? {}) }
        const storedMove = applyMove({ ...storedDrafts }, storedRevisions, storedDrafts[sourceKey] ?? [], storedDrafts[targetKey] ?? [])
        if (!storedMove) {
          reconcileMemory()
          return false
        }
        try {
          const state = { ...(persisted?.state ?? {}), attachmentDrafts: storedMove.attachmentDrafts, attachmentDraftRevisions: storedMove.attachmentDraftRevisions }
          localStorage.setItem("chat-input-drafts", JSON.stringify({ ...(persisted ?? {}), state }))
        } catch { return false }
        // Mirror the persisted move in memory: memory can only lag storage
        // (writes persist synchronously), never lead it — except removal
        // notices mirrored without persisting, which the filter re-applies.
        setLocal(state => {
          const removedId = state.lastDeletedUploadId
          const mirror = (items: ChatAttachment[] | undefined) => {
            const filtered = (items ?? []).filter(item => item.id !== removedId)
            return filtered
          }
          const attachmentDrafts = { ...state.attachmentDrafts }
          const attachmentDraftRevisions = { ...state.attachmentDraftRevisions }
          for (const key of [sourceKey, targetKey]) {
            const next = mirror(storedMove.attachmentDrafts[key])
            if (next.length) attachmentDrafts[key] = next
            else delete attachmentDrafts[key]
            if (storedMove.attachmentDraftRevisions[key] !== undefined) attachmentDraftRevisions[key] = storedMove.attachmentDraftRevisions[key]!
          }
          return { attachmentDrafts, attachmentDraftRevisions }
        })
        return true
      },

      getAttachmentDrafts: (chatId) => get().attachmentDrafts[chatId] ?? [],

      getDraftRevision: (textKey, attachmentKey) => ({
        textKey,
        textRevision: textKey ? get().draftRevisions[textKey] ?? 0 : 0,
        attachmentKey,
        attachmentRevision: attachmentKey ? get().attachmentDraftRevisions[attachmentKey] ?? 0 : 0,
      }),

      clearSubmittedDraft: ({ textKey, textRevision, attachmentKey, attachmentRevision }) => {
        let cleared = false
        set((state) => {
          if ((textKey && (state.draftRevisions[textKey] ?? 0) !== textRevision)
            || (attachmentKey && (state.attachmentDraftRevisions[attachmentKey] ?? 0) !== attachmentRevision)) return state
          const drafts = { ...state.drafts }
          const attachmentDrafts = { ...state.attachmentDrafts }
          const draftRevisions = { ...state.draftRevisions }
          const attachmentDraftRevisions = { ...state.attachmentDraftRevisions }
          if (textKey) {
            delete drafts[textKey]
            draftRevisions[textKey] = allocateRevision(textKey, textRevision, "draftRevisions")
          }
          if (attachmentKey) {
            delete attachmentDrafts[attachmentKey]
            attachmentDraftRevisions[attachmentKey] = allocateRevision(attachmentKey, attachmentRevision, "attachmentDraftRevisions")
          }
          cleared = true
          return { drafts, attachmentDrafts, draftRevisions, attachmentDraftRevisions }
        })
        return cleared
      },
    }),
    {
      name: "chat-input-drafts",
      storage: createJSONStorage(() => mergingStorage),
    }
  )(setLocal, getLocal, api)
})
