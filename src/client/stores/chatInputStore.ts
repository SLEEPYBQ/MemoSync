import { create, type StoreApi } from "zustand"
import { persist } from "zustand/middleware"
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
  rebindAttachmentDrafts: (key: string, attachments: ChatAttachment[]) => void
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

export const useChatInputStore = create<ChatInputState>()((setLocal, getLocal, api) => {
  // Use the setter outside persist for notifications. Persisting here would
  // replace unrelated drafts on disk with this tab's older snapshot.
  listenForDeletedUploads(setLocal)
  return persist<ChatInputState>(
    (set, get) => ({
      drafts: {},
      attachmentDrafts: {},
      draftRevisions: {},
      attachmentDraftRevisions: {},

      setDraft: (chatId, value) =>
        set((state) => {
          if ((state.drafts[chatId] ?? "") === value) return state
          const draftRevisions = { ...state.draftRevisions, [chatId]: (state.draftRevisions[chatId] ?? 0) + 1 }
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
            [chatId]: (state.attachmentDraftRevisions[chatId] ?? 0) + 1,
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
        // An upload rebound to a new project URL belongs to that newer draft.
        const sent = new Map(submitted.map(item => [item.id, item.contentUrl]))
        const current = get().getAttachmentDrafts(key)
        const remaining = current.filter(item => sent.get(item.id) !== item.contentUrl)
        if (remaining.length !== current.length) get().setAttachmentDrafts(key, remaining)
      },

      rebindAttachmentDrafts: (key, attachments) =>
        set((state) => {
          const current = state.attachmentDrafts[key] ?? []
          if (sameAttachments(current, attachments)) return state
          const attachmentDrafts = { ...state.attachmentDrafts }
          if (attachments.length) attachmentDrafts[key] = attachments
          else delete attachmentDrafts[key]
          // URL rebinding is canonicalization, not a user edit. Keep the draft
          // revision stable so an in-flight acknowledgement remains valid.
          return { attachmentDrafts }
        }),

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
            draftRevisions[textKey] = textRevision + 1
          }
          if (attachmentKey) {
            delete attachmentDrafts[attachmentKey]
            attachmentDraftRevisions[attachmentKey] = attachmentRevision + 1
          }
          cleared = true
          return { drafts, attachmentDrafts, draftRevisions, attachmentDraftRevisions }
        })
        return cleared
      },
    }),
    {
      name: "chat-input-drafts",
    }
  )(setLocal, getLocal, api)
})
