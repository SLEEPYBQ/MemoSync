import { beforeEach, describe, expect, test } from "bun:test"
import { useChatInputStore } from "./chatInputStore"

describe("chatInputStore", () => {
  beforeEach(() => {
    useChatInputStore.setState({
      drafts: {},
      attachmentDrafts: {},
      draftRevisions: {},
      attachmentDraftRevisions: {},
    })
  })

  test("stores attachment drafts per chat", () => {
    useChatInputStore.getState().setAttachmentDrafts("chat-1", [{
      id: "attachment-1",
      kind: "image",
      displayName: "mock.png",
      absolutePath: "/tmp/project/.kanna/uploads/mock.png",
      relativePath: "./.kanna/uploads/mock.png",
      contentUrl: "/api/projects/project-1/uploads/mock.png/content",
      mimeType: "image/png",
      size: 512,
    }])

    expect(useChatInputStore.getState().getAttachmentDrafts("chat-1")).toHaveLength(1)
    expect(useChatInputStore.getState().getAttachmentDrafts("chat-2")).toEqual([])
  })

  test("clears attachment drafts for a chat", () => {
    useChatInputStore.getState().setAttachmentDrafts("chat-1", [{
      id: "attachment-1",
      kind: "file",
      displayName: "spec.pdf",
      absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
      relativePath: "./.kanna/uploads/spec.pdf",
      contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
      mimeType: "application/pdf",
      size: 1234,
    }])

    useChatInputStore.getState().clearAttachmentDrafts("chat-1")
    expect(useChatInputStore.getState().getAttachmentDrafts("chat-1")).toEqual([])
  })

  test("compares per-key revisions, ignoring no-op hydration writes", () => {
    const store = useChatInputStore.getState()
    store.setDraft("text-key", "submitted")
    store.setDraft("other-chat", "other draft")
    store.setAttachmentDrafts("chat-key", [{
      id: "file", kind: "file", displayName: "file.txt", absolutePath: "/file.txt",
      relativePath: "file.txt", contentUrl: "/files/file.txt", mimeType: "text/plain", size: 1,
    }])
    const revision = store.getDraftRevision("text-key", "chat-key")
    store.setDraft("text-key", "submitted")
    store.setAttachmentDrafts("chat-key", store.getAttachmentDrafts("chat-key").map((item) => ({ ...item })))
    expect(store.getDraftRevision("text-key", "chat-key")).toEqual(revision)
    expect(store.clearSubmittedDraft(revision)).toBe(true)
    expect(store.getDraft("text-key")).toBe("")
    expect(store.getAttachmentDrafts("chat-key")).toEqual([])
    expect(store.getDraft("other-chat")).toBe("other draft")
    expect(store.clearSubmittedDraft(revision)).toBe(false)
  })

  test("later text and pending-attachment revisions invalidate accepted submissions", () => {
    const store = useChatInputStore.getState()
    store.setDraft("chat", "submitted")
    const original = store.getDraftRevision("chat", "chat")
    store.setDraft("chat", "temporary")
    store.setDraft("chat", "submitted")
    expect(store.clearSubmittedDraft(original)).toBe(false)
    const edited = store.getDraftRevision("chat", "chat")
    store.setAttachmentDrafts("chat", [], true)
    expect(store.clearSubmittedDraft(edited)).toBe(false)
    expect(store.getDraft("chat")).toBe("submitted")
  })
})
