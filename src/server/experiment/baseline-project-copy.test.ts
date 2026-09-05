import { describe, expect, test } from "bun:test"
import { BaselineProjectCopyCoordinator } from "./baseline-project-copy"
import { StudyMemoryStore } from "./study-memory-store"

describe("BaselineProjectCopyCoordinator", () => {
  test("rejects a target whose representation is not an exact copy of the source", async () => {
    const store = new StudyMemoryStore(":memory:")
    store.createFreezeSnapshot({
      snapshotId: "snapshot-copy-mismatch",
      taskId: "038-S2",
      frozenAt: "2026-08-16T10:00:00.000Z",
    })
    const coordinator = new BaselineProjectCopyCoordinator({
      store,
      adapter: {
        condition: "auto",
        prepare: async () => ({
          sourceRepresentationHash: "a".repeat(64),
          targetRepresentationHash: "b".repeat(64),
          manifest: { schemaVersion: 1, clones: [] },
        }),
      },
    })

    await expect(coordinator.prepareNextSession({
      fromTaskId: "038-S2",
      toTaskId: "098-S1",
      sourceFreezeRef: {
        taskId: "038-S2",
        snapshotId: "snapshot-copy-mismatch",
        frozenAt: "2026-08-16T10:00:00.000Z",
      },
    })).rejects.toThrow(/exact copy/i)
    expect(store.getBaselineProjectCopyTransition("038-S2", "098-S1")?.status).toBe("preparing")
    store.close()
  })
})
