import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StudyRawTlxActivityResponse } from "../shared/studyScales"
import { BaselineProjectCopyCoordinator } from "./experiment/baseline-project-copy"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import { StudyRegistry } from "./study-registry"
import { StudySurveyService } from "./study-survey-service"

function rawTlx(activity: "monitoring" | "control"): StudyRawTlxActivityResponse {
  return {
    instrument: "raw_tlx",
    instrumentVersion: 1,
    activity,
    ratings: {
      mentalDemand: 60,
      physicalDemand: 5,
      temporalDemand: 40,
      performance: 25,
      effort: 55,
      frustration: 20,
    },
  }
}

function freezeAndSubmitQuiz(store: StudyMemoryStore, taskId: string, snapshotId: string): void {
  store.createFreezeSnapshot({
    snapshotId,
    taskId,
    frozenAt: "2026-08-16T10:00:00.000Z",
  })
  store.recordQuestionnaireSubmission({
    submissionId: `quiz-${taskId}`,
    snapshotId,
    submittedAt: "2026-08-16T10:05:00.000Z",
    questionnaireVersion: 2,
    answers: [],
  })
}

describe("StudySurveyService", () => {
  test("requires every composition to state whether next-session preparation is enabled", () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S1"], store)
    const explicitMemoSyncInput: ConstructorParameters<typeof StudySurveyService>[0] = {
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      nextSessionPreparer: null,
    }

    expect(new StudySurveyService(explicitMemoSyncInput)).toBeInstanceOf(StudySurveyService)

    // @ts-expect-error The treatment decision must never fall back to omission.
    const omittedTreatmentDecision: ConstructorParameters<typeof StudySurveyService>[0] = {
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
    }
    void omittedTreatmentDecision
    store.close()
  })

  test("prepares a durable baseline project copy before completing the project boundary", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S2", "098-S1"], store)
    freezeAndSubmitQuiz(store, "038-S2", "snapshot-project-boundary")
    const ids = ["tlx-monitoring", "tlx-control", "session-completion"]
    const sourceHash = "a".repeat(64)
    const targetHash = sourceHash
    const transition = new BaselineProjectCopyCoordinator({
      store,
      adapter: {
        condition: "auto",
        prepare: async (input) => {
          expect(input).toMatchObject({
            fromTaskId: "038-S2",
            fromProjectSlug: "apartment",
            toTaskId: "098-S1",
            toProjectSlug: "car",
            sourceFreezeRef: {
              taskId: "038-S2",
              snapshotId: "snapshot-project-boundary",
            },
          })
          expect(store.getRawTlxSubmission("snapshot-project-boundary", "control")).toBeNull()
          expect(registry.taskStatus("098-S1")).toBe("locked")
          return {
            sourceRepresentationHash: sourceHash,
            targetRepresentationHash: targetHash,
            manifest: { schemaVersion: 1, copiedItems: [] },
          }
        },
      },
      now: () => "2026-08-16T10:09:00.000Z",
    })
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      now: () => "2026-08-16T10:10:00.000Z",
      randomId: () => ids.shift()!,
      nextSessionPreparer: transition,
    })

    await service.submitRawTlx({
      taskId: "038-S2",
      snapshotId: "snapshot-project-boundary",
      response: rawTlx("monitoring"),
    })
    const result = await service.submitRawTlx({
      taskId: "038-S2",
      snapshotId: "snapshot-project-boundary",
      response: rawTlx("control"),
    })

    expect(result).toMatchObject({ requiredStep: "next_session", nextTaskId: "098-S1" })
    expect(registry.taskStatus("038-S2")).toBe("completed")
    expect(registry.taskStatus("098-S1")).toBe("active")
    expect(store.getBaselineProjectCopyTransition("038-S2", "098-S1")).toMatchObject({
      status: "ready",
      condition: "auto",
      sourceSnapshotId: "snapshot-project-boundary",
      sourceRepresentationHash: sourceHash,
      targetRepresentationHash: targetHash,
      manifest: { schemaVersion: 1, copiedItems: [] },
    })
    store.close()
  })

  test("does not prepare a project copy between two sessions in the same project", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"], store)
    freezeAndSubmitQuiz(store, "038-S1", "snapshot-same-project")
    const ids = ["tlx-monitoring", "tlx-control", "session-completion"]
    const transition = new BaselineProjectCopyCoordinator({
      store,
      adapter: {
        condition: "static",
        prepare: async () => {
          throw new Error("same-project transition must not invoke the copy adapter")
        },
      },
    })
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      randomId: () => ids.shift()!,
      nextSessionPreparer: transition,
    })

    await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-same-project",
      response: rawTlx("monitoring"),
    })
    const result = await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-same-project",
      response: rawTlx("control"),
    })

    expect(result).toMatchObject({ requiredStep: "next_session", nextTaskId: "038-S2" })
    expect(store.getBaselineProjectCopyTransition("038-S1", "038-S2")).toBeNull()
    store.close()
  })

  test("does not prepare a project copy after the final task", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["098-S2"], store)
    freezeAndSubmitQuiz(store, "098-S2", "snapshot-final-copy")
    const ids = ["tlx-monitoring", "tlx-control", "session-completion"]
    const transition = new BaselineProjectCopyCoordinator({
      store,
      adapter: {
        condition: "auto",
        prepare: async () => {
          throw new Error("final task must not invoke the copy adapter")
        },
      },
    })
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      randomId: () => ids.shift()!,
      nextSessionPreparer: transition,
    })

    await service.submitRawTlx({
      taskId: "098-S2",
      snapshotId: "snapshot-final-copy",
      response: rawTlx("monitoring"),
    })
    const result = await service.submitRawTlx({
      taskId: "098-S2",
      snapshotId: "snapshot-final-copy",
      response: rawTlx("control"),
    })

    expect(result).toMatchObject({ requiredStep: "sus", sessionCompleted: true })
    store.close()
  })

  test("keeps Control TLX and the next task locked until a failed empty project copy succeeds", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S2", "098-S1"], store)
    freezeAndSubmitQuiz(store, "038-S2", "snapshot-copy-retry")
    const ids = ["tlx-monitoring", "tlx-control", "session-completion"]
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    let shouldFail = true
    let attempts = 0
    const transition = new BaselineProjectCopyCoordinator({
      store,
      adapter: {
        condition: "static",
        prepare: async () => {
          attempts += 1
          if (shouldFail) throw new Error("destination workspace is unavailable")
          return {
            sourceRepresentationHash: emptyHash,
            targetRepresentationHash: emptyHash,
            manifest: { schemaVersion: 1, files: [], totalBytes: 0 },
          }
        },
      },
    })
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      randomId: () => ids.shift()!,
      nextSessionPreparer: transition,
    })
    await service.submitRawTlx({
      taskId: "038-S2",
      snapshotId: "snapshot-copy-retry",
      response: rawTlx("monitoring"),
    })

    await expect(service.submitRawTlx({
      taskId: "038-S2",
      snapshotId: "snapshot-copy-retry",
      response: rawTlx("control"),
    })).rejects.toThrow("destination workspace is unavailable")
    expect(store.getRawTlxSubmission("snapshot-copy-retry", "control")).toBeNull()
    expect(store.getSessionCompletion("038-S2")).toBeNull()
    expect(registry.taskStatus("098-S1")).toBe("locked")
    expect(store.getBaselineProjectCopyTransition("038-S2", "098-S1")).toMatchObject({
      status: "preparing",
      sourceRepresentationHash: null,
      targetRepresentationHash: null,
      manifest: null,
    })

    shouldFail = false
    const result = await service.submitRawTlx({
      taskId: "038-S2",
      snapshotId: "snapshot-copy-retry",
      response: rawTlx("control"),
    })

    expect(result).toMatchObject({ requiredStep: "next_session", nextTaskId: "098-S1" })
    expect(attempts).toBe(2)
    expect(store.getBaselineProjectCopyTransition("038-S2", "098-S1")).toMatchObject({
      status: "ready",
      sourceRepresentationHash: emptyHash,
      targetRepresentationHash: emptyHash,
      manifest: { schemaVersion: 1, files: [], totalBytes: 0 },
    })
    store.close()
  })

  test("reuses a durable ready receipt after the process stops between copy preparation and completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-project-copy-restart-"))
    const dbPath = join(dir, "study.sqlite")
    const representationHash = "c".repeat(64)
    try {
      const firstStore = new StudyMemoryStore(dbPath)
      const firstRegistry = new StudyRegistry(undefined, ["038-S2", "098-S1"], firstStore)
      freezeAndSubmitQuiz(firstStore, "038-S2", "snapshot-copy-restart")
      let firstAdapterAttempts = 0
      const firstTransition = new BaselineProjectCopyCoordinator({
        store: firstStore,
        adapter: {
          condition: "auto",
          prepare: async () => {
            firstAdapterAttempts += 1
            return {
              sourceRepresentationHash: representationHash,
              targetRepresentationHash: representationHash,
              manifest: { schemaVersion: 1, itemCount: 0, clones: [] },
            }
          },
        },
      })
      const firstIds = ["duplicate-submission-id", "duplicate-submission-id", "unused-completion-id"]
      const firstService = new StudySurveyService({
        store: firstStore,
        registry: firstRegistry,
      allocationParticipantId: "P77",
        logger: { event: () => {} },
        randomId: () => firstIds.shift()!,
        nextSessionPreparer: firstTransition,
      })
      await firstService.submitRawTlx({
        taskId: "038-S2",
        snapshotId: "snapshot-copy-restart",
        response: rawTlx("monitoring"),
      })

      await expect(firstService.submitRawTlx({
        taskId: "038-S2",
        snapshotId: "snapshot-copy-restart",
        response: rawTlx("control"),
      })).rejects.toThrow()
      expect(firstAdapterAttempts).toBe(1)
      expect(firstStore.getBaselineProjectCopyTransition("038-S2", "098-S1")?.status).toBe("ready")
      expect(firstStore.getRawTlxSubmission("snapshot-copy-restart", "control")).toBeNull()
      expect(firstStore.getSessionCompletion("038-S2")).toBeNull()
      firstStore.close()

      const secondStore = new StudyMemoryStore(dbPath)
      const secondRegistry = new StudyRegistry(undefined, ["038-S2", "098-S1"], secondStore)
      let secondAdapterAttempts = 0
      const secondTransition = new BaselineProjectCopyCoordinator({
        store: secondStore,
        adapter: {
          condition: "auto",
          prepare: async () => {
            secondAdapterAttempts += 1
            throw new Error("a ready receipt must skip the adapter")
          },
        },
      })
      const secondIds = ["control-after-restart", "completion-after-restart"]
      const secondService = new StudySurveyService({
        store: secondStore,
        registry: secondRegistry,
      allocationParticipantId: "P77",
        logger: { event: () => {} },
        randomId: () => secondIds.shift()!,
        nextSessionPreparer: secondTransition,
      })

      const result = await secondService.submitRawTlx({
        taskId: "038-S2",
        snapshotId: "snapshot-copy-restart",
        response: rawTlx("control"),
      })

      expect(result).toMatchObject({ requiredStep: "next_session", nextTaskId: "098-S1" })
      expect(secondAdapterAttempts).toBe(0)
      expect(secondRegistry.taskStatus("098-S1")).toBe("active")
      secondStore.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unlocks the next session only after both activity Raw TLX blocks", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"], store)
    freezeAndSubmitQuiz(store, "038-S1", "snapshot-1")
    const ids = ["tlx-monitoring", "tlx-control", "session-completion"]
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      now: () => "2026-08-16T10:10:00.000Z",
      randomId: () => ids.shift()!,
      nextSessionPreparer: null,
    })

    expect(service.get("038-S1")).toMatchObject({ requiredStep: "monitoring_tlx" })

    expect(await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-1",
      response: rawTlx("monitoring"),
    })).toMatchObject({ requiredStep: "control_tlx" })
    expect(registry.taskStatus("038-S2")).toBe("locked")

    expect(await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-1",
      response: rawTlx("control"),
    })).toMatchObject({ requiredStep: "next_session", nextTaskId: "038-S2" })
    expect(registry.taskStatus("038-S1")).toBe("completed")
    expect(registry.taskStatus("038-S2")).toBe("active")
    store.close()
  })

  test("requires one final SUS before the study is complete", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S1"], store)
    freezeAndSubmitQuiz(store, "038-S1", "snapshot-final")
    let nextId = 0
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      now: () => "2026-08-16T11:00:00.000Z",
      randomId: () => `generated-${++nextId}`,
      nextSessionPreparer: null,
      completionUrl: "https://app.prolific.com/submissions/complete?cc=CAAML5VN",
    })

    await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-final",
      response: rawTlx("monitoring"),
    })
    expect(await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-final",
      response: rawTlx("control"),
    })).toMatchObject({ requiredStep: "sus", sessionCompleted: true, susSubmitted: false })
    expect(registry.susPending()).toBe(true)
    expect(registry.studyComplete()).toBe(false)

    // No completion code exists or leaks before the final SUS is accepted.
    expect(store.getCompletionReceipt()).toBeNull()
    expect(service.get("038-S1").completionCode).toBeNull()
    expect(service.get("038-S1").completionUrl).toBeNull()

    const susResponse = {
      instrument: "sus",
      instrumentVersion: 1,
      ratings: { q1: 5, q2: 1, q3: 5, q4: 1, q5: 5, q6: 1, q7: 5, q8: 1, q9: 5, q10: 1 },
    }
    expect(service.submitSus({
      taskId: "038-S1",
      response: susResponse,
    })).toMatchObject({
      requiredStep: "complete",
      susSubmitted: true,
      completionCode: "CAAML5VN",
      completionUrl: "https://app.prolific.com/submissions/complete?cc=CAAML5VN",
    })
    expect(registry.studyComplete()).toBe(true)

    // The durable receipt was written with the same acceptance.
    const receipt = store.getCompletionReceipt()
    expect(receipt).toMatchObject({
      participantId: "P77",
      code: "CAAML5VN",
      issuedAt: "2026-08-16T11:00:00.000Z",
    })
    expect(receipt?.susSubmissionId).toBeTruthy()
    expect(receipt?.codeVersion).toBeTruthy()

    // An exact retry returns the same receipt and timestamp.
    expect(service.submitSus({ taskId: "038-S1", response: susResponse }))
      .toMatchObject({ requiredStep: "complete", completionCode: "CAAML5VN" })
    expect(store.getCompletionReceipt()).toEqual(receipt)
    store.close()
  })

  test("the completion receipt survives a real store restart with the same code and timestamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-survey-receipt-"))
    const dbPath = join(dir, "study.sqlite")
    try {
    const store = new StudyMemoryStore(dbPath)
    const registry = new StudyRegistry(undefined, ["038-S1"], store)
    freezeAndSubmitQuiz(store, "038-S1", "snapshot-final")
    let nextId = 0
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      now: () => "2026-08-16T11:00:00.000Z",
      randomId: () => `generated-${++nextId}`,
      nextSessionPreparer: null,
    })
    await service.submitRawTlx({ taskId: "038-S1", snapshotId: "snapshot-final", response: rawTlx("monitoring") })
    await service.submitRawTlx({ taskId: "038-S1", snapshotId: "snapshot-final", response: rawTlx("control") })
    const susResponse = {
      instrument: "sus",
      instrumentVersion: 1,
      ratings: { q1: 5, q2: 1, q3: 5, q4: 1, q5: 5, q6: 1, q7: 5, q8: 1, q9: 5, q10: 1 },
    }
    service.submitSus({ taskId: "038-S1", response: susResponse })
    const issued = store.getCompletionReceipt()
    store.close()

    const reopened = new StudyMemoryStore(dbPath)
    const restartedRegistry = new StudyRegistry(undefined, ["038-S1"], reopened)
    const restarted = new StudySurveyService({
      store: reopened,
      registry: restartedRegistry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      now: () => "2026-08-16T12:00:00.000Z",
      randomId: () => "post-restart",
      nextSessionPreparer: null,
    })
    expect(reopened.getCompletionReceipt()).toEqual(issued)
    expect(restarted.get("038-S1")).toMatchObject({ requiredStep: "complete", completionCode: "CAAML5VN" })
    // A post-restart exact retry still returns the original receipt.
    restarted.submitSus({ taskId: "038-S1", response: susResponse })
    expect(reopened.getCompletionReceipt()).toEqual(issued)
    reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("GET repairs a legacy terminal SUS row and returns the same code across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-survey-legacy-receipt-"))
    const dbPath = join(dir, "study.sqlite")
    try {
      const firstStore = new StudyMemoryStore(dbPath)
      const firstRegistry = new StudyRegistry(undefined, ["038-S1"], firstStore)
      freezeAndSubmitQuiz(firstStore, "038-S1", "snapshot-legacy-terminal")
      let nextId = 0
      const firstService = new StudySurveyService({
        store: firstStore,
        registry: firstRegistry,
        allocationParticipantId: "P-LEGACY",
        logger: { event: () => {} },
        now: () => "2026-08-16T11:00:00.000Z",
        randomId: () => `legacy-${++nextId}`,
        nextSessionPreparer: null,
      })
      await firstService.submitRawTlx({
        taskId: "038-S1",
        snapshotId: "snapshot-legacy-terminal",
        response: rawTlx("monitoring"),
      })
      await firstService.submitRawTlx({
        taskId: "038-S1",
        snapshotId: "snapshot-legacy-terminal",
        response: rawTlx("control"),
      })
      const susResponse = {
        instrument: "sus",
        instrumentVersion: 1,
        ratings: { q1: 5, q2: 1, q3: 5, q4: 1, q5: 5, q6: 1, q7: 5, q8: 1, q9: 5, q10: 1 },
      } as const
      firstService.submitSus({ taskId: "038-S1", response: susResponse })
      const sus = firstStore.getSusSubmission()!
      firstStore.close()

      // Simulate the exact pre-receipt schema state: final SUS is durable,
      // but no completion receipt exists yet.
      const legacy = new Database(dbPath)
      legacy.exec("DELETE FROM study_completion_receipts")
      legacy.close()

      const reopenedStore = new StudyMemoryStore(dbPath)
      const reopened = new StudySurveyService({
        store: reopenedStore,
        registry: new StudyRegistry(undefined, ["038-S1"], reopenedStore),
        allocationParticipantId: "P-LEGACY",
        logger: { event: () => {} },
        now: () => "2026-08-16T12:00:00.000Z",
        nextSessionPreparer: null,
      })
      expect(reopened.get("038-S1")).toMatchObject({
        requiredStep: "complete",
        completionCode: "CAAML5VN",
      })
      const repaired = reopenedStore.getCompletionReceipt()
      expect(repaired).toMatchObject({
        participantId: "P-LEGACY",
        susSubmissionId: sus.submissionId,
        issuedAt: sus.submittedAt,
      })
      expect(reopened.get("038-S1").completionCode).toBe("CAAML5VN")
      reopenedStore.close()

      const restartedStore = new StudyMemoryStore(dbPath)
      const restarted = new StudySurveyService({
        store: restartedStore,
        registry: new StudyRegistry(undefined, ["038-S1"], restartedStore),
        allocationParticipantId: "P-LEGACY",
        logger: { event: () => {} },
        now: () => "2026-08-16T13:00:00.000Z",
        nextSessionPreparer: null,
      })
      expect(restarted.get("038-S1").completionCode).toBe("CAAML5VN")
      expect(restartedStore.getCompletionReceipt()).toEqual(repaired)
      restartedStore.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resumes the first incomplete workload block after a server restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-study-survey-"))
    const dbPath = join(dir, "study.sqlite")
    try {
      const firstStore = new StudyMemoryStore(dbPath)
      const firstRegistry = new StudyRegistry(undefined, ["038-S1", "038-S2"], firstStore)
      freezeAndSubmitQuiz(firstStore, "038-S1", "snapshot-restart")
      const firstService = new StudySurveyService({
        store: firstStore,
        registry: firstRegistry,
      allocationParticipantId: "P77",
        logger: { event: () => {} },
        nextSessionPreparer: null,
      })
      await firstService.submitRawTlx({
        taskId: "038-S1",
        snapshotId: "snapshot-restart",
        response: rawTlx("monitoring"),
      })
      firstStore.close()

      const secondStore = new StudyMemoryStore(dbPath)
      const secondRegistry = new StudyRegistry(undefined, ["038-S1", "038-S2"], secondStore)
      const secondService = new StudySurveyService({
        store: secondStore,
        registry: secondRegistry,
      allocationParticipantId: "P77",
        logger: { event: () => {} },
        nextSessionPreparer: null,
      })
      expect(secondService.get("038-S1")).toMatchObject({ requiredStep: "control_tlx" })
      expect(secondRegistry.taskStatus("038-S2")).toBe("locked")
      await secondService.submitRawTlx({
        taskId: "038-S1",
        snapshotId: "snapshot-restart",
        response: rawTlx("control"),
      })
      secondStore.close()

      const thirdStore = new StudyMemoryStore(dbPath)
      const thirdRegistry = new StudyRegistry(undefined, ["038-S1", "038-S2"], thirdStore)
      const thirdService = new StudySurveyService({
        store: thirdStore,
        registry: thirdRegistry,
      allocationParticipantId: "P77",
        logger: { event: () => {} },
        nextSessionPreparer: null,
      })
      expect(thirdService.get("038-S1")).toMatchObject({
        requiredStep: "next_session",
        nextTaskId: "038-S2",
      })
      expect(thirdRegistry.taskStatus("038-S2")).toBe("active")
      thirdStore.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps retries idempotent and rejects out-of-order or changed answers", async () => {
    const store = new StudyMemoryStore(":memory:")
    const registry = new StudyRegistry(undefined, ["038-S1"], store)
    freezeAndSubmitQuiz(store, "038-S1", "snapshot-idempotent")
    let nextId = 0
    const service = new StudySurveyService({
      store,
      registry,
      allocationParticipantId: "P77",
      logger: { event: () => {} },
      randomId: () => `retry-${++nextId}`,
      nextSessionPreparer: null,
    })

    await expect(service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-idempotent",
      response: rawTlx("control"),
    })).rejects.toThrow(/Monitoring Raw TLX/)

    const monitoring = rawTlx("monitoring")
    await service.submitRawTlx({ taskId: "038-S1", snapshotId: "snapshot-idempotent", response: monitoring })
    expect(await service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-idempotent",
      response: monitoring,
    })).toMatchObject({ requiredStep: "control_tlx" })
    expect(store.getRawTlxSubmission("snapshot-idempotent", "monitoring")?.submissionId).toBe("retry-3")

    await expect(service.submitRawTlx({
      taskId: "038-S1",
      snapshotId: "snapshot-idempotent",
      response: {
        ...monitoring,
        ratings: { ...monitoring.ratings, effort: 95 },
      },
    })).rejects.toThrow(/already exists/)
    store.close()
  })
})
