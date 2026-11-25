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

  test("retirement matches a rebound upload across project URLs", () => {
    const store = useChatInputStore.getState()
    const upload = (project: string) => ({
      id: "same-upload", kind: "file" as const, displayName: "notes.txt", absolutePath: "/fixture/notes.txt",
      relativePath: "notes.txt", contentUrl: `/api/projects/${project}/uploads/same-upload/content`, mimeType: "text/plain", size: 1,
    })
    // The workspace draft still holds the retired project's URL because rebinding
    // is memory-only. The accepted send used the rebound URL for the same file.
    store.setAttachmentDrafts("alpha", [upload("retired")])
    const before = store.getDraftRevision("landing", "alpha")
    store.setDraft("landing", "edited while acknowledgement is pending")
    expect(store.clearSubmittedDraft(before)).toBe(false)
    store.retireSubmittedAttachments("alpha", [upload("current")])
    expect(store.getAttachmentDrafts("alpha")).toEqual([])
  })

  test("retirement never matches a different physical file with a colliding id", () => {
    const store = useChatInputStore.getState()
    const upload = (path: string, project = "alpha") => ({
      id: "same-upload", kind: "file" as const, displayName: "notes.txt", absolutePath: path,
      relativePath: "notes.txt", contentUrl: `/api/projects/${project}/uploads/same-upload/content`, mimeType: "text/plain", size: 1,
    })
    store.setAttachmentDrafts("alpha", [upload("/fixture/other.txt")])
    store.retireSubmittedAttachments("alpha", [upload("/fixture/notes.txt")])
    expect(store.getAttachmentDrafts("alpha")).toHaveLength(1)
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
    // The rebound chip is the same physical file the send consumed, so it retires
    // even though its persisted URL still names the older project.
    expect(store.getAttachmentDrafts("alpha")).toEqual([later])
    expect(store.getAttachmentDrafts("beta")).toEqual([later])
    const revision = store.getDraftRevision("landing", "alpha")
    store.retireSubmittedAttachments("alpha", [sent])
    expect(store.getDraftRevision("landing", "alpha")).toEqual(revision)
  })

  test("migration merges against the persisted snapshot, not this tab's stale memory", () => {
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, String(value)),
      removeItem: (key: string) => void backing.delete(key),
    }
    ;(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage
    try {
      const movedUpload = {
        id: "legacy-upload", kind: "file" as const, displayName: "notes.txt",
        absolutePath: "/fixture/alpha/.memosync/uploads/notes.txt",
        relativePath: "./.memosync/uploads/notes.txt",
        contentUrl: "/api/projects/alpha/uploads/notes.txt/content", mimeType: "text/plain", size: 1,
      }
      // Another tab has since written a newer text draft and its own attachment;
      // this tab's memory never saw either write.
      backing.set("chat-input-drafts", JSON.stringify({
        state: {
          drafts: { "landing:path:/fixture/beta": "other tab's fresh text" },
          draftRevisions: { "landing:path:/fixture/beta": 3 },
          attachmentDrafts: {
            "landing:alpha": [movedUpload],
            "landing:path:/fixture/beta": [{ ...movedUpload, id: "beta-upload" }],
          },
          attachmentDraftRevisions: { "landing:alpha": 2, "landing:path:/fixture/beta": 4 },
        },
        version: 0,
      }))
      useChatInputStore.setState({ drafts: {}, attachmentDrafts: {}, draftRevisions: {}, attachmentDraftRevisions: {} })

      const store = useChatInputStore.getState()
      const migrated = store.migrateAttachmentDrafts("landing:alpha", "landing:path:/fixture/alpha", (legacy, target) => {
        if (!legacy.length) return null
        return { source: [], target: [...target, ...legacy] }
      })
      expect(migrated).toBe(true)

      const persisted = JSON.parse(backing.get("chat-input-drafts")!) as {
        state: {
          drafts: Record<string, string>
          attachmentDrafts: Record<string, Array<{ id: string }>>
          attachmentDraftRevisions: Record<string, number>
        }
      }
      // The migration rewrote only its own two keys; the other tab's text and
      // attachment survive even though this tab never had them in memory.
      expect(persisted.state.drafts["landing:path:/fixture/beta"]).toBe("other tab's fresh text")
      expect(persisted.state.attachmentDrafts["landing:path:/fixture/beta"]?.map(item => item.id)).toEqual(["beta-upload"])
      expect(persisted.state.attachmentDraftRevisions["landing:path:/fixture/beta"]).toBe(4)
      expect(persisted.state.attachmentDrafts["landing:alpha"]).toBeUndefined()
      expect(persisted.state.attachmentDrafts["landing:path:/fixture/alpha"]?.map(item => item.id)).toEqual(["legacy-upload"])

      // Memory mirrors the move so this composer's next edit builds on it.
      expect(useChatInputStore.getState().getAttachmentDrafts("landing:alpha")).toEqual([])
      expect(useChatInputStore.getState().getAttachmentDrafts("landing:path:/fixture/alpha").map(item => item.id)).toEqual(["legacy-upload"])

      // A second pass is a no-op: nothing left in the source bucket.
      expect(store.migrateAttachmentDrafts("landing:alpha", "landing:path:/fixture/alpha", (legacy, target) => {
        if (!legacy.length) return null
        return { source: [], target: [...target, ...legacy] }
      })).toBe(false)
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    }
  })

  test("a stale tab's text edit cannot revive replaced attachment buckets", () => {
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, String(value)),
      removeItem: (key: string) => void backing.delete(key),
    }
    ;(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage
    try {
      const upload = (id: string) => ({
        id, kind: "file" as const, displayName: `${id}.txt`, absolutePath: `/fixture/alpha/.memosync/uploads/${id}.txt`,
        relativePath: `./.memosync/uploads/${id}.txt`, contentUrl: `/api/projects/alpha/uploads/${id}.txt/content`,
        mimeType: "text/plain", size: 1,
      })
      // Disk is ahead: the migration already ran and another tab added a newer upload.
      backing.set("chat-input-drafts", JSON.stringify({
        state: {
          drafts: {},
          draftRevisions: {},
          attachmentDrafts: { "landing:path:/fixture/alpha": [upload("migrated"), upload("newer")] },
          attachmentDraftRevisions: { "landing:path:/fixture/alpha": 3, "landing:alpha": 2 },
        },
        version: 0,
      }))
      // This tab's memory is stale: it still holds the pre-migration legacy bucket.
      useChatInputStore.setState({
        drafts: {}, draftRevisions: {},
        attachmentDrafts: { "landing:alpha": [upload("migrated")] },
        attachmentDraftRevisions: { "landing:alpha": 1 },
      })
      // An ordinary text edit persists through the merge; the stale buckets lose.
      useChatInputStore.getState().setDraft("landing:path:/fixture/beta", "stale tab's text")
      const persisted = JSON.parse(backing.get("chat-input-drafts")!) as {
        state: { drafts: Record<string, string>; attachmentDrafts: Record<string, Array<{ id: string }>> }
      }
      expect(persisted.state.drafts["landing:path:/fixture/beta"]).toBe("stale tab's text")
      expect(persisted.state.attachmentDrafts["landing:path:/fixture/alpha"]?.map(item => item.id)).toEqual(["migrated", "newer"])
      expect(persisted.state.attachmentDrafts["landing:alpha"]).toBeUndefined()
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    }
  })

  test("a migration with nothing left to do still reconciles memory with the completed move", () => {
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, String(value)),
      removeItem: (key: string) => void backing.delete(key),
    }
    ;(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage
    try {
      const upload = {
        id: "migrated", kind: "file" as const, displayName: "notes.txt",
        absolutePath: "/fixture/alpha/.memosync/uploads/notes.txt",
        relativePath: "./.memosync/uploads/notes.txt",
        contentUrl: "/api/projects/alpha/uploads/notes.txt/content", mimeType: "text/plain", size: 1,
      }
      backing.set("chat-input-drafts", JSON.stringify({
        state: {
          drafts: {}, draftRevisions: {},
          attachmentDrafts: { "landing:path:/fixture/alpha": [upload] },
          attachmentDraftRevisions: { "landing:path:/fixture/alpha": 2 },
        },
        version: 0,
      }))
      useChatInputStore.setState({ drafts: {}, attachmentDrafts: {}, draftRevisions: {}, attachmentDraftRevisions: {} })
      const moved = useChatInputStore.getState().migrateAttachmentDrafts("landing:alpha", "landing:path:/fixture/alpha", (legacy, target) => {
        if (!legacy.length) return null
        return { source: [], target: [...target, ...legacy] }
      })
      expect(moved).toBe(false)
      expect(useChatInputStore.getState().getAttachmentDrafts("landing:path:/fixture/alpha").map(item => item.id)).toEqual(["migrated"])
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    }
  })

  test("a fresh edit in a lagging tab allocates above the persisted revision and survives the merge", () => {
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, String(value)),
      removeItem: (key: string) => void backing.delete(key),
    }
    ;(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage
    try {
      backing.set("chat-input-drafts", JSON.stringify({
        state: {
          drafts: { "landing:alpha": "ten edits from another tab" },
          draftRevisions: { "landing:alpha": 10 },
          attachmentDrafts: {}, attachmentDraftRevisions: {},
        },
        version: 0,
      }))
      // This tab never saw those edits: memory is empty, revision 0.
      useChatInputStore.setState({ drafts: {}, attachmentDrafts: {}, draftRevisions: {}, attachmentDraftRevisions: {} })
      useChatInputStore.getState().setDraft("landing:alpha", "fresh local text")
      const persisted = JSON.parse(backing.get("chat-input-drafts")!) as {
        state: { drafts: Record<string, string>; draftRevisions: Record<string, number> }
      }
      expect(persisted.state.drafts["landing:alpha"]).toBe("fresh local text")
      expect(persisted.state.draftRevisions["landing:alpha"]).toBeGreaterThan(10)
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    }
  })

  test("a send acknowledgment never erases newer edits it has not seen", () => {
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, String(value)),
      removeItem: (key: string) => void backing.delete(key),
    }
    ;(globalThis as unknown as { localStorage: typeof storage }).localStorage = storage
    try {
      useChatInputStore.setState({ drafts: {}, attachmentDrafts: {}, draftRevisions: {}, attachmentDraftRevisions: {} })
      // This tab typed and submitted at revision 1.
      useChatInputStore.getState().setDraft("landing:alpha", "submitted text")
      const captured = useChatInputStore.getState().getDraftRevision("landing:alpha", null)
      // Before the acknowledgment, another tab's newer edit reached storage but not memory.
      const persisted = JSON.parse(backing.get("chat-input-drafts")!)
      persisted.state.drafts["landing:alpha"] = "submitted text plus newer edits"
      persisted.state.draftRevisions["landing:alpha"] = 2
      backing.set("chat-input-drafts", JSON.stringify(persisted))
      expect(useChatInputStore.getState().clearSubmittedDraft(captured)).toBe(false)
      expect((JSON.parse(backing.get("chat-input-drafts")!) as { state: { drafts: Record<string, string> } }).state.drafts["landing:alpha"]).toBe("submitted text plus newer edits")
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    }
  })
})
