import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../../shared/types"
import { MemoryService } from "./index"
import {
  createMemoryBoardBacklogService,
  type MemoryBoardResolution,
} from "./board-backlog"
import {
  captureContainedAttachment,
  createStudyOpeningAttachmentSnapshotStore,
  type StudyOpeningAttachmentSnapshotStore,
} from "../study-opening-attachments"

function entry(value: Record<string, unknown>, createdAt: number): TranscriptEntry {
  return { _id: `message-${createdAt}`, createdAt, ...value } as TranscriptEntry
}

function transferGate(input: {
  gateId: string
  sourceId: string
  decision: "handled" | "skipped"
  createdAt: number
  openingReviewId?: string
}): TranscriptEntry[] {
  return [
    entry({
      kind: "memory_transfer",
      transferId: input.gateId,
      suggestions: [],
      pending: true,
      turn: input.createdAt,
      ...(input.openingReviewId ? { openingReviewId: input.openingReviewId } : {}),
    }, input.createdAt),
    entry({
      kind: "memory_transfer_result",
      transferId: input.gateId,
      done: true,
      suggestions: [{
        sourceId: input.sourceId,
        sourceContent: "Use high contrast",
        sourceScope: "project",
        sourceVersion: 1,
        sourceLabel: "Prior project",
        content: "Use high contrast in this project",
        suggestedScope: "project",
        landing: { route: "new" },
      }],
    }, input.createdAt + 1),
    entry({
      kind: "memory_transfer_decision",
      transferId: input.gateId,
      decision: input.decision,
    }, input.createdAt + 2),
  ]
}

function checkupGate(input: {
  gateId: string
  decision: "handled" | "skipped"
  createdAt: number
  suggestions?: Array<Record<string, unknown>>
  openingReviewId?: string
}): TranscriptEntry[] {
  return [
    entry({
      kind: "memory_checkup",
      checkupId: input.gateId,
      pending: true,
      turn: input.createdAt,
      ...(input.openingReviewId ? { openingReviewId: input.openingReviewId } : {}),
    }, input.createdAt),
    entry({
      kind: "memory_checkup_result",
      checkupId: input.gateId,
      suggestions: input.suggestions ?? [
        { kind: "conflict", memoryId: "M-03", otherMemoryId: "M-04", reason: "Cannot both apply" },
        { kind: "promotion", memoryId: "M-05", reason: "Retired receipt" },
      ],
    }, input.createdAt + 1),
    entry({ kind: "memory_checkup_decision", checkupId: input.gateId, decision: input.decision }, input.createdAt + 2),
  ]
}

function harness(
  chats: Record<string, { projectId: string; messages: TranscriptEntry[] }>,
  options?: {
    assignedProjectIds?: string[]
    currentTaskId?: string
    projectIdForTask?: (taskId: string) => string | null
    openingAttachmentSnapshots?: StudyOpeningAttachmentSnapshotStore
  },
) {
  const kv = new Map<string, unknown>()
  const items = new Map<string, {
    id: string
    status: string
    version: number
    createdAt: string
    content?: string
    scope?: string
    projectId?: string
    sessionId?: string
  }>([
    ["M-01", { id: "M-01", status: "active", version: 1, content: "Keep checkout accessible", createdAt: new Date(0).toISOString() }],
    ["M-03", { id: "M-03", status: "active", version: 1, content: "Use metric units", createdAt: new Date(0).toISOString() }],
    ["M-04", { id: "M-04", status: "active", version: 1, content: "Show metric labels", createdAt: new Date(0).toISOString() }],
  ])
  const events = new Map<string, Array<{ ts: string; kind: string }>>()
  const relations = new Map<string, Array<{ type: string; targetId: string }>>()
  const openRevisions = new Set<string>()
  const transcript = {
    listChats: () => Object.entries(chats).map(([id, chat]) => ({ id, projectId: chat.projectId })),
    getMessages: (chatId: string) => chats[chatId]?.messages ?? [],
    getChat: (chatId: string) => chats[chatId] ? { projectId: chats[chatId]!.projectId } : null,
  }
  const receiptStore = {
    getKv: <T,>(key: string) => (kv.get(key) as T | undefined) ?? null,
    setKv: (key: string, value: unknown) => { kv.set(key, value) },
    setKvBatch: (entries: ReadonlyArray<readonly [string, unknown]>) => {
      for (const [key, value] of entries) kv.set(key, value)
    },
  }
  const create = () => createMemoryBoardBacklogService({
    transcript,
    receiptStore,
    memoryState: {
      getById: (id: string) => items.get(id) ?? null,
      getEvents: (id: string) => events.get(id) ?? [],
      list: () => [...items.values()],
      getRelations: (id: string) => relations.get(id) ?? [],
      hasOpenRevision: (id: string) => openRevisions.has(id),
    },
    assignedProjectIds: () => new Set(options?.assignedProjectIds ?? ["assigned-project"]),
    ...(options?.currentTaskId ? { currentTaskId: () => options.currentTaskId! } : {}),
    ...(options?.projectIdForTask ? { projectIdForTask: options.projectIdForTask } : {}),
    ...(options?.openingAttachmentSnapshots
      ? { openingAttachmentSnapshots: options.openingAttachmentSnapshots }
      : {}),
  })
  return { create, kv, items, events, relations, openRevisions }
}

