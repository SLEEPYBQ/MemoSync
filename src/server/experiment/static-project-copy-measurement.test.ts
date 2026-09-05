import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildStudyStaticFocusPayload,
  readStudyStaticMemoryFiles,
} from "../memory/static-files"
import type { RegisteredStudyProject } from "../study-projects"
import { snapshotStudyWorkspace } from "../study-workspace-snapshot"
import { BaselineProjectCopyCoordinator } from "./baseline-project-copy"
import { materializeDeliveredStaticFocus } from "./static-focus"
import { resolveFrozenStaticObjectStates } from "./static-freeze"
import { createStaticMemoryExtractor } from "./static-memory-extractor"
import { StudyMemoryStore } from "./study-memory-store"
import { createStaticProjectCopyAdapter } from "./static-project-copy-adapter"

const roots: string[] = []

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

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      makeWritable(root)
    } catch {
      // A failed preparation may not have published snapshot evidence.
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "static-copy-measurement-"))
  roots.push(root)
  const dataDir = path.join(root, "data")
  const sourceWorkspace = path.join(root, "apartment")
  const targetWorkspace = path.join(root, "car")
  mkdirSync(sourceWorkspace, { recursive: true })
  mkdirSync(targetWorkspace, { recursive: true })
  const sourceText = "# Memory\n\n- Apartment cancellations require confirmation.\n"
  writeFileSync(path.join(sourceWorkspace, "MEMORY.md"), sourceText)
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
  const extractor = createStaticMemoryExtractor({
    callJson: async ({ user }) => ({
      atoms: [{
        content: user.includes("two-step")
          ? "Car cancellations require two-step confirmation."
          : "Apartment cancellations require confirmation.",
      }],
    }),
    modelId: "test",
  })
  return {
    dataDir,
    sourceWorkspace,
    targetWorkspace,
    sourceText,
    assignedProjects,
    extractor,
  }
}

async function focusWorkspace(args: {
  store: StudyMemoryStore
  extractor: ReturnType<typeof createStaticMemoryExtractor>
  workspaceDir: string
  taskId: string
  namespace: string
  injectionId: string
  turn: number
  focusedAt: string
}) {
  const payload = buildStudyStaticFocusPayload(readStudyStaticMemoryFiles(args.workspaceDir))
  await materializeDeliveredStaticFocus({
    store: args.store,
    extractor: args.extractor,
    logger: { event: () => {} },
    taskId: args.taskId,
    namespace: args.namespace,
    chatId: `${args.taskId}-chat`,
    turnId: `${args.taskId}-turn-${args.turn}`,
    turn: args.turn,
    promptText: payload.text,
    payload,
    injectionId: args.injectionId,
    focusedAt: args.focusedAt,
  })
  return args.store.listTaskDeliveries(args.taskId).at(-1)!
}

async function prepareCopy(args: {
  fixture: ReturnType<typeof createFixture>
  store: StudyMemoryStore
  snapshotId: string
  frozenAt: string
}) {
  const snapshot = await snapshotStudyWorkspace({
    dataDir: args.fixture.dataDir,
    sourceDir: args.fixture.sourceWorkspace,
    taskId: "038-S2",
    snapshotId: args.snapshotId,
    project: { slug: "apartment", title: "Apartment rentals" },
    frozenAt: args.frozenAt,
  })
  args.store.createFreezeSnapshot({
    taskId: "038-S2",
    snapshotId: snapshot.snapshotId,
    frozenAt: snapshot.frozenAt,
    objectStates: args.store.getStaticObjectStates("project-apartment"),
    workspaceSnapshot: snapshot,
  })
  const coordinator = new BaselineProjectCopyCoordinator({
    store: args.store,
    adapter: createStaticProjectCopyAdapter({
      dataDir: args.fixture.dataDir,
      assignedProjects: args.fixture.assignedProjects,
    }),
    now: () => "2026-08-19T10:02:00.000Z",
  })
  return coordinator.prepareNextSession({
    fromTaskId: "038-S2",
    toTaskId: "098-S1",
    sourceFreezeRef: {
      taskId: "038-S2",
      snapshotId: snapshot.snapshotId,
      frozenAt: snapshot.frozenAt,
      workspaceSnapshot: snapshot,
    },
  })
}

