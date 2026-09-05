import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StudyRegistry } from "./study-registry"

describe("StudyRegistry freeze reservation", () => {
  test("allows prompts only from the project assigned to the active benchmark task", () => {
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2", "098-S1"])

    expect(registry.promptRefusal(undefined, "/workspace/apartment")).toBeNull()
    expect(registry.promptRefusal(undefined, "/workspace/car")).toContain("Apartment rentals")

    registry.noteSessionComplete("038-S1", "2026-08-15T10:00:00.000Z")
    expect(registry.promptRefusal(undefined, "/workspace/apartment")).toBeNull()
    expect(registry.promptRefusal(undefined, "/workspace/car")).toContain("Apartment rentals")

    registry.noteSessionComplete("038-S2", "2026-08-15T11:00:00.000Z")
    expect(registry.promptRefusal(undefined, "/workspace/car")).toBeNull()
    expect(registry.promptRefusal(undefined, "/workspace/apartment")).toContain("Car rentals")
  })

  test("reserves the active task synchronously and rejects a concurrent begin", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])

    expect(registry.freezeState("038-S1")).toBe("open")
    expect(registry.beginFreeze("038-S1")).toBe(true)
    expect(registry.freezeState("038-S1")).toBe("freezing")
    expect(registry.beginFreeze("038-S1")).toBe(false)
    expect(registry.promptRefusal()).toContain("ending")
  })

  test("serializes treatment-memory mutations with the freeze boundary", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])

    const release = registry.beginTreatmentMemoryMutation()
    expect(release).toBeFunction()
    expect(registry.hasTreatmentMemoryMutation("038-S1")).toBe(true)
    expect(registry.beginFreeze("038-S1")).toBe(false)

    release!()
    release!()
    expect(registry.hasTreatmentMemoryMutation("038-S1")).toBe(false)
    expect(registry.beginFreeze("038-S1")).toBe(true)
    expect(registry.beginTreatmentMemoryMutation()).toBeNull()
  })

  test("returns the task to open when freeze work fails", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])
    expect(registry.beginFreeze("038-S1")).toBe(true)

    expect(registry.cancelFreeze("038-S1")).toBe(true)
    expect(registry.freezeState("038-S1")).toBe("open")
    expect(registry.promptRefusal()).toBeNull()
    expect(registry.beginFreeze("038-S1")).toBe(true)
  })

  test("commits a reservation from freezing to frozen", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])
    expect(registry.beginFreeze("038-S1")).toBe(true)

    registry.noteFreeze("038-S1", "2026-08-15T10:00:00.000Z")

    expect(registry.freezeState("038-S1")).toBe("frozen")
    expect(registry.cancelFreeze("038-S1")).toBe(false)
    expect(registry.frozenAt("038-S1")).toBe("2026-08-15T10:00:00.000Z")
    expect(registry.promptRefusal()).toContain("end-of-session questions")
  })

  test("unfreeze clears any reservation and reopens the task", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])
    expect(registry.beginFreeze("038-S1")).toBe(true)

    registry.noteUnfreeze("038-S1")

    expect(registry.freezeState("038-S1")).toBe("open")
    expect(registry.cancelFreeze("038-S1")).toBe(false)
    expect(registry.promptRefusal()).toBeNull()
  })

  test("session completion clears the reservation while advancing the serial gate", () => {
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"])
    expect(registry.beginFreeze("038-S1")).toBe(true)

    registry.noteSessionComplete("038-S1", "2026-08-15T10:10:00.000Z")

    expect(registry.cancelFreeze("038-S1")).toBe(false)
    expect(registry.activeTaskId()).toBe("038-S2")
    expect(registry.beginFreeze("038-S1")).toBe(false)
  })

  test("reserves the final complete state for a submitted SUS", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])
    registry.noteSessionComplete("038-S1", "2026-08-15T10:10:00.000Z")

    expect(registry.susPending()).toBe(true)
    expect(registry.studyComplete()).toBe(false)
    expect(registry.promptRefusal()).toContain("final usability questions")

    registry.noteSusSubmit("2026-08-15T10:20:00.000Z")
    expect(registry.susPending()).toBe(false)
    expect(registry.studyComplete()).toBe(true)
    expect(registry.promptRefusal()).toContain("study is complete")
  })
})

