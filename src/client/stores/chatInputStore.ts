import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ChatAttachment } from "../../shared/types"

interface DraftRevision {
  textKey: string | null
  textRevision: number
  attachmentKey: string | null
  attachmentRevision: number
}

interface ChatInputState {
  drafts: Record<string, string>
  attachmentDrafts: Record<string, ChatAttachment[]>
  draftRevisions: Record<string, number>
  attachmentDraftRevisions: Record<string, number>
  setDraft: (chatId: string, value: string) => void
  clearDraft: (chatId: string) => void
  getDraft: (chatId: string) => string
  setAttachmentDrafts: (chatId: string, attachments: ChatAttachment[], edited?: boolean) => void
  clearAttachmentDrafts: (chatId: string) => void
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
  })
}

export const useChatInputStore = create<ChatInputState>()(
  persist(
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
  )
)
