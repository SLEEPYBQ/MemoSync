import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MemoryService } from "../memory"
import { createAutoProjectCopyAdapter } from "../memory/auto-project-copy-adapter"
import { createAutoProjectCopyService } from "../memory/auto-project-copy"
import { buildPlainMemoryBlock } from "../memory/prompt"
import { createSummaryService } from "../memory/summary"
import type { RegisteredStudyProject } from "../study-projects"
import { snapshotStudyWorkspace } from "../study-workspace-snapshot"
import { resolveConditionPolicy } from "./condition"
import { StudyMemoryStore } from "./study-memory-store"
import { createStudyBaselineProjectCopyPreparer } from "./study-baseline-project-copy"

const roots: string[] = []

afterEach(() => {
  function makeWritable(target: string): void {
    const info = lstatSync(target)
    if (info.isSymbolicLink()) return
    if (!info.isDirectory()) {
      chmodSync(target, 0o600)
      return
    }
    chmodSync(target, 0o700)
    for (const entry of readdirSync(target)) makeWritable(path.join(target, entry))
  }

  for (const root of roots.splice(0)) {
    try {
      makeWritable(root)
    } catch {
      // A rejected preparation may leave no snapshot evidence to unlock.
    }
    rmSync(root, { recursive: true, force: true })
  }
})