describe("Static Project Copy measurement provenance", () => {
  test("starts a target-local focus history and preserves the exact source ancestor after target edits and freeze", async () => {
    const fixture = createFixture()
    const store = new StudyMemoryStore(":memory:")
    try {
      const sourceDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.sourceWorkspace,
        taskId: "038-S1",
        namespace: "project-apartment",
        injectionId: "source-focus",
        turn: 1,
        focusedAt: "2026-08-19T10:00:00.000Z",
      })
      const sourceItem = sourceDelivery.items[0]!
      const transition = await prepareCopy({
        fixture,
        store,
        snapshotId: "snapshot-static-copy",
        frozenAt: "2026-08-19T10:01:00.000Z",
      })
      expect(transition).toMatchObject({ status: "ready", condition: "static" })
      expect(store.getTaskFreezeSnapshot("038-S2")!.items).toEqual([])
      expect(store.getStaticObjectStates("project-car")).toEqual([])
      expect(store.listTaskDeliveries("098-S1")).toEqual([])

      const targetFirstDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S1",
        namespace: "project-car",
        injectionId: "target-focus-1",
        turn: 1,
        focusedAt: "2026-08-19T10:03:00.000Z",
      })
      const targetFirst = targetFirstDelivery.items[0]!
      expect(targetFirst.identity).not.toEqual(sourceItem.identity)
      expect(targetFirst.version).toBe(1)
      expect(targetFirst.sourceRef).toMatchObject({
        projectCopy: {
          schemaVersion: 1,
          kind: "static_project_copy",
          transitionKey: "snapshot-static-copy:038-S2->098-S1",
          source: {
            taskId: "038-S2",
            projectId: "project-apartment",
            projectSlug: "apartment",
            snapshotId: "snapshot-static-copy",
            frozenAt: "2026-08-19T10:01:00.000Z",
            representationHash: transition!.sourceRepresentationHash,
          },
          target: {
            taskId: "098-S1",
            projectId: "project-car",
            projectSlug: "car",
            representationHash: transition!.targetRepresentationHash,
          },
          files: [{
            relPath: "MEMORY.md",
            copiedFileHash: sha256(fixture.sourceText),
            focusedFileContentHashes: [sha256(fixture.sourceText)],
          }],
          targetContentHashesAtFirstFocus: [sourceItem.contentHash],
          cloneOf: {
            identity: sourceItem.identity,
            version: sourceItem.version,
            contentHash: sourceItem.contentHash,
          },
        },
      })
      const firstProjectCopy = targetFirst.sourceRef.projectCopy

      writeFileSync(
        path.join(fixture.targetWorkspace, "MEMORY.md"),
        "# Memory\n\n- Car cancellations require two-step confirmation.\n",
      )
      const targetEditedDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S1",
        namespace: "project-car",
        injectionId: "target-focus-2",
        turn: 2,
        focusedAt: "2026-08-19T10:04:00.000Z",
      })
      const targetEdited = targetEditedDelivery.items[0]!
      expect(targetEdited.identity).toEqual(targetFirst.identity)
      expect(targetEdited.version).toBe(2)
      expect(targetEdited.sourceRef.projectCopy).toEqual(firstProjectCopy)

      const finalStates = await resolveFrozenStaticObjectStates({
        taskId: "098-S1",
        identities: [targetFirst.identity],
        store,
        extractor: fixture.extractor,
        getWorkspaceDir: (namespace) => namespace === "project-car" ? fixture.targetWorkspace : null,
        now: () => "2026-08-19T10:05:00.000Z",
      })
      const frozen = store.createFreezeSnapshot({
        taskId: "098-S1",
        snapshotId: "snapshot-target-freeze",
        frozenAt: "2026-08-19T10:05:00.000Z",
        objectStates: finalStates,
      })
      expect(frozen.items).toHaveLength(1)
      expect(frozen.items[0]).toMatchObject({
        identity: targetFirst.identity,
        cue: {
          version: 2,
          content: "Car cancellations require two-step confirmation.",
          sourceRef: { projectCopy: firstProjectCopy },
        },
        object: {
          version: 2,
          content: "Car cancellations require two-step confirmation.",
          sourceRef: { projectCopy: firstProjectCopy },
        },
        history: [
          { injectionId: "target-focus-1", version: 1 },
          { injectionId: "target-focus-2", version: 2 },
        ],
      })
      expect(frozen.items.some((item) => item.identity.id === sourceItem.identity.id)).toBe(false)
    } finally {
      store.close()
    }
  })

  test("keeps the copy origin and exact source clone when an unrelated target edit changes the file before first focus", async () => {
    const fixture = createFixture()
    const store = new StudyMemoryStore(":memory:")
    try {
      const sourceDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.sourceWorkspace,
        taskId: "038-S1",
        namespace: "project-apartment",
        injectionId: "source-before-target-edit",
        turn: 1,
        focusedAt: "2026-08-19T10:00:00.000Z",
      })
      const sourceItem = sourceDelivery.items[0]!
      await prepareCopy({
        fixture,
        store,
        snapshotId: "snapshot-target-edited-before-focus",
        frozenAt: "2026-08-19T10:01:00.000Z",
      })
      const editedTargetText = `${fixture.sourceText}\n- Keep the confirmation button blue.\n`
      writeFileSync(path.join(fixture.targetWorkspace, "MEMORY.md"), editedTargetText)

      const targetDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S1",
        namespace: "project-car",
        injectionId: "target-after-unrelated-edit",
        turn: 1,
        focusedAt: "2026-08-19T10:02:00.000Z",
      })

      expect(targetDelivery.items[0]!.sourceRef).toMatchObject({
        projectCopy: {
          files: [{
            relPath: "MEMORY.md",
            copiedFileHash: sha256(fixture.sourceText),
            focusedFileContentHashes: [sha256(editedTargetText)],
          }],
          targetContentHashesAtFirstFocus: [sourceItem.contentHash],
          cloneOf: {
            identity: sourceItem.identity,
            version: sourceItem.version,
            contentHash: sourceItem.contentHash,
          },
        },
      })
    } finally {
      store.close()
    }
  })

  test("keeps Project Copy provenance beside structural lineage when a target identity splits", async () => {
    const fixture = createFixture()
    const store = new StudyMemoryStore(":memory:")
    try {
      await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.sourceWorkspace,
        taskId: "038-S1",
        namespace: "project-apartment",
        injectionId: "source-before-split",
        turn: 1,
        focusedAt: "2026-08-19T10:00:00.000Z",
      })
      await prepareCopy({
        fixture,
        store,
        snapshotId: "snapshot-target-split",
        frozenAt: "2026-08-19T10:01:00.000Z",
      })
      const targetFirstDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S1",
        namespace: "project-car",
        injectionId: "target-before-split",
        turn: 1,
        focusedAt: "2026-08-19T10:02:00.000Z",
      })
      const targetFirst = targetFirstDelivery.items[0]!
      const firstProjectCopy = targetFirst.sourceRef.projectCopy
      writeFileSync(
        path.join(fixture.targetWorkspace, "MEMORY.md"),
        "# Memory\n\n- Car cancellation requires confirmation and a visible summary.\n",
      )
      const splitDelivery = await focusWorkspace({
        store,
        extractor: createStaticMemoryExtractor({
          callJson: async () => ({
            atoms: [
              { content: "Car cancellation requires confirmation." },
              { content: "Car cancellation requires a visible summary." },
            ],
          }),
          modelId: "test-split",
        }),
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S1",
        namespace: "project-car",
        injectionId: "target-after-split",
        turn: 2,
        focusedAt: "2026-08-19T10:03:00.000Z",
      })

      expect(splitDelivery.items).toHaveLength(2)
      for (const descendant of splitDelivery.items) {
        expect(descendant.identity).not.toEqual(targetFirst.identity)
        expect(descendant.sourceRef).toMatchObject({
          lineage: {
            relation: "split",
            ancestors: [targetFirst.identity],
          },
          projectCopy: firstProjectCopy,
        })
      }
    } finally {
      store.close()
    }
  })

  test("keeps transition, representation, file, and content hashes without inventing cloneOf for an unfocused source atom", async () => {
    const fixture = createFixture()
    const store = new StudyMemoryStore(":memory:")
    try {
      const sourcePayload = buildStudyStaticFocusPayload(readStudyStaticMemoryFiles(fixture.sourceWorkspace))
      const sourceExtraction = await fixture.extractor.extract(sourcePayload)
      store.resolveStaticAtoms({
        namespace: "project-apartment",
        snapshotHash: sourceExtraction.payloadHash,
        observedAt: "2026-08-19T10:00:00.000Z",
        atoms: sourceExtraction.atoms,
      })
      expect(store.listTaskDeliveries("038-S2")).toEqual([])
      const transition = await prepareCopy({
        fixture,
        store,
        snapshotId: "snapshot-unfocused-source",
        frozenAt: "2026-08-19T10:01:00.000Z",
      })

      const omittedInS1 = await focusWorkspace({
        store,
        extractor: createStaticMemoryExtractor({
          callJson: async () => ({ atoms: [] }),
          modelId: "test-omission",
        }),
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S1",
        namespace: "project-car",
        injectionId: "target-empty-s1",
        turn: 1,
        focusedAt: "2026-08-19T10:02:00.000Z",
      })
      expect(omittedInS1.items).toEqual([])

      const targetDelivery = await focusWorkspace({
        store,
        extractor: fixture.extractor,
        workspaceDir: fixture.targetWorkspace,
        taskId: "098-S2",
        namespace: "project-car",
        injectionId: "target-unfocused-source",
        turn: 1,
        focusedAt: "2026-08-19T10:03:00.000Z",
      })
      const projectCopy = targetDelivery.items[0]!.sourceRef.projectCopy as Record<string, unknown>
      expect(projectCopy).toMatchObject({
        transitionKey: "snapshot-unfocused-source:038-S2->098-S1",
        source: {
          snapshotId: "snapshot-unfocused-source",
          representationHash: transition!.sourceRepresentationHash,
        },
        target: { representationHash: transition!.targetRepresentationHash },
        files: [{
          relPath: "MEMORY.md",
          copiedFileHash: sha256(fixture.sourceText),
          focusedFileContentHashes: [sha256(fixture.sourceText)],
        }],
        targetContentHashesAtFirstFocus: [sourceExtraction.atoms[0]!.contentHash],
      })
      expect(projectCopy).not.toHaveProperty("cloneOf")
    } finally {
      store.close()
    }
  })
})