describe("Memory Board durable skipped backlog", () => {
  test("projects skipped Transfer and Checkup rows from assigned-chat transcripts after live gates are gone", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [
          ...transferGate({ gateId: "transfer-1", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
          ...checkupGate({ gateId: "checkup-1", decision: "skipped", createdAt: 20 }),
        ],
      },
      "unassigned-chat": {
        projectId: "personal-project",
        messages: transferGate({ gateId: "transfer-private", sourceId: "M-99", decision: "skipped", createdAt: 30 }),
      },
    })

    const snapshot = h.create().snapshot()

    expect(snapshot.transfers).toHaveLength(1)
    expect(snapshot.transfers[0]).toMatchObject({
      chatId: "assigned-chat",
      projectId: "assigned-project",
      gateId: "transfer-1",
      unresolved: 1,
      message: { kind: "memory_transfer", pending: false, suggestions: [{ sourceId: "M-01" }] },
    })
    expect(snapshot.checkups).toHaveLength(1)
    expect(snapshot.checkups[0]).toMatchObject({
      gateId: "checkup-1",
      unresolved: 1,
      message: { kind: "memory_checkup", pending: false, suggestions: [{ kind: "conflict" }] },
    })
  })

  test("folds repeated semantic rows so a later handled gate clears an older skip", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [
          ...transferGate({ gateId: "transfer-old", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
          ...transferGate({ gateId: "transfer-new", sourceId: "M-01", decision: "handled", createdAt: 20 }),
          ...checkupGate({ gateId: "checkup-old", decision: "skipped", createdAt: 30 }),
          ...checkupGate({ gateId: "checkup-new", decision: "handled", createdAt: 40 }),
        ],
      },
    })

    expect(h.create().snapshot()).toEqual({ transfers: [], checkups: [] })
  })

  test("persists a line-level Board resolution across service restart without hiding a later skip", () => {
    const chats = {
      "assigned-chat": {
        projectId: "assigned-project",
        messages: transferGate({ gateId: "transfer-1", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
      },
    }
    const h = harness(chats)
    const resolution: MemoryBoardResolution = {
      taskId: "038-S1",
      kind: "transfer",
      chatId: "assigned-chat",
      gateId: "transfer-1",
      sourceId: "M-01",
    }

    h.create().assertPending(resolution)
    h.create().resolve(resolution)
    expect(h.create().snapshot()).toEqual({ transfers: [], checkups: [] })

    chats["assigned-chat"].messages.push(
      ...transferGate({ gateId: "transfer-2", sourceId: "M-01", decision: "skipped", createdAt: 30 }),
    )
    expect(h.create().snapshot().transfers[0]).toMatchObject({ gateId: "transfer-2", unresolved: 1 })
  })

  test("rejects a forged Board resolution that is not a currently pending transcript row", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: transferGate({ gateId: "transfer-1", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
      },
    })

    expect(() => h.create().assertPending({
      taskId: "038-S1",
      kind: "transfer",
      chatId: "assigned-chat",
      gateId: "transfer-1",
      sourceId: "M-02",
    })).toThrow("not a pending Board row")
  })

  test("returns the transcript-owned Transfer snapshot and destination for action authorization", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: transferGate({ gateId: "transfer-1", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
      },
    })

    expect(h.create().assertTransferPending({
      taskId: "038-S1",
      kind: "transfer",
      chatId: "assigned-chat",
      gateId: "transfer-1",
      sourceId: "M-01",
    })).toEqual({
      pending: true,
      trusted: {
        chatId: "assigned-chat",
        projectId: "assigned-project",
        destinationContextKey: "assigned-project",
        suggestion: expect.objectContaining({
          sourceId: "M-01",
          sourceVersion: 1,
          content: "Use high contrast in this project",
          landing: { route: "new" },
        }),
      },
    })
  })

  test("keeps prompt admission closed until an empty Board review is durably completed once", () => {
    const h = harness({})
    h.items.set("M-candidate", { id: "M-candidate", status: "candidate", version: 1, createdAt: new Date(0).toISOString() })
    const service = h.create()

    expect(service.promptRefusal("038-S1")).toContain("1 pending memory item")
    expect(service.completeReview("038-S1")).toMatchObject({
      completed: false,
      state: { reviewed: false, pending: { candidates: 1, total: 1 } },
    })

    h.items.set("M-candidate", { id: "M-candidate", status: "active", version: 1, createdAt: new Date(0).toISOString() })
    expect(service.completeReview("038-S1")).toMatchObject({
      completed: true,
      state: { reviewed: true, pending: { total: 0 } },
    })
    h.items.set("M-later", { id: "M-later", status: "candidate", version: 1, createdAt: new Date(0).toISOString() })
    expect(h.create().promptRefusal("038-S1")).toBeNull()
  })

  test("claims exactly one current first prompt before opening-Board review can release it", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [],
      },
    })
    const service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-1",
      content: "Remember to keep the booking flow accessible",
      attachments: [{
        id: "attachment-1",
        displayName: "requirements.md",
        relativePath: ".kanna/uploads/requirements.md",
        absolutePath: "/workspace/.kanna/uploads/requirements.md",
        contentUrl: "/api/attachments/attachment-1",
        mimeType: "text/markdown",
        size: 42,
        kind: "file",
      }],
      dispatch: {
        provider: "claude",
        model: "claude-opus-4-1",
        modelOptions: { claude: { reasoningEffort: "max", contextWindow: "1m" } },
        planMode: true,
      },
    }

    const first = service.prepareOpeningPrompt(input)
    const retry = service.prepareOpeningPrompt(input)

    expect(retry).toEqual(first)
    expect(first).toMatchObject({
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-1",
      phase: "dispatch_pending",
    })
    expect(service.reviewState("038-S1")).toMatchObject({
      reviewed: true,
      openingPrompt: {
        reviewId: "opening-review-1",
        chatId: "assigned-chat",
        phase: "dispatch_pending",
      },
    })
    expect(service.promptRefusal("038-S1", {
      ...input,
      channel: "chat.send",
    })).toBeNull()
    expect(service.promptRefusal("038-S1", {
      ...input,
      chatId: "another-chat",
      channel: "chat.send",
    })).toContain("waiting first message")
    expect(service.promptRefusal("038-S1", {
      ...input,
      channel: "message.enqueue",
    })).toContain("waiting first message")
    expect(service.promptRefusal("038-S1", {
      ...input,
      attachments: [{ ...input.attachments[0], size: 43 }],
      channel: "chat.send",
    })).toContain("waiting first message")
    expect(() => service.prepareOpeningPrompt({
      ...input,
      content: "A different message",
    })).toThrow(/different first message/i)

    const restarted = h.create() as any
    expect(restarted.recoverOpeningPrompt("038-S1")).toMatchObject({
      taskId: input.taskId,
      chatId: input.chatId,
      reviewId: input.reviewId,
      content: input.content,
      attachments: input.attachments,
      dispatch: input.dispatch,
      phase: "dispatch_pending",
    })
    expect(restarted.reviewState("038-S1")).not.toHaveProperty("content")
    expect(restarted.reviewState("038-S1").openingPrompt).not.toHaveProperty("attachments")
  })

  test("recovers only verified immutable attachment paths and fails closed after snapshot corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-opening-attachment-"))
    const projectRoot = join(dir, "project")
    const sourcePath = join(projectRoot, "request.txt")
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(sourcePath, "original notes")
    const snapshots = createStudyOpeningAttachmentSnapshotStore(join(dir, "server-data", "opening-attachments"))
    const originalAttachment = {
      id: "attachment-immutable",
      kind: "file" as const,
      displayName: "request.txt",
      absolutePath: sourcePath,
      relativePath: "./.memosync/uploads/request.txt",
      contentUrl: "/api/projects/assigned-project/uploads/request.txt/content",
      mimeType: "text/plain",
      size: 14,
    }
    const attachmentSnapshots = snapshots.persist(
      "opening-review-immutable",
      [captureContainedAttachment(projectRoot, originalAttachment)!],
    )
    const h = harness({
      "assigned-chat": { projectId: "assigned-project", messages: [] },
    }, { openingAttachmentSnapshots: snapshots })
    const opening = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-immutable",
      content: "",
      attachments: [originalAttachment],
      attachmentSnapshots,
    }
    try {
      h.create().prepareOpeningPrompt(opening)
      writeFileSync(sourcePath, "replaced notes")

      const restarted = h.create()
      const recovered = restarted.recoverOpeningPrompt(opening.taskId)!
      expect(recovered.attachments).toEqual([originalAttachment])
      expect(recovered.providerAttachments[0]!.absolutePath).not.toBe(sourcePath)
      expect(recovered.providerAttachments[0]!.relativePath).not.toContain(originalAttachment.relativePath)
      expect(readFileSync(recovered.providerAttachments[0]!.absolutePath, "utf8")).toBe("original notes")
      expect(restarted.promptRefusal(opening.taskId, {
        ...opening,
        attachments: recovered.providerAttachments,
        channel: "chat.send",
      })).toBeNull()

      chmodSync(attachmentSnapshots[0]!.snapshotPath, 0o600)
      writeFileSync(attachmentSnapshots[0]!.snapshotPath, "corrupt! bytes")
      expect(h.create().recoverOpeningPrompt(opening.taskId)).toMatchObject({
        providerAttachments: [],
        attachmentFailure: expect.stringContaining("digest"),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects another assigned project's chat before it can own the active task opening claim", () => {
    const h = harness({
      "active-chat": { projectId: "project-038", messages: [] },
      "other-assigned-chat": { projectId: "project-098", messages: [] },
    }, {
      assignedProjectIds: ["project-038", "project-098"],
      currentTaskId: "038-S2",
      projectIdForTask: (taskId) => taskId.startsWith("038-") ? "project-038" : "project-098",
    })
    const service = h.create() as any

    expect(() => service.prepareOpeningPrompt({
      taskId: "038-S2",
      chatId: "other-assigned-chat",
      reviewId: "wrong-project-review",
      content: "This prompt belongs to the other assigned project",
      attachments: [],
    })).toThrow(/active study project/i)
    expect(h.kv.size).toBe(0)

    expect(service.prepareOpeningPrompt({
      taskId: "038-S2",
      chatId: "active-chat",
      reviewId: "correct-project-review",
      content: "This prompt belongs to the active project",
      attachments: [],
    })).toMatchObject({
      taskId: "038-S2",
      chatId: "active-chat",
      reviewId: "correct-project-review",
      phase: "dispatch_pending",
    })
  })

  test("releases a prepared prompt only after its full Long-term review is durably ready and continued", async () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [],
      },
    })
    const service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-1",
      content: "Remember to keep the booking flow accessible",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)

    expect(service.claimOpeningPromptDispatch(input)).toBe("claimed")
    expect(service.claimOpeningPromptDispatch(input)).toBe("duplicate")
    let released = false
    const waiting = service.waitForOpeningPromptCompletion(prepared)
      .then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)

    service.markOpeningPromptLongTermReady(prepared)
    await Promise.resolve()
    expect(released).toBe(false)
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: true,
      state: {
        openingPrompt: { phase: "completed" },
        pending: { total: 0 },
      },
    })
    await waiting
    expect(released).toBe(true)
  })

  test("releases an opening review after its current Candidate gate explicitly skips unchanged candidates", async () => {
    const chats = {
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [] as TranscriptEntry[],
      },
    }
    const h = harness(chats)
    let service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-skipped-candidate",
      content: "Remember that checkout must stay keyboard accessible",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)
    service.claimOpeningPromptDispatch(input)
    h.items.set("M-skipped", {
      id: "M-skipped",
      status: "candidate",
      version: 1,
      content: "Keep checkout keyboard accessible",
      scope: "session",
      sessionId: "assigned-chat",
      createdAt: new Date(1).toISOString(),
    })
    chats["assigned-chat"].messages.push({
      _id: "proposal-parent",
      createdAt: 2,
      kind: "memory_proposals",
      proposalsId: "proposal-skip-1",
      openingReviewId: input.reviewId,
      candidates: [],
      pending: true,
    } as any, {
      _id: "proposal-result",
      createdAt: 3,
      kind: "memory_proposals_result",
      proposalsId: "proposal-skip-1",
      candidates: [{ id: "M-skipped" }],
    } as any, {
      _id: "proposal-decision",
      createdAt: 4,
      kind: "memory_proposals_decision",
      proposalsId: "proposal-skip-1",
      decision: "skipped",
    } as any)

    service.markOpeningPromptLongTermReady(prepared)
    service = h.create() as any

    expect(service.reviewState(input.taskId)).toMatchObject({
      openingPrompt: { phase: "long_term_ready" },
      pending: { candidates: 0, total: 0 },
    })
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: true,
      state: { openingPrompt: { phase: "completed" }, pending: { total: 0 } },
    })
  })

  test("releases an opening review after its own exact Transfer and Checkup occurrences are skipped", () => {
    const chats = {
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [] as TranscriptEntry[],
      },
    }
    const h = harness(chats)
    const service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-deferred-backlog",
      content: "Build the apartment search page",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)
    service.claimOpeningPromptDispatch(input)
    chats["assigned-chat"].messages.push(
      ...transferGate({
        gateId: "opening-transfer-skip",
        sourceId: "M-01",
        decision: "skipped",
        createdAt: 10,
        openingReviewId: input.reviewId,
      }),
      ...checkupGate({
        gateId: "opening-checkup-skip",
        decision: "skipped",
        createdAt: 20,
        openingReviewId: input.reviewId,
      }),
    )

    service.markOpeningPromptLongTermReady(prepared)

    expect(h.kv.get("opening_prompt_review:v1:038-S1")).toMatchObject({
      deferredBacklogRows: [
        {
          semanticKey: "transfer:assigned-project:M-01",
          chatId: "assigned-chat",
          gateId: "opening-transfer-skip",
          occurrenceAt: 12,
        },
        {
          semanticKey: "checkup:conflict:M-03:M-04",
          chatId: "assigned-chat",
          gateId: "opening-checkup-skip",
          occurrenceAt: 22,
        },
      ],
    })
    expect(service.reviewState(input.taskId)).toMatchObject({
      openingPrompt: { phase: "long_term_ready" },
      pending: { transfers: 0, checkups: 0, total: 0 },
    })
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: true,
      state: { openingPrompt: { phase: "completed" }, pending: { total: 0 } },
    })

    // The exemption belongs only to this opening task. The same skipped
    // occurrences remain ordinary backlog for the next task.
    expect(service.reviewState("038-S2")).toMatchObject({
      pending: { transfers: 1, checkups: 1, total: 2 },
    })
  })

  test("does not exempt a later skip of the same semantic key from a subsequent per-turn gate", () => {
    const chats = {
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [] as TranscriptEntry[],
      },
    }
    const h = harness(chats)
    const service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-later-skip",
      content: "Build the apartment search page",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)
    service.claimOpeningPromptDispatch(input)
    chats["assigned-chat"].messages.push(...checkupGate({
      gateId: "opening-checkup-skip",
      decision: "skipped",
      createdAt: 10,
      openingReviewId: input.reviewId,
    }))
    service.markOpeningPromptLongTermReady(prepared)
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({ completed: true })

    // A later ordinary turn in the same chat skips the same pair again. That is
    // a new occurrence: it owes the next opening a review and is not exempt.
    chats["assigned-chat"].messages.push(...checkupGate({
      gateId: "later-turn-checkup",
      decision: "skipped",
      createdAt: 100,
    }))
    expect(service.reviewState(input.taskId)).toMatchObject({
      pending: { checkups: 1, total: 1 },
    })
    expect(service.reviewState("038-S2")).toMatchObject({
      pending: { checkups: 1, total: 1 },
    })
  })

  test("does not let an opening exemption hide another gate with the same semantic key and timestamp", () => {
    const chats = {
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [] as TranscriptEntry[],
      },
      "external-chat": {
        projectId: "assigned-project",
        messages: [] as TranscriptEntry[],
      },
    }
    const h = harness(chats)
    const service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-old-occurrence",
      content: "Build the apartment search page",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)
    service.claimOpeningPromptDispatch(input)
    chats["assigned-chat"].messages.push(...checkupGate({
      gateId: "opening-checkup-old",
      decision: "skipped",
      createdAt: 10,
      openingReviewId: input.reviewId,
    }))
    service.markOpeningPromptLongTermReady(prepared)

    chats["external-chat"].messages.push(...checkupGate({
      gateId: "external-checkup-new",
      decision: "skipped",
      // Deliberately collide with the opening gate's millisecond timestamp.
      createdAt: 10,
    }))

    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: false,
      state: {
        openingPrompt: { phase: "preparing" },
        pending: { checkups: 1, total: 1 },
      },
    })
  })

  test("does not let a current Candidate skip hide a new or changed external candidate", async () => {
    const chats = {
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [] as TranscriptEntry[],
      },
    }
    const h = harness(chats)
    const service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-skip-cas",
      content: "Remember the accessible checkout rule",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)
    service.claimOpeningPromptDispatch(input)
    h.items.set("M-skipped", {
      id: "M-skipped",
      status: "candidate",
      version: 1,
      content: "Keep checkout keyboard accessible",
      createdAt: new Date(1).toISOString(),
    })
    chats["assigned-chat"].messages.push({
      _id: "proposal-parent-cas",
      createdAt: 2,
      kind: "memory_proposals",
      proposalsId: "proposal-skip-cas",
      openingReviewId: input.reviewId,
      candidates: [],
      pending: true,
    } as any, {
      _id: "proposal-result-cas",
      createdAt: 3,
      kind: "memory_proposals_result",
      proposalsId: "proposal-skip-cas",
      candidates: [{ id: "M-skipped" }],
    } as any, {
      _id: "proposal-decision-cas",
      createdAt: 4,
      kind: "memory_proposals_decision",
      proposalsId: "proposal-skip-cas",
      decision: "skipped",
    } as any)
    service.markOpeningPromptLongTermReady(prepared)

    h.items.set("M-external", {
      id: "M-external",
      status: "candidate",
      version: 1,
      content: "An unrelated candidate arrived later",
      createdAt: new Date(5).toISOString(),
    })
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: false,
      state: { openingPrompt: { phase: "preparing" }, pending: { candidates: 2 } },
    })
  })

  test("invalidates a Long-term-ready CAS after an active edit, new memory, or undo changes the current pool", async () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [],
      },
    })
    let service = h.create() as any
    const input = {
      taskId: "038-S1",
      chatId: "assigned-chat",
      reviewId: "opening-review-cas",
      content: "Build the booking flow",
      attachments: [],
    }
    const prepared = service.prepareOpeningPrompt(input)
    service.claimOpeningPromptDispatch(input)

    service.markOpeningPromptLongTermReady(prepared)
    const firstWait = service.waitForOpeningPromptCompletion(prepared)
    h.items.set("M-01", { ...h.items.get("M-01")!, version: 2, content: "Keep every booking step keyboard accessible" })
    h.items.set("M-09", {
      id: "M-09",
      status: "active",
      version: 1,
      content: "Use clear cancellation copy",
      createdAt: new Date(1).toISOString(),
    })
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: false,
      state: { openingPrompt: { phase: "preparing" } },
    })
    await expect(firstWait).resolves.toBe("invalidated")
    service = h.create() as any
    expect(service.recoverOpeningPrompt(input.taskId)).toMatchObject({
      phase: "preparing",
      longTermRevision: 1,
    })

    service.markOpeningPromptLongTermReady(prepared)
    const undoWait = service.waitForOpeningPromptCompletion(prepared)
    h.items.set("M-09", { ...h.items.get("M-09")!, status: "candidate", version: 2 })
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: false,
      state: { openingPrompt: { phase: "preparing" }, pending: { candidates: 1 } },
    })
    await expect(undoWait).resolves.toBe("invalidated")

    h.items.set("M-09", { ...h.items.get("M-09")!, status: "active", version: 3 })
    service.markOpeningPromptLongTermReady(prepared)
    expect(service.completeOpeningPromptReview(prepared)).toMatchObject({
      completed: true,
      state: { openingPrompt: { phase: "completed" } },
    })
  })

  test("does not treat passive trace verdicts as freshness for a skipped Staleness row", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: checkupGate({
          gateId: "staleness-1",
          decision: "skipped",
          createdAt: 10,
          suggestions: [{ kind: "staleness", memoryId: "M-03", reason: "May have expired" }],
        }),
      },
    })
    h.events.set("M-03", [{ ts: new Date(50).toISOString(), kind: "trace" }])

    expect(h.create().snapshot().checkups).toHaveLength(1)

    h.events.get("M-03")!.push({ ts: new Date(60).toISOString(), kind: "use" })
    expect(h.create().snapshot()).toEqual({ transfers: [], checkups: [] })
    expect([...h.kv.values()]).toContainEqual(expect.objectContaining({
      outcome: "invalidated",
      reason: "memory_freshened",
    }))
  })

  test("ignores old or inactive derived_from rows when recovering a Transfer crash", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: transferGate({ gateId: "transfer-1", sourceId: "M-01", decision: "skipped", createdAt: 100 }),
      },
    })
    h.items.set("M-old", {
      id: "M-old",
      status: "active",
      version: 1,
      createdAt: new Date(50).toISOString(),
      scope: "project",
      projectId: "assigned-project",
    })
    h.items.set("M-inactive", {
      id: "M-inactive",
      status: "archived",
      version: 1,
      createdAt: new Date(150).toISOString(),
      scope: "project",
      projectId: "assigned-project",
    })
    h.relations.set("M-old", [{ type: "derived_from", targetId: "M-01" }])
    h.relations.set("M-inactive", [{ type: "derived_from", targetId: "M-01" }])

    expect(h.create().snapshot().transfers).toHaveLength(1)
    expect([...h.kv.values()]).toEqual([])
  })

  test("recovers a post-skip Transfer crash even when the participant chose another allowed scope", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: transferGate({ gateId: "transfer-1", sourceId: "M-01", decision: "skipped", createdAt: 100 }),
      },
    })
    h.items.set("M-personal-result", {
      id: "M-personal-result",
      status: "active",
      version: 1,
      createdAt: new Date(150).toISOString(),
      scope: "personal",
    })
    h.relations.set("M-personal-result", [{ type: "derived_from", targetId: "M-01" }])

    expect(h.create().assertTransferPending({
      taskId: "038-S2",
      kind: "transfer",
      chatId: "assigned-chat",
      gateId: "transfer-1",
      sourceId: "M-01",
    })).toEqual({ pending: false, resultId: "M-personal-result" })
    expect([...h.kv.values()]).toContainEqual(expect.objectContaining({
      outcome: "invalidated",
      reason: "source_already_transferred",
      resultId: "M-personal-result",
    }))
  })

  test("invalidates pair Checkups for any detector-excluding relation and Staleness for an open revision", () => {
    const pair = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [
          ...checkupGate({
            gateId: "conflict-1",
            decision: "skipped",
            createdAt: 10,
            suggestions: [{ kind: "conflict", memoryId: "M-03", otherMemoryId: "M-04", reason: "Cannot both apply" }],
          }),
          ...checkupGate({
            gateId: "redundancy-1",
            decision: "skipped",
            createdAt: 20,
            suggestions: [{ kind: "redundancy", memoryId: "M-03", otherMemoryId: "M-04", reason: "Same rule" }],
          }),
        ],
      },
    })
    pair.relations.set("M-03", [{ type: "conflicts_with", targetId: "M-04" }])
    expect(pair.create().snapshot()).toEqual({ transfers: [], checkups: [] })
    expect([...pair.kv.values()].filter((value) => (
      value as { reason?: string }
    ).reason === "pair_already_related")).toHaveLength(2)

    const stale = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: checkupGate({
          gateId: "staleness-1",
          decision: "skipped",
          createdAt: 30,
          suggestions: [{ kind: "staleness", memoryId: "M-03", reason: "May have expired" }],
        }),
      },
    })
    stale.openRevisions.add("M-03")
    expect(stale.create().snapshot()).toEqual({ transfers: [], checkups: [] })
    expect([...stale.kv.values()]).toContainEqual(expect.objectContaining({
      outcome: "invalidated",
      reason: "revision_open",
    }))
  })

  test("durably invalidates transcript rows whose source or checked memory can no longer execute", () => {
    const h = harness({
      "assigned-chat": {
        projectId: "assigned-project",
        messages: [
          ...transferGate({ gateId: "transfer-stale", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
          ...checkupGate({ gateId: "checkup-stale", decision: "skipped", createdAt: 20 }),
        ],
      },
    })
    h.items.set("M-01", { id: "M-01", status: "active", version: 2, createdAt: new Date(0).toISOString() })
    h.items.set("M-04", { id: "M-04", status: "archived", version: 1, createdAt: new Date(0).toISOString() })

    expect(h.create().snapshot()).toEqual({ transfers: [], checkups: [] })
    expect([...h.kv.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "invalidated", reason: "source_version_changed" }),
      expect.objectContaining({ outcome: "invalidated", reason: "memory_not_active" }),
    ]))
    expect(h.create().snapshot()).toEqual({ transfers: [], checkups: [] })
  })

  test("recovers mutation-before-receipt as idempotent success after a real MemoryStore restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-board-restart-"))
    const dbPath = join(dir, "memory.sqlite")
    const messages = [
      ...transferGate({ gateId: "transfer-crash", sourceId: "M-01", decision: "skipped", createdAt: 10 }),
      ...checkupGate({ gateId: "checkup-crash", decision: "skipped", createdAt: 20 }),
      ...transferGate({ gateId: "transfer-scope-crash", sourceId: "M-02", decision: "skipped", createdAt: 30 }),
    ]
    const transcript = {
      listChats: () => [{ id: "assigned-chat", projectId: "assigned-project" }],
      getMessages: () => messages,
      getChat: () => ({ projectId: "assigned-project" }),
    }
    let first: MemoryService | null = new MemoryService({ dbPath, dataDir: dir })
    try {
      const source = first.store.create(
        { content: "Use high contrast", scope: "project", projectId: "source-project", type: "constraint" },
        { actor: "agent" },
      )
      const secondSource = first.store.create(
        { content: "Portable accessibility rule", scope: "personal", type: "fact" },
        { actor: "system" },
      )
      first.store.create(
        { content: "Old rule", scope: "project", projectId: "assigned-project", type: "constraint" },
        { actor: "agent" },
      )
      const conflicting = first.store.create(
        { content: "New rule", scope: "project", projectId: "assigned-project", type: "constraint" },
        { actor: "agent" },
      )

      // Simulate process death after canonical actions committed but before
      // MemoryBoardBacklogService.resolve could persist its Board receipt.
      first.store.setKv(`transfer_declined:${source.id}:assigned-project`, "declined")
      first.store.archive(conflicting.id, { actor: "user" })
      const personalLanding = first.store.create(
        { content: "Use accessible contrast everywhere", scope: "personal", type: "constraint" },
        { actor: "user" },
      )
      first.store.addRelation(personalLanding.id, secondSource.id, "derived_from")
      first.close()
      first = null

      const reopened = new MemoryService({ dbPath, dataDir: dir })
      try {
        const service = createMemoryBoardBacklogService({
          transcript,
          receiptStore: reopened.store,
          memoryState: reopened.store,
          assignedProjectIds: () => new Set(["assigned-project"]),
          currentTaskId: () => "038-S2",
        })

        expect(service.snapshot()).toEqual({ transfers: [], checkups: [] })
        expect(service.assertPending({
          taskId: "038-S2",
          kind: "transfer",
          chatId: "assigned-chat",
          gateId: "transfer-crash",
          sourceId: "M-01",
        })).toEqual({ pending: false })
        expect(service.assertPending({
          taskId: "038-S2",
          kind: "checkup",
          chatId: "assigned-chat",
          gateId: "checkup-crash",
          suggestionKind: "conflict",
          memoryId: "M-03",
          otherMemoryId: "M-04",
        })).toEqual({ pending: false })
        expect(service.assertTransferPending({
          taskId: "038-S2",
          kind: "transfer",
          chatId: "assigned-chat",
          gateId: "transfer-scope-crash",
          sourceId: secondSource.id,
        })).toEqual({ pending: false, resultId: personalLanding.id })
        expect(reopened.store.getKv(
          `board_backlog_resolution:v1:${encodeURIComponent("transfer:assigned-project:M-01")}`,
        )).toEqual(expect.objectContaining({ taskId: "038-S2", outcome: "invalidated", reason: "source_declined" }))
      } finally {
        reopened.close()
      }
    } finally {
      first?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