describe("StudyRegistry canonical lifecycle recovery", () => {
  test("recovers historical task windows without treating the post-freeze questionnaire gap as task time", () => {
    const lifecycle = {
      getTaskFreezeSnapshot: (taskId: string) => taskId === "038-S1"
        ? { snapshotId: "snapshot-1", frozenAt: "2026-08-20T10:00:00.000Z" }
        : null,
      getQuestionnaireSubmission: () => null,
      getSessionCompletion: (taskId: string) => taskId === "038-S1"
        ? { completedAt: "2026-08-20T10:10:00.000Z" }
        : null,
      getSusSubmission: () => null,
    }
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"], lifecycle)
    const taskWindowAt = (registry as unknown as {
      taskWindowAt(timestampMs: number): { taskId: string; startAt: number; endAt: number | null } | null
    }).taskWindowAt.bind(registry)

    expect(taskWindowAt(Date.parse("2026-08-20T09:59:00.000Z"))).toMatchObject({
      taskId: "038-S1",
      endAt: Date.parse("2026-08-20T10:00:00.000Z"),
    })
    expect(taskWindowAt(Date.parse("2026-08-20T10:05:00.000Z"))).toBeNull()
    expect(taskWindowAt(Date.parse("2026-08-20T10:11:00.000Z"))).toEqual({
      taskId: "038-S2",
      startAt: Date.parse("2026-08-20T10:10:00.000Z"),
      endAt: null,
    })
  })

  test("prefers canonical freeze and submission state while retaining JSONL as legacy fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-registry-"))
    const eventsPath = join(dir, "events.jsonl")
    writeFileSync(eventsPath, [
      JSON.stringify({ type: "study.freeze", taskId: "038-S1", ts: "2026-08-15T08:00:00.000Z" }),
      JSON.stringify({ type: "quiz.submit", taskId: "038-S1", ts: "2026-08-15T08:10:00.000Z" }),
      JSON.stringify({ type: "study.freeze", taskId: "038-S2", ts: "2026-08-15T08:20:00.000Z" }),
      JSON.stringify({ type: "quiz.submit", taskId: "038-S2", ts: "2026-08-15T08:30:00.000Z" }),
    ].join("\n"))

    try {
      const snapshots = new Map([
        ["038-S1", { snapshotId: "snapshot-1", frozenAt: "2026-08-15T10:00:00.000Z" }],
        ["038-S2", { snapshotId: "snapshot-2", frozenAt: "2026-08-15T11:00:00.000Z" }],
      ])
      const lifecycle = {
        getTaskFreezeSnapshot: (taskId: string) => snapshots.get(taskId) ?? null,
        getQuestionnaireSubmission: (snapshotId: string) =>
          snapshotId === "snapshot-1" ? { submittedAt: "2026-08-15T10:10:00.000Z" } : null,
        getSessionCompletion: (taskId: string) =>
          taskId === "038-S1" ? { completedAt: "2026-08-15T10:10:00.000Z" } : null,
        getSusSubmission: () => null,
      }

      const registry = new StudyRegistry(eventsPath, ["038-S1", "038-S2"], lifecycle)

      expect(registry.frozenAt("038-S1")).toBe("2026-08-15T10:00:00.000Z")
      expect(registry.frozenAt("038-S2")).toBe("2026-08-15T11:00:00.000Z")
      expect(registry.windowStart()).toBe("2026-08-15T10:10:00.000Z")
      expect(registry.activeTaskId()).toBe("038-S2")
      expect(registry.questionnairePending()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to legacy JSONL for a task without a canonical snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-registry-legacy-"))
    const eventsPath = join(dir, "events.jsonl")
    writeFileSync(eventsPath, JSON.stringify({
      type: "study.freeze",
      taskId: "038-S1",
      ts: "2026-08-15T09:00:00.000Z",
    }))

    try {
      const registry = new StudyRegistry(eventsPath, ["038-S1"], {
        getTaskFreezeSnapshot: () => null,
        getQuestionnaireSubmission: () => null,
        getSessionCompletion: () => null,
        getSusSubmission: () => null,
      })

      expect(registry.freezeState("038-S1")).toBe("frozen")
      expect(registry.frozenAt("038-S1")).toBe("2026-08-15T09:00:00.000Z")
      expect(registry.questionnairePending()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
