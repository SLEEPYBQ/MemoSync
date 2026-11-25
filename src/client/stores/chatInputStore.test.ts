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

  test("canonical rebinding keeps the pending revision and lets the accepted send retire the chip", () => {
    const store = useChatInputStore.getState()
    const upload = (project: string) => ({
      id: "same-upload", kind: "file" as const, displayName: "notes.txt", absolutePath: "/fixture/notes.txt",
      relativePath: "notes.txt", contentUrl: `/api/projects/${project}/uploads/same-upload/content`, mimeType: "text/plain", size: 1,
    })
    store.setAttachmentDrafts("alpha", [upload("retired")])
    const before = store.getDraftRevision("landing", "alpha")
    store.rebindAttachmentDrafts("alpha", [upload("current")])
    expect(store.getDraftRevision("landing", "alpha")).toEqual(before)
    store.setDraft("landing", "edited while acknowledgement is pending")
    expect(store.clearSubmittedDraft(before)).toBe(false)
    store.retireSubmittedAttachments("alpha", [upload("current")])
    expect(store.getAttachmentDrafts("alpha")).toEqual([])
  })

  test("retires only references owned by the accepted landing send", () => {
    const store = useChatInputStore.getState()
    const upload = (id: string, project = "alpha") => ({
      id, kind: "file" as const, displayName: "notes.txt", absolutePath: "/fixture/notes.txt",
      relativePath: "notes.txt", contentUrl: `/api/projects/${project}/uploads/${id}/content`, mimeType: "text/plain", size: 1,
    })
    const sent = upload("sent")
    const later = upload("later") // a new upload with the same display name
    const rebound = upload("rebound", "new-alpha")
    store.setDraft("landing", "new text")
    store.setAttachmentDrafts("alpha", [sent, later, rebound])
    store.setAttachmentDrafts("beta", [later])
    store.retireSubmittedAttachments("alpha", [sent, upload("rebound")])
    expect(store.getDraft("landing")).toBe("new text")
    expect(store.getAttachmentDrafts("alpha")).toEqual([later, rebound])
    expect(store.getAttachmentDrafts("beta")).toEqual([later])
    const revision = store.getDraftRevision("landing", "alpha")
    store.retireSubmittedAttachments("alpha", [sent])
    expect(store.getDraftRevision("landing", "alpha")).toEqual(revision)
  })
})
