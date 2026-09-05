import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StudyMemoryStore } from "./study-memory-store"

const tempDirs: string[] = []

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "memosync-study-memory-"))
  tempDirs.push(dir)
  return join(dir, "study-memory.sqlite")
}

function staticAtom(
  content: string,
  segmentOrdinal: number,
  overrides: { relPath?: string; heading?: string; qualityFlags?: string[] } = {},
) {
  return {
    content,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    sourceRef: {
      relPath: overrides.relPath ?? "MEMORY.md",
      heading: overrides.heading ?? "Preferences",
      segmentOrdinal,
    },
    qualityFlags: overrides.qualityFlags ?? [],
  }
}

function staticPayload(content: string) {
  const prefix = "# Memory\n\n## MEMORY.md\n"
  return {
    text: `${prefix}${content}`,
    sources: [{
      relPath: "MEMORY.md",
      injectedContent: content,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      truncated: false,
      start: prefix.length,
      end: prefix.length + content.length,
    }],
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("StudyMemoryStore", () => {
  test("persists instruction-guard evidence without storing rejected prompt text", () => {
    const dbPath = tempDatabase()
    const copiedText = "Users should be able to browse different types of apartments."
    const first = new StudyMemoryStore(dbPath)
    first.recordInstructionGuardEvent({
      eventId: "guard-1",
      taskId: "038-S1",
      recordedAt: "2026-08-18T10:00:00.000Z",
      channel: "chat.send",
      reason: "near_verbatim",
      disqualifying: true,
      chatId: "chat-1",
      projectId: "project-apartment",
      ruleVersion: "token-lcs-v1",
      longestContiguousRun: 12,
      lcsRatio: 0.94,
      reference: "paragraph_2",
    })
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    const events = reopened.listInstructionGuardEvents("038-S1")
    expect(events).toEqual([{
      eventId: "guard-1",
      taskId: "038-S1",
      recordedAt: "2026-08-18T10:00:00.000Z",
      channel: "chat.send",
      reason: "near_verbatim",
      disqualifying: true,
      chatId: "chat-1",
      projectId: "project-apartment",
      ruleVersion: "token-lcs-v1",
      longestContiguousRun: 12,
      lcsRatio: 0.94,
      reference: "paragraph_2",
    }])
    expect(reopened.hasDisqualifyingInstructionViolation("038-S1")).toBe(true)
    expect(JSON.stringify(events)).not.toContain(copiedText)
    reopened.close()
  })

  test("persists guide and brief delivery receipts across browser/server restarts", () => {
    const dbPath = tempDatabase()
    const first = new StudyMemoryStore(dbPath)
    expect(first.hasUiReceipt("guide:2026-08-18-v1")).toBe(false)
    first.recordUiReceipt("guide:2026-08-18-v1", "2026-08-18T11:00:00.000Z")
    first.recordUiReceipt("brief:038-S1:v1", "2026-08-18T11:01:00.000Z")
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.hasUiReceipt("guide:2026-08-18-v1")).toBe(true)
    expect(reopened.hasUiReceipt("brief:038-S1:v1")).toBe(true)
    expect(reopened.hasUiReceipt("brief:098-S1:v1")).toBe(false)
    reopened.close()
  })

  test("persists and clears study quality flags across restarts", () => {
    const dbPath = tempDatabase()
    const first = new StudyMemoryStore(dbPath)
    first.recordStudyMemoryQualityFlag({
      code: "post_turn_incomplete",
      blocking: false,
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
    })
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.listStudyMemoryQualityFlags("038-S1")).toEqual([{
      code: "post_turn_incomplete",
      blocking: false,
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
    }])
    reopened.clearStudyMemoryQualityFlag({
      code: "post_turn_incomplete",
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-1",
    })
    expect(reopened.listStudyMemoryQualityFlags("038-S1")).toEqual([])
    reopened.close()
  })

  test("durably records complete focus deliveries and their item versions", () => {
    const dbPath = tempDatabase()
    const first = new StudyMemoryStore(dbPath)

    first.recordFocusDelivery({
      injectionId: "inj-1",
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      condition: "memosync",
      engine: "claude",
      mode: "skills",
      outcome: "delivered",
      deliveryStage: "queued_to_claude",
      deliveryHash: "delivery-hash-1",
      visiblePoolHash: "pool-hash-1",
      items: [
        {
          identity: { scheme: "store", id: "M-01" },
          version: 2,
          content: "Use pnpm for package management.",
          scope: "project",
          expectedUse: "Use pnpm while updating dependencies.",
          sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 2 },
        },
      ],
    })
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.listTaskDeliveries("038-S1")).toEqual([
      {
        injectionId: "inj-1",
        taskId: "038-S1",
        chatId: "chat-1",
        turnId: "turn-1",
        turn: 1,
        focusedAt: "2026-08-15T10:00:00.000Z",
        condition: "memosync",
        engine: "claude",
        mode: "skills",
        outcome: "delivered",
        deliveryStage: "queued_to_claude",
        deliveryHash: "delivery-hash-1",
        visiblePoolHash: "pool-hash-1",
        qualityFlags: [],
        items: [
          {
            identity: { scheme: "store", id: "M-01" },
            version: 2,
            content: "Use pnpm for package management.",
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            scope: "project",
            actualFocus: true,
            expectedUse: "Use pnpm while updating dependencies.",
            sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 2 },
            qualityFlags: [],
          },
        ],
      },
    ])
    reopened.close()
  })

  test("migrates an existing focus-delivery table before recording resume lineage", () => {
    const dbPath = tempDatabase()
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE study_focus_deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        injection_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        focused_at TEXT NOT NULL,
        condition TEXT NOT NULL,
        engine TEXT NOT NULL,
        mode TEXT NOT NULL,
        outcome TEXT NOT NULL,
        delivery_stage TEXT NOT NULL,
        delivery_hash TEXT NOT NULL,
        visible_pool_hash TEXT NOT NULL,
        quality_flags_json TEXT NOT NULL
      );
    `)
    legacy.close()

    const store = new StudyMemoryStore(dbPath)
    store.recordFocusDelivery({
      injectionId: "inj-resume",
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-2",
      turn: 2,
      focusedAt: "2026-08-19T10:00:00.000Z",
      condition: "memosync",
      engine: "claude",
      mode: "skills",
      outcome: "delivered",
      deliveryStage: "queued_to_claude",
      deliveryHash: "delivery-hash",
      visiblePoolHash: "pool-hash",
      resumeOfInterruptId: "interrupt-1",
      items: [{
        identity: { scheme: "store", id: "M-01" },
        version: 1,
        content: "Use pnpm.",
        scope: "project",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 1 },
      }],
    })

    expect(store.listTaskDeliveries("038-S1")).toEqual([
      expect.objectContaining({
        injectionId: "inj-resume",
        resumeOfInterruptId: "interrupt-1",
      }),
    ])
    store.close()
  })

  test("freezes one item per stable identity with full history and the last actual focus as cue", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const baseDelivery = {
      taskId: "038-S1",
      chatId: "chat-1",
      condition: "memosync" as const,
      engine: "claude" as const,
      mode: "skills" as const,
      outcome: "delivered" as const,
      deliveryStage: "queued_to_claude" as const,
      deliveryHash: "delivery-hash",
      visiblePoolHash: "pool-hash",
    }
    store.recordFocusDelivery({
      ...baseDelivery,
      injectionId: "inj-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      items: [
        {
          identity: { scheme: "store", id: "M-01" },
          version: 1,
          content: "Use npm for package management.",
          scope: "project",
          sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 1 },
        },
      ],
    })
    store.recordFocusDelivery({
      ...baseDelivery,
      injectionId: "inj-2",
      turnId: "turn-2",
      turn: 2,
      focusedAt: "2026-08-15T10:05:00.000Z",
      items: [
        {
          identity: { scheme: "store", id: "M-02" },
          version: 1,
          content: "Keep the existing visual design.",
          scope: "project",
          sourceRef: { kind: "memosync_store", memoryId: "M-02", storeVersion: 1 },
        },
      ],
    })
    store.recordFocusDelivery({
      ...baseDelivery,
      injectionId: "inj-3",
      turnId: "turn-3",
      turn: 3,
      focusedAt: "2026-08-15T10:10:00.000Z",
      items: [
        {
          identity: { scheme: "store", id: "M-01" },
          version: 2,
          content: "Use pnpm for package management.",
          scope: "personal",
          expectedUse: "Use pnpm for this dependency update.",
          sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 2 },
        },
      ],
    })
    store.recordFocusDelivery({
      ...baseDelivery,
      injectionId: "inj-4",
      turnId: "turn-4",
      turn: 4,
      focusedAt: "2026-08-15T10:12:00.000Z",
      items: [
        {
          identity: { scheme: "store", id: "M-01" },
          version: 2,
          content: "Use pnpm for package management.",
          scope: "personal",
          sourceRef: {
            kind: "memosync_store",
            memoryId: "M-01",
            storeVersion: 2,
            focusMarker: "latest",
          },
        },
      ],
    })

    const snapshot = store.createFreezeSnapshot({
      snapshotId: "freeze-1",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:15:00.000Z",
    })

    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items[0]).toMatchObject({
      probeId: expect.any(String),
      identity: { scheme: "store", id: "M-01" },
      cue: {
        version: 2,
        content: "Use pnpm for package management.",
        scope: "personal",
        sourceRef: { focusMarker: "latest" },
      },
      object: {
        present: true,
        status: "active",
        version: 2,
        content: "Use pnpm for package management.",
        scope: "personal",
      },
    })
    expect(snapshot.items[0]!.history.map((entry) => ({
      injectionId: entry.injectionId,
      version: entry.version,
      content: entry.content,
      scope: entry.scope,
    }))).toEqual([
      { injectionId: "inj-1", version: 1, content: "Use npm for package management.", scope: "project" },
      { injectionId: "inj-3", version: 2, content: "Use pnpm for package management.", scope: "personal" },
      { injectionId: "inj-4", version: 2, content: "Use pnpm for package management.", scope: "personal" },
    ])
    expect(snapshot.items[1]!.identity).toEqual({ scheme: "store", id: "M-02" })
    store.close()
  })

  test("keeps a freeze snapshot immutable across later focus and process restart", () => {
    const dbPath = tempDatabase()
    const store = new StudyMemoryStore(dbPath)
    const delivery = {
      taskId: "038-S1",
      chatId: "chat-1",
      condition: "memosync" as const,
      engine: "claude" as const,
      mode: "skills" as const,
      outcome: "delivered" as const,
      deliveryStage: "queued_to_claude" as const,
      deliveryHash: "delivery-hash",
      visiblePoolHash: "pool-hash",
    }
    store.recordFocusDelivery({
      ...delivery,
      injectionId: "inj-before",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      items: [{
        identity: { scheme: "store", id: "M-01" },
        version: 1,
        content: "Use npm.",
        scope: "project",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 1 },
      }],
    })
    store.createFreezeSnapshot({
      snapshotId: "freeze-immutable",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:05:00.000Z",
      workspaceSnapshot: {
        schemaVersion: 1,
        snapshotId: "freeze-immutable",
        taskId: "038-S1",
        frozenAt: "2026-08-15T10:05:00.000Z",
        project: { slug: "apartment", title: "Apartment rentals" },
        exportedPath: "experiments/workspace-snapshots/038-S1/freeze-immutable/workspace",
        treeHash: "source-tree-hash",
        fileCount: 2,
        totalBytes: 42,
        exclusions: ["**/node_modules/**"],
      },
    })
    store.recordFocusDelivery({
      ...delivery,
      injectionId: "inj-after",
      turnId: "turn-2",
      turn: 2,
      focusedAt: "2026-08-15T10:10:00.000Z",
      items: [{
        identity: { scheme: "store", id: "M-01" },
        version: 2,
        content: "Use pnpm.",
        scope: "personal",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 2 },
      }],
    })

    expect(store.getFreezeSnapshot("freeze-immutable")).toMatchObject({
      workspaceSnapshot: {
        snapshotId: "freeze-immutable",
        treeHash: "source-tree-hash",
      },
      items: [{
        cue: { version: 1, content: "Use npm.", scope: "project" },
        history: [{ injectionId: "inj-before", version: 1, content: "Use npm." }],
      }],
    })
    store.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.getFreezeSnapshot("freeze-immutable")).toMatchObject({
      workspaceSnapshot: {
        snapshotId: "freeze-immutable",
        treeHash: "source-tree-hash",
      },
      items: [{
        cue: { version: 1, content: "Use npm.", scope: "project" },
        history: [{ injectionId: "inj-before", version: 1, content: "Use npm." }],
      }],
    })
    reopened.close()
  })

  test("records one idempotent questionnaire submission per snapshot and restores it after restart", () => {
    const dbPath = tempDatabase()
    const store = new StudyMemoryStore(dbPath)
    store.createFreezeSnapshot({
      snapshotId: "freeze-submit",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:00:00.000Z",
    })
    const answers = [{
      probeId: "probe-1",
      desired: { verdict: "needs_edit", correctedContent: "Use pnpm.", scope: "project" },
      assessed: { verdict: "full", scope: "project" },
      execution: "full",
    }]

    const created = store.recordQuestionnaireSubmission({
      submissionId: "submission-1",
      snapshotId: "freeze-submit",
      submittedAt: "2026-08-15T10:10:00.000Z",
      questionnaireVersion: 2,
      answers,
    })
    const retried = store.recordQuestionnaireSubmission({
      submissionId: "submission-retry",
      snapshotId: "freeze-submit",
      submittedAt: "2026-08-15T10:11:00.000Z",
      questionnaireVersion: 2,
      answers: [{
        execution: "full",
        assessed: { scope: "project", verdict: "full" },
        desired: { scope: "project", correctedContent: "Use pnpm.", verdict: "needs_edit" },
        probeId: "probe-1",
      }],
    })

    expect(created.created).toBe(true)
    expect(retried).toEqual({ created: false, submission: created.submission })
    store.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.getQuestionnaireSubmission("freeze-submit")).toEqual(created.submission)
    reopened.close()
  })

  test("keeps the last focus cue separate from the final frozen object state", () => {
    const store = new StudyMemoryStore(tempDatabase())
    store.recordFocusDelivery({
      injectionId: "inj-cue",
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      condition: "memosync",
      engine: "claude",
      mode: "skills",
      outcome: "delivered",
      deliveryStage: "queued_to_claude",
      deliveryHash: "delivery-hash",
      visiblePoolHash: "pool-hash",
      items: [{
        identity: { scheme: "store", id: "M-01" },
        version: 2,
        content: "Use pnpm.",
        scope: "project",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 2 },
      }],
    })

    const snapshot = store.createFreezeSnapshot({
      snapshotId: "freeze-object",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:05:00.000Z",
      objectStates: [{
        identity: { id: "M-01", scheme: "store" },
        present: false,
        status: "archived",
        version: 3,
        content: "Use pnpm after the archive.",
        scope: "personal",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 3 },
      }],
    })

    expect(snapshot.items[0]).toMatchObject({
      cue: { version: 2, content: "Use pnpm.", scope: "project" },
      object: {
        present: false,
        status: "archived",
        version: 3,
        content: "Use pnpm after the archive.",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        scope: "personal",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 3 },
      },
    })
    store.close()
  })

  test("makes focus delivery retries idempotent and rejects a changed payload for the same injection", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const input = {
      injectionId: "inj-idempotent",
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      condition: "memosync" as const,
      engine: "claude" as const,
      mode: "skills" as const,
      outcome: "delivered" as const,
      deliveryStage: "queued_to_claude" as const,
      deliveryHash: "delivery-hash",
      visiblePoolHash: "pool-hash",
      items: [{
        identity: { scheme: "store", id: "M-01" },
        version: 1,
        content: "Use pnpm.",
        scope: "project" as const,
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 1 },
      }],
    }

    const recorded = store.recordFocusDelivery(input)
    expect(store.recordFocusDelivery(input)).toEqual(recorded)
    expect(store.listTaskDeliveries("038-S1")).toHaveLength(1)
    expect(() => store.recordFocusDelivery({
      ...input,
      items: [{ ...input.items[0]!, content: "Use npm." }],
    })).toThrow("Focus delivery already exists with different content")
    store.close()
  })

  test("returns the original immutable snapshot when freeze creation is retried for a task", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const first = store.createFreezeSnapshot({
      snapshotId: "freeze-first",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:00:00.000Z",
    })
    const retry = store.createFreezeSnapshot({
      snapshotId: "freeze-retry",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:01:00.000Z",
    })

    expect(retry).toEqual(first)
    expect(store.getFreezeSnapshot("freeze-retry")).toBeNull()
    expect(store.getTaskFreezeSnapshot("038-S1")).toEqual(first)
    store.close()
  })

  test("admin unfreeze removes an unanswered snapshot so a new immutable snapshot can be created", () => {
    const store = new StudyMemoryStore(tempDatabase())
    store.createFreezeSnapshot({
      snapshotId: "freeze-first",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:00:00.000Z",
    })

    expect(store.removeTaskFreezeSnapshot("038-S1")).toBe(true)
    expect(store.getFreezeSnapshot("freeze-first")).toBeNull()
    expect(store.createFreezeSnapshot({
      snapshotId: "freeze-second",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:05:00.000Z",
    }).snapshotId).toBe("freeze-second")
    store.close()
  })

  test("persists an exact pending Static focus across restart for recovery", () => {
    const dbPath = tempDatabase()
    const first = new StudyMemoryStore(dbPath)
    const pending = first.reserveStaticFocusDelivery({
      injectionId: "static-pending-1",
      taskId: "038-S1",
      namespace: "project-a",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      deliveryHash: "prompt-hash-1",
      payload: {
        text: "# Memory\n\n## MEMORY.md\n- Use pnpm.",
        sources: [{
          relPath: "MEMORY.md",
          injectedContent: "- Use pnpm.",
          contentHash: createHash("sha256").update("- Use pnpm.", "utf8").digest("hex"),
          truncated: false,
          start: 24,
          end: 35,
        }],
      },
    })
    expect(pending.dispatchSequence).toBeGreaterThan(0)
    expect(first.hasPendingStaticFocusDeliveries("038-S1")).toBe(true)
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.listPendingStaticFocusDeliveries({ taskId: "038-S1" })).toEqual([pending])
    expect(reopened.listPendingStaticFocusDeliveries({ namespace: "project-a" })).toEqual([pending])
    expect(() => reopened.createFreezeSnapshot({
      snapshotId: "freeze-too-early",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:01:00.000Z",
    })).toThrow(/pending Static focus/i)
    reopened.finalizeStaticFocusDelivery({
      injectionId: pending.injectionId,
      payloadHash: pending.payloadHash,
      atoms: [staticAtom("Use pnpm.", 0)],
    })
    expect(reopened.hasPendingStaticFocusDeliveries("038-S1")).toBe(false)
    reopened.close()

    const completed = new StudyMemoryStore(dbPath)
    expect(completed.listPendingStaticFocusDeliveries({ taskId: "038-S1" })).toEqual([])
    expect(completed.listTaskDeliveries("038-S1")[0]).toMatchObject({
      injectionId: "static-pending-1",
      items: [{ content: "Use pnpm.", version: 1 }],
    })
    completed.close()
  })

  test("finalizes Static focus in dispatch order even when later extraction finishes first", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const first = store.reserveStaticFocusDelivery({
      injectionId: "static-turn-1",
      taskId: "038-S1",
      namespace: "project-a",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      deliveryHash: "prompt-hash-1",
      payload: staticPayload("- Use npm."),
    })
    const second = store.reserveStaticFocusDelivery({
      injectionId: "static-turn-2",
      taskId: "038-S1",
      namespace: "project-a",
      chatId: "chat-1",
      turnId: "turn-2",
      turn: 2,
      focusedAt: "2026-08-15T10:05:00.000Z",
      deliveryHash: "prompt-hash-2",
      payload: staticPayload("- Use pnpm."),
    })

    expect(() => store.finalizeStaticFocusDelivery({
      injectionId: second.injectionId,
      payloadHash: second.payloadHash,
      atoms: [staticAtom("Use pnpm.", 0)],
    })).toThrow(/earlier pending Static focus/i)
    expect(store.getStaticObjectStates("project-a")).toEqual([])

    const firstFinal = store.finalizeStaticFocusDelivery({
      injectionId: first.injectionId,
      payloadHash: first.payloadHash,
      atoms: [staticAtom("Use npm.", 0)],
    })
    const secondFinal = store.finalizeStaticFocusDelivery({
      injectionId: second.injectionId,
      payloadHash: second.payloadHash,
      atoms: [staticAtom("Use pnpm.", 0)],
    })
    expect(store.finalizeStaticFocusDelivery({
      injectionId: second.injectionId,
      payloadHash: second.payloadHash,
      atoms: [staticAtom("Use pnpm.", 0)],
    })).toEqual(secondFinal)

    expect(firstFinal.resolution.atoms[0]).toMatchObject({ version: 1, content: "Use npm." })
    expect(secondFinal.resolution.atoms[0]).toMatchObject({
      identity: firstFinal.resolution.atoms[0]!.identity,
      version: 2,
      content: "Use pnpm.",
    })
    expect(store.listTaskDeliveries("038-S1").map((delivery) => ({
      injectionId: delivery.injectionId,
      content: delivery.items[0]?.content,
      version: delivery.items[0]?.version,
    }))).toEqual([
      { injectionId: "static-turn-1", content: "Use npm.", version: 1 },
      { injectionId: "static-turn-2", content: "Use pnpm.", version: 2 },
    ])
    expect(store.listPendingStaticFocusDeliveries({ namespace: "project-a" })).toEqual([])
    const snapshot = store.createFreezeSnapshot({
      snapshotId: "freeze-static-order",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:10:00.000Z",
    })
    expect(snapshot.items[0]).toMatchObject({
      cue: { version: 2, content: "Use pnpm." },
      history: [
        { injectionId: "static-turn-1", version: 1, content: "Use npm." },
        { injectionId: "static-turn-2", version: 2, content: "Use pnpm." },
      ],
    })
    store.close()
  })

  test("rolls back Static identity changes when atomic delivery finalization fails", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const pending = store.reserveStaticFocusDelivery({
      injectionId: "static-atomic",
      taskId: "038-S1",
      namespace: "project-a",
      chatId: "chat-1",
      turnId: "turn-1",
      turn: 1,
      focusedAt: "2026-08-15T10:00:00.000Z",
      deliveryHash: "static-prompt-hash",
      payload: staticPayload("- Use pnpm."),
    })
    // Simulate a conflicting partial/corrupt write at the delivery seam. The
    // finalizer resolves identities first, so its outer transaction must undo
    // those changes when publishing the delivery is rejected.
    store.recordFocusDelivery({
      injectionId: "static-atomic",
      taskId: "038-S1",
      chatId: "chat-1",
      turnId: "turn-conflict",
      turn: 99,
      focusedAt: "2026-08-15T09:00:00.000Z",
      condition: "memosync",
      engine: "claude",
      mode: "skills",
      outcome: "delivered",
      deliveryStage: "queued_to_claude",
      deliveryHash: "conflicting-hash",
      visiblePoolHash: "conflicting-pool",
      items: [{
        identity: { scheme: "store", id: "M-01" },
        version: 1,
        content: "Conflicting delivery.",
        scope: "project",
        sourceRef: { kind: "memosync_store", memoryId: "M-01", storeVersion: 1 },
      }],
    })

    expect(() => store.finalizeStaticFocusDelivery({
      injectionId: pending.injectionId,
      payloadHash: pending.payloadHash,
      atoms: [staticAtom("Use pnpm.", 0)],
    })).toThrow(/already exists with different content/i)
    expect(store.getStaticObjectStates("project-a")).toEqual([])
    expect(store.listPendingStaticFocusDeliveries({ taskId: "038-S1" })).toEqual([pending])
    store.close()
  })

  test("resolves duplicate Static content to one Project-scoped identity with every location", () => {
    const store = new StudyMemoryStore(tempDatabase())

    const result = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-1",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [
        staticAtom("Use pnpm.", 0),
        staticAtom("Use pnpm.", 3, { relPath: "CLAUDE.md", heading: "Tooling" }),
      ],
    })

    expect(result.atoms).toHaveLength(1)
    expect(result.atoms[0]).toMatchObject({
      identity: { scheme: "static", id: expect.stringMatching(/^static-[a-f0-9]{32}$/) },
      version: 1,
      content: "Use pnpm.",
      scope: "project",
      sourceRef: {
        kind: "static_measurement",
        namespace: "participant-01/project-a",
        snapshotHash: "snapshot-1",
        locations: [
          { relPath: "MEMORY.md", heading: "Preferences", segmentOrdinal: 0 },
          { relPath: "CLAUDE.md", heading: "Tooling", segmentOrdinal: 3 },
        ],
      },
    })
    store.close()
  })

  test("keeps a Static identity and advances its version for a one-to-one anchor edit", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const first = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-before-edit",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [staticAtom("Use npm.", 0)],
    })

    const edited = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-after-edit",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [staticAtom("Use pnpm.", 0)],
    })

    expect(edited.atoms[0]).toMatchObject({
      identity: first.atoms[0]!.identity,
      version: 2,
      content: "Use pnpm.",
      scope: "project",
    })
    store.close()
  })

  test("marks missing Static identities deleted and restores exact last content without a new version", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const first = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-present",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [staticAtom("Use pnpm.", 0)],
    })
    store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-deleted",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [],
    })

    expect(store.getStaticObjectStates("participant-01/project-a")).toEqual([{
      identity: first.atoms[0]!.identity,
      present: false,
      status: "deleted",
      version: 1,
      content: "Use pnpm.",
      contentHash: first.atoms[0]!.contentHash,
      stateHash: first.atoms[0]!.stateHash,
      scope: "project",
      sourceRef: first.atoms[0]!.sourceRef,
      qualityFlags: [],
    }])

    const restored = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-restored",
      observedAt: "2026-08-15T11:10:00.000Z",
      atoms: [staticAtom("Use pnpm.", 4)],
    })
    expect(restored.atoms[0]).toMatchObject({
      identity: first.atoms[0]!.identity,
      version: 1,
    })
    store.close()
  })

  test("restores historical Static content to the same identity with a new version after restart", () => {
    const dbPath = tempDatabase()
    const firstStore = new StudyMemoryStore(dbPath)
    const first = firstStore.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-v1",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [staticAtom("Use npm.", 0)],
    })
    firstStore.close()

    const secondStore = new StudyMemoryStore(dbPath)
    const edited = secondStore.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-v2",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [staticAtom("Use pnpm.", 0)],
    })
    expect(edited.atoms[0]).toMatchObject({
      identity: first.atoms[0]!.identity,
      version: 2,
    })
    secondStore.close()

    const reopened = new StudyMemoryStore(dbPath)
    const restored = reopened.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-v3",
      observedAt: "2026-08-15T11:10:00.000Z",
      atoms: [staticAtom("Use npm.", 8, { relPath: "CLAUDE.md", heading: "Restored" })],
    })

    expect(restored.atoms[0]).toMatchObject({
      identity: first.atoms[0]!.identity,
      version: 3,
      content: "Use npm.",
    })
    expect(reopened.getStaticObjectStates("participant-01/project-a")).toHaveLength(1)
    reopened.close()
  })

  test("creates deterministic child identities with lineage when one Static atom splits", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const parent = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-compound",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [staticAtom("Use pnpm and run tests.", 0)],
    }).atoms[0]!

    const split = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-split",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [
        staticAtom("Use pnpm.", 0),
        staticAtom("Run tests.", 0),
      ],
    })

    expect(split.atoms).toHaveLength(2)
    expect(new Set(split.atoms.map((atom) => atom.identity.id)).size).toBe(2)
    for (const child of split.atoms) {
      expect(child.identity).not.toEqual(parent.identity)
      expect(child.version).toBe(1)
      expect(child.qualityFlags).toContain("static_identity_split")
      expect(child.sourceRef.lineage).toEqual({
        relation: "split",
        ancestors: [parent.identity],
      })
    }
    const unchanged = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-split-unchanged",
      observedAt: "2026-08-15T11:10:00.000Z",
      atoms: [staticAtom("Use pnpm.", 0), staticAtom("Run tests.", 0)],
    })
    for (const child of unchanged.atoms) {
      const original = split.atoms.find((atom) => atom.content === child.content)!
      expect(child).toMatchObject({
        identity: original.identity,
        version: 1,
        qualityFlags: expect.arrayContaining(["static_identity_split"]),
        sourceRef: { lineage: original.sourceRef.lineage },
      })
    }
    const replay = new StudyMemoryStore(tempDatabase())
    replay.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-compound",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [staticAtom("Use pnpm and run tests.", 0)],
    })
    const replaySplit = replay.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-split",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [staticAtom("Use pnpm.", 0), staticAtom("Run tests.", 0)],
    })
    expect(replaySplit.atoms.map((atom) => atom.identity.id)).toEqual(
      split.atoms.map((atom) => atom.identity.id),
    )
    replay.close()
    store.close()
  })

  test("creates a deterministic descendant with both ancestors when Static atoms merge", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const parents = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-separate",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [
        staticAtom("Use pnpm.", 0),
        staticAtom("Run tests.", 1),
      ],
    }).atoms

    const merged = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-merged",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [
        staticAtom("Use pnpm and run tests.", 0),
        staticAtom("Use pnpm and run tests.", 1),
      ],
    }).atoms[0]!

    expect(merged.version).toBe(1)
    expect(parents.map((atom) => atom.identity)).not.toContainEqual(merged.identity)
    expect(merged.qualityFlags).toContain("static_identity_merge")
    expect(merged.sourceRef.lineage).toEqual({
      relation: "merge",
      ancestors: parents.map((atom) => atom.identity).sort((a, b) => a.id.localeCompare(b.id)),
    })
    const replay = new StudyMemoryStore(tempDatabase())
    replay.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-separate",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [staticAtom("Use pnpm.", 0), staticAtom("Run tests.", 1)],
    })
    const reversedMerge = replay.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-merged",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [
        staticAtom("Use pnpm and run tests.", 1),
        staticAtom("Use pnpm and run tests.", 0),
      ],
    }).atoms[0]!
    expect(reversedMerge.identity).toEqual(merged.identity)
    replay.close()
    store.close()
  })

  test("creates flagged lineage identities for an ambiguous many-to-many Static remap", () => {
    const store = new StudyMemoryStore(tempDatabase())
    const parents = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-before-remap",
      observedAt: "2026-08-15T11:00:00.000Z",
      atoms: [
        staticAtom("Use pnpm.", 0),
        staticAtom("Run tests.", 1),
      ],
    }).atoms
    const location0 = staticAtom("Ship safely.", 0)
    const location1 = staticAtom("Ship safely.", 1)
    const secondContent0 = staticAtom("Keep CI green.", 0)
    const secondContent1 = staticAtom("Keep CI green.", 1)

    const remapped = store.resolveStaticAtoms({
      namespace: "participant-01/project-a",
      snapshotHash: "snapshot-after-remap",
      observedAt: "2026-08-15T11:05:00.000Z",
      atoms: [location0, location1, secondContent0, secondContent1],
    }).atoms

    const ancestors = parents.map((atom) => atom.identity).sort((a, b) => a.id.localeCompare(b.id))
    expect(remapped).toHaveLength(2)
    for (const atom of remapped) {
      expect(atom.qualityFlags).toContain("static_identity_ambiguous")
      expect(atom.sourceRef.lineage).toEqual({ relation: "ambiguous", ancestors })
    }
    store.close()
  })

  test("persists the Static extractor cache across store restarts", () => {
    const dbPath = tempDatabase()
    const first = new StudyMemoryStore(dbPath)
    expect(first.get("extractor-cache-key")).toBeNull()
    first.set("extractor-cache-key", ["Use pnpm.", "Run tests."])
    const detached = first.get("extractor-cache-key")!
    detached.push("local mutation")
    expect(first.get("extractor-cache-key")).toEqual(["Use pnpm.", "Run tests."])
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.get("extractor-cache-key")).toEqual(["Use pnpm.", "Run tests."])
    reopened.set("extractor-cache-key", ["Use bun test."])
    expect(reopened.get("extractor-cache-key")).toEqual(["Use bun test."])
    reopened.close()
  })
})

describe("questionnaire v2 versioning", () => {
  const V2_ANSWER = {
    probeId: "probe-1",
    snapshotId: "freeze-v2",
    desired: { rating: 5, presence: "present", correctedContent: null, scope: "project" },
    assessed: { rating: 2, presence: "present", believedContent: "Half of it.", scope: "project" },
    execution: "not_applicable",
  }

  test("new freeze snapshots persist questionnaireVersion 2 across restart", () => {
    const dbPath = tempDatabase()
    const store = new StudyMemoryStore(dbPath)
    store.createFreezeSnapshot({
      snapshotId: "freeze-v2",
      taskId: "038-S1",
      frozenAt: "2026-08-20T10:00:00.000Z",
    })
    store.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(reopened.getFreezeSnapshot("freeze-v2")?.questionnaireVersion).toBe(2)
    reopened.close()
  })

  test("persists the submission questionnaire_version and restores v2 answers after restart", () => {
    const dbPath = tempDatabase()
    const store = new StudyMemoryStore(dbPath)
    store.createFreezeSnapshot({
      snapshotId: "freeze-v2",
      taskId: "038-S1",
      frozenAt: "2026-08-20T10:00:00.000Z",
    })
    const created = store.recordQuestionnaireSubmission({
      submissionId: "submission-v2",
      snapshotId: "freeze-v2",
      submittedAt: "2026-08-20T10:10:00.000Z",
      questionnaireVersion: 2,
      answers: [V2_ANSWER],
      attentionCheck: {
        checkId: "attention-038-s1",
        selectedValue: "option_b",
        passed: true,
      },
    })
    expect(created.created).toBe(true)
    expect(created.submission.questionnaireVersion).toBe(2)
    store.close()

    const reopened = new StudyMemoryStore(dbPath)
    const restored = reopened.getQuestionnaireSubmission("freeze-v2")
    expect(restored?.questionnaireVersion).toBe(2)
    expect(restored?.answers).toEqual([V2_ANSWER])
    expect(restored?.attentionCheck).toEqual({
      checkId: "attention-038-s1",
      selectedValue: "option_b",
      passed: true,
    })
    reopened.close()
  })

  test("rejects a submission whose version contradicts the frozen snapshot", () => {
    const store = new StudyMemoryStore(tempDatabase())
    store.createFreezeSnapshot({
      snapshotId: "freeze-v2",
      taskId: "038-S1",
      frozenAt: "2026-08-20T10:00:00.000Z",
    })
    expect(() => store.recordQuestionnaireSubmission({
      submissionId: "submission-wrong-version",
      snapshotId: "freeze-v2",
      submittedAt: "2026-08-20T10:10:00.000Z",
      questionnaireVersion: 1,
      answers: [],
    })).toThrow(/questionnaire version/i)
    store.close()
  })

  test("migrates a legacy database: missing column defaults to version 1 and stays readable", () => {
    const dbPath = tempDatabase()
    // Simulate a pre-v2 database: the submissions table has no
    // questionnaire_version column and the freeze payload has no
    // questionnaireVersion field.
    const legacy = new Database(dbPath, { create: true })
    legacy.exec(`
      CREATE TABLE study_freeze_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        frozen_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE study_questionnaire_submissions (
        submission_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL UNIQUE,
        submitted_at TEXT NOT NULL,
        answers_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES study_freeze_snapshots(snapshot_id)
      );
    `)
    legacy.query(`
      INSERT INTO study_freeze_snapshots (snapshot_id, task_id, frozen_at, payload_json)
      VALUES (?, ?, ?, ?)
    `).run("freeze-legacy", "038-S1", "2026-08-15T10:00:00.000Z", JSON.stringify({
      schemaVersion: 2,
      snapshotId: "freeze-legacy",
      taskId: "038-S1",
      frozenAt: "2026-08-15T10:00:00.000Z",
      qualityFlags: [],
      items: [],
    }))
    legacy.query(`
      INSERT INTO study_questionnaire_submissions (
        submission_id, snapshot_id, submitted_at, answers_json, payload_hash
      ) VALUES (?, ?, ?, ?, ?)
    `).run("submission-legacy", "freeze-legacy", "2026-08-15T10:10:00.000Z", "[]", "legacy-hash")
    legacy.close()

    const store = new StudyMemoryStore(dbPath)
    expect(store.getFreezeSnapshot("freeze-legacy")?.questionnaireVersion).toBeUndefined()
    expect(store.getQuestionnaireSubmission("freeze-legacy")?.questionnaireVersion).toBe(1)
    store.close()
  })
})

describe("legacy SUS completion receipt recovery", () => {
  test("atomically derives one immutable receipt from an existing pre-receipt SUS row", () => {
    const dbPath = tempDatabase()
    const store = new StudyMemoryStore(dbPath)
    store.recordSusSubmission({
      submissionId: "legacy-sus",
      participantId: "P-LEGACY",
      submittedAt: "2026-08-16T11:00:00.000Z",
      response: {
        instrument: "sus",
        instrumentVersion: 1,
        ratings: { q1: 5, q2: 1, q3: 5, q4: 1, q5: 5, q6: 1, q7: 5, q8: 1, q9: 5, q10: 1 },
      },
    })
    store.close()

    const legacy = new Database(dbPath)
    legacy.exec("DELETE FROM study_completion_receipts")
    legacy.close()

    const reopened = new StudyMemoryStore(dbPath)
    const recovered = reopened.ensureCompletionReceipt("P-LEGACY")
    expect(recovered).toMatchObject({
      participantId: "P-LEGACY",
      susSubmissionId: "legacy-sus",
      code: "CAAML5VN",
      issuedAt: "2026-08-16T11:00:00.000Z",
    })
    expect(reopened.ensureCompletionReceipt("P-LEGACY")).toEqual(recovered)
    reopened.close()
  })
})