describe("createStudyBaselineProjectCopyPreparer", () => {
  test("keeps MemoSync and non-study runtimes outside the baseline Project Copy gate", () => {
    const root = mkdtempSync(path.join(tmpdir(), "memosync-study-copy-runtime-"))
    roots.push(root)
    const memory = new MemoryService({
      dbPath: path.join(root, "memory.sqlite"),
      dataDir: path.join(root, "projection"),
    })
    const store = new StudyMemoryStore(":memory:")
    const common = {
      store,
      dataDir: root,
      memory,
      summaries: null,
      assignedProjects: new Map(),
    }

    expect(createStudyBaselineProjectCopyPreparer({
      ...common,
      policy: resolveConditionPolicy("memosync"),
    })).toBeNull()
    expect(createStudyBaselineProjectCopyPreparer({
      ...common,
      policy: { ...resolveConditionPolicy("static"), studyMode: false },
    })).toBeNull()

    store.close()
    memory.close()
  })

  test("fails closed when Study Auto has no summary service for its final source projection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "memosync-study-copy-runtime-"))
    roots.push(root)
    const memory = new MemoryService({
      dbPath: path.join(root, "memory.sqlite"),
      dataDir: path.join(root, "projection"),
    })
    const store = new StudyMemoryStore(":memory:")

    expect(() => createStudyBaselineProjectCopyPreparer({
      policy: resolveConditionPolicy("auto"),
      store,
      dataDir: root,
      memory,
      summaries: null,
      assignedProjects: new Map(),
    })).toThrow(/Study Auto.*summary service.*Project Copy/i)

    store.close()
    memory.close()
  })

  test("constructs Study Auto's trusted adapter and durable transition coordinator", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memosync-study-copy-runtime-"))
    roots.push(root)
    const memory = new MemoryService({
      dbPath: path.join(root, "memory.sqlite"),
      dataDir: path.join(root, "projection"),
    })
    const store = new StudyMemoryStore(":memory:")
    try {
      memory.store.create({
        content: "Apartment cancellation requires confirmation",
        scope: "project",
        projectId: "project-apartment",
        type: "constraint",
      }, { actor: "agent" })
      const summaries = createSummaryService({
        memory,
        callJson: async () => ({ summary: "## Constraints\nConfirm apartment cancellation." }),
      })
      const assignedProjects = new Map<"apartment" | "car", RegisteredStudyProject>([
        ["apartment", {
          projectId: "project-apartment",
          localPath: path.join(root, "apartment"),
          title: "Apartment rentals",
          starterReady: true,
        }],
        ["car", {
          projectId: "project-car",
          localPath: path.join(root, "car"),
          title: "Car rentals",
          starterReady: true,
        }],
      ])
      store.createFreezeSnapshot({
        taskId: "038-S2",
        snapshotId: "snapshot-auto-runtime",
        frozenAt: "2026-08-19T09:00:00.000Z",
      })

      const preparer = createStudyBaselineProjectCopyPreparer({
        policy: resolveConditionPolicy("auto"),
        store,
        dataDir: root,
        memory,
        summaries,
        assignedProjects,
      })
      expect(preparer).not.toBeNull()

      const transition = await preparer!.prepareNextSession({
        fromTaskId: "038-S2",
        toTaskId: "098-S1",
        sourceFreezeRef: {
          taskId: "038-S2",
          snapshotId: "snapshot-auto-runtime",
          frozenAt: "2026-08-19T09:00:00.000Z",
        },
      })

      expect(transition).toMatchObject({ status: "ready", condition: "auto" })
      expect(memory.autoProjectMemories("project-car").map((item) => item.content)).toEqual([
        "Apartment cancellation requires confirmation",
      ])
    } finally {
      store.close()
      memory.close()
    }
  })

  test("recovers an existing Auto preparing receipt from a stale source summary without calling the provider", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memosync-study-copy-runtime-"))
    roots.push(root)
    const memory = new MemoryService({
      dbPath: path.join(root, "memory.sqlite"),
      dataDir: path.join(root, "projection"),
    })
    const store = new StudyMemoryStore(":memory:")
    try {
      memory.store.create({
        content: "Keep the existing stack for the apartment project",
        scope: "project",
        projectId: "project-apartment",
        type: "constraint",
      }, { actor: "agent" })
      let providerCalls = 0
      const summaries = createSummaryService({
        memory,
        callJson: async () => {
          providerCalls += 1
          if (providerCalls > 1) {
            throw new Error("DeepSeek output truncated at max_tokens=4000")
          }
          return { summary: "## Constraints\nKeep the existing stack." }
        },
      })
      await summaries.refresh("project-apartment")
      memory.store.create({
        content: "Use a warm off-white background and dark red accents",
        scope: "project",
        projectId: "project-apartment",
        type: "preference",
      }, { actor: "agent" })
      expect(summaries.get("project-apartment").stale).toBe(true)

      const frozenAt = "2026-08-19T09:00:00.000Z"
      store.createFreezeSnapshot({
        taskId: "038-S2",
        snapshotId: "snapshot-auto-preparing-retry",
        frozenAt,
      })
      store.beginBaselineProjectCopyTransition({
        fromTaskId: "038-S2",
        toTaskId: "098-S1",
        condition: "auto",
        sourceSnapshotId: "snapshot-auto-preparing-retry",
        sourceFrozenAt: frozenAt,
        startedAt: "2026-08-19T09:01:00.000Z",
      })
      const assignedProjects = new Map<"apartment" | "car", RegisteredStudyProject>([
        ["apartment", {
          projectId: "project-apartment",
          localPath: path.join(root, "apartment"),
          title: "Apartment rentals",
          starterReady: true,
        }],
        ["car", {
          projectId: "project-car",
          localPath: path.join(root, "car"),
          title: "Car rentals",
          starterReady: true,
        }],
      ])
      const makePreparer = () => createStudyBaselineProjectCopyPreparer({
        policy: resolveConditionPolicy("auto"),
        store,
        dataDir: root,
        memory,
        summaries,
        assignedProjects,
      })!
      const input = {
        fromTaskId: "038-S2",
        toTaskId: "098-S1",
        sourceFreezeRef: {
          taskId: "038-S2",
          snapshotId: "snapshot-auto-preparing-retry",
          frozenAt,
        },
      }
      const sourceBlock = buildPlainMemoryBlock(memory.autoProjectMemories("project-apartment"))

      const conditionReceipt = await createAutoProjectCopyAdapter({
        memory,
        summaries,
        resolveProject: (slug) => {
          const project = assignedProjects.get(slug as "apartment" | "car")
          return project
            ? { projectId: project.projectId, starterReady: project.starterReady }
            : undefined
        },
      }).prepare({
        transitionKey: "snapshot-auto-preparing-retry:038-S2->098-S1",
        fromTaskId: "038-S2",
        fromProjectSlug: "apartment",
        toTaskId: "098-S1",
        toProjectSlug: "car",
        sourceFreezeRef: input.sourceFreezeRef,
      })
      const targetIds = memory.autoProjectMemories("project-car").map((item) => item.id)

      expect(conditionReceipt.manifest).toMatchObject({ outcome: "copied" })
      expect(store.getBaselineProjectCopyTransition("038-S2", "098-S1")?.status).toBe("preparing")

      const first = await makePreparer().prepareNextSession(input)

      expect(first).toMatchObject({ status: "ready", condition: "auto" })
      expect(providerCalls).toBe(1)
      expect(buildPlainMemoryBlock(memory.autoProjectMemories("project-car"))).toBe(sourceBlock)
      const sourceSummary = summaries.get("project-apartment")
      const targetSummary = summaries.get("project-car")
      expect(sourceSummary).toEqual(targetSummary)
      expect(sourceSummary).toMatchObject({ stale: false, updatedAt: expect.any(String) })
      expect(sourceSummary.updatedAt).not.toBe("")
      expect(sourceSummary.text).toContain("warm off-white background and dark red accents")
      expect(memory.autoProjectMemories("project-car").map((item) => item.id)).toEqual(targetIds)

      const retry = await makePreparer().prepareNextSession(input)

      expect(retry).toEqual(first)
      expect(providerCalls).toBe(1)
      expect(memory.autoProjectMemories("project-car").map((item) => item.id)).toEqual(targetIds)
      expect(createAutoProjectCopyService({ memory }).getReceipt(
        "snapshot-auto-preparing-retry:038-S2->098-S1",
      )?.created).toBe(false)
    } finally {
      store.close()
      memory.close()
    }
  })

  test("constructs Study Static's verified snapshot adapter and durable transition coordinator", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memosync-study-copy-runtime-"))
    roots.push(root)
    const dataDir = path.join(root, "data")
    const sourceWorkspace = path.join(root, "apartment")
    const targetWorkspace = path.join(root, "car")
    mkdirSync(sourceWorkspace, { recursive: true })
    mkdirSync(targetWorkspace, { recursive: true })
    writeFileSync(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Confirm apartment cancellation.\n")
    const snapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: sourceWorkspace,
      taskId: "038-S2",
      snapshotId: "snapshot-static-runtime",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    const memory = new MemoryService({
      dbPath: path.join(root, "memory.sqlite"),
      dataDir: path.join(root, "projection"),
    })
    const store = new StudyMemoryStore(":memory:")
    try {
      store.createFreezeSnapshot({
        taskId: "038-S2",
        snapshotId: snapshot.snapshotId,
        frozenAt: snapshot.frozenAt,
        workspaceSnapshot: snapshot,
      })
      const assignedProjects = new Map<"apartment" | "car", RegisteredStudyProject>([
        ["apartment", {
          projectId: "project-apartment",
          localPath: sourceWorkspace,
          title: "Apartment rentals",
          starterReady: true,
        }],
        ["car", {
          projectId: "project-car",
          localPath: targetWorkspace,
          title: "Car rentals",
          starterReady: true,
        }],
      ])

      const preparer = createStudyBaselineProjectCopyPreparer({
        policy: resolveConditionPolicy("static"),
        store,
        dataDir,
        memory,
        summaries: null,
        assignedProjects,
      })
      expect(preparer).not.toBeNull()

      const transition = await preparer!.prepareNextSession({
        fromTaskId: "038-S2",
        toTaskId: "098-S1",
        sourceFreezeRef: {
          taskId: "038-S2",
          snapshotId: snapshot.snapshotId,
          frozenAt: snapshot.frozenAt,
          workspaceSnapshot: snapshot,
        },
      })

      expect(transition).toMatchObject({
        status: "ready",
        condition: "static",
        manifest: {
          kind: "static_markdown_files",
          source: { projectId: "project-apartment", snapshotId: snapshot.snapshotId },
          target: { projectId: "project-car" },
        },
      })
      expect(readFileSync(path.join(targetWorkspace, "MEMORY.md"), "utf8"))
        .toBe("# Memory\n- Confirm apartment cancellation.\n")
    } finally {
      store.close()
      memory.close()
    }
  })
})
