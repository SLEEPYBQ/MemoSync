import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { snapshotStudyWorkspace } from "../study-workspace-snapshot"
import type { RegisteredStudyProject } from "../study-projects"
import { createStaticProjectCopyAdapter } from "./static-project-copy-adapter"

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "memosync-static-copy-adapter-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  async function makeWritable(target: string): Promise<void> {
    const info = await lstat(target)
    if (info.isSymbolicLink()) return
    if (!info.isDirectory()) {
      await chmod(target, 0o600)
      return
    }
    await chmod(target, 0o700)
    for (const entry of await readdir(target)) await makeWritable(path.join(target, entry))
  }

  await Promise.all(roots.splice(0).map(async (root) => {
    try {
      await makeWritable(root)
    } catch {
      // A rejected preparation can leave no snapshot tree to unlock.
    }
    await rm(root, { recursive: true, force: true })
  }))
})

describe("Static BaselineProjectCopyAdapter", () => {
  test("copies the verified frozen workspace representation into the trusted target project", async () => {
    const root = await tempRoot()
    const dataDir = path.join(root, "data")
    const sourceWorkspace = path.join(root, "apartment")
    const targetWorkspace = path.join(root, "car")
    await mkdir(path.join(sourceWorkspace, "memory"), { recursive: true })
    await mkdir(targetWorkspace, { recursive: true })
    await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Frozen apartment rule.\n")
    await writeFile(path.join(sourceWorkspace, "memory", "booking.md"), "# Booking\n- Confirm cancellation.\n")
    const snapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: sourceWorkspace,
      taskId: "038-S2",
      snapshotId: "snapshot-static-038",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Live workspace changed after freeze.\n")

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
    const adapter = createStaticProjectCopyAdapter({ dataDir, assignedProjects })

    const result = await adapter.prepare({
      transitionKey: "snapshot-static-038:038-S2->098-S1",
      fromTaskId: "038-S2",
      fromProjectSlug: "apartment",
      toTaskId: "098-S1",
      toProjectSlug: "car",
      sourceFreezeRef: {
        taskId: "038-S2",
        snapshotId: snapshot.snapshotId,
        frozenAt: snapshot.frozenAt,
        workspaceSnapshot: snapshot,
      },
    })

    expect(adapter.condition).toBe("static")
    expect(await readFile(path.join(targetWorkspace, "MEMORY.md"), "utf8"))
      .toBe("# Memory\n- Frozen apartment rule.\n")
    expect(await readFile(path.join(targetWorkspace, "memory", "booking.md"), "utf8"))
      .toBe("# Booking\n- Confirm cancellation.\n")
    expect(result.sourceRepresentationHash).toBe(result.targetRepresentationHash)
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      kind: "static_markdown_files",
      transitionKey: "snapshot-static-038:038-S2->098-S1",
      outcome: "copied",
      source: {
        taskId: "038-S2",
        snapshotId: "snapshot-static-038",
        projectId: "project-apartment",
        projectSlug: "apartment",
        workspaceTreeHash: snapshot.treeHash,
        representationHash: result.sourceRepresentationHash,
      },
      target: {
        taskId: "098-S1",
        projectId: "project-car",
        projectSlug: "car",
        representationHash: result.targetRepresentationHash,
      },
      files: [
        { relPath: "MEMORY.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { relPath: "memory/booking.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
      totalBytes: 68,
    })
    expect(() => JSON.stringify(result.manifest)).not.toThrow()
  })

  test("rejects a workspace snapshot whose authoritative metadata does not match the source freeze", async () => {
    const root = await tempRoot()
    const dataDir = path.join(root, "data")
    const sourceWorkspace = path.join(root, "apartment")
    const targetWorkspace = path.join(root, "car")
    await mkdir(sourceWorkspace, { recursive: true })
    await mkdir(targetWorkspace, { recursive: true })
    await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Frozen rule.\n")
    const snapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: sourceWorkspace,
      taskId: "038-S2",
      snapshotId: "snapshot-static-mismatch",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
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

    await expect(createStaticProjectCopyAdapter({ dataDir, assignedProjects }).prepare({
      transitionKey: "snapshot-static-mismatch:038-S2->098-S1",
      fromTaskId: "038-S2",
      fromProjectSlug: "apartment",
      toTaskId: "098-S1",
      toProjectSlug: "car",
      sourceFreezeRef: {
        taskId: "098-S2",
        snapshotId: snapshot.snapshotId,
        frozenAt: snapshot.frozenAt,
        workspaceSnapshot: snapshot,
      },
    })).rejects.toThrow(/source freeze.*task/i)
    await expect(readFile(path.join(targetWorkspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("rejects task, snapshot, timestamp, or project-slug metadata mismatches before publication", async () => {
    const root = await tempRoot()
    const dataDir = path.join(root, "data")
    const sourceWorkspace = path.join(root, "apartment")
    await mkdir(sourceWorkspace, { recursive: true })
    await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Frozen rule.\n")
    const snapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: sourceWorkspace,
      taskId: "038-S2",
      snapshotId: "snapshot-static-authority",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    const cases = [
      {
        label: "task",
        fromTaskId: "098-S2",
        fromProjectSlug: "apartment",
        freeze: { taskId: "098-S2", snapshotId: snapshot.snapshotId, frozenAt: snapshot.frozenAt },
      },
      {
        label: "snapshot",
        fromTaskId: "038-S2",
        fromProjectSlug: "apartment",
        freeze: { taskId: "038-S2", snapshotId: "another-snapshot", frozenAt: snapshot.frozenAt },
      },
      {
        label: "timestamp",
        fromTaskId: "038-S2",
        fromProjectSlug: "apartment",
        freeze: { taskId: "038-S2", snapshotId: snapshot.snapshotId, frozenAt: "2026-08-19T10:00:00.000Z" },
      },
      {
        label: "project slug",
        fromTaskId: "038-S2",
        fromProjectSlug: "car",
        freeze: { taskId: "038-S2", snapshotId: snapshot.snapshotId, frozenAt: snapshot.frozenAt },
      },
    ] as const

    for (const mismatch of cases) {
      const targetWorkspace = path.join(root, `car-${mismatch.label.replace(" ", "-")}`)
      await mkdir(targetWorkspace, { recursive: true })
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

      await expect(createStaticProjectCopyAdapter({ dataDir, assignedProjects }).prepare({
        transitionKey: `snapshot-static-authority:${mismatch.label}`,
        fromTaskId: mismatch.fromTaskId,
        fromProjectSlug: mismatch.fromProjectSlug,
        toTaskId: "098-S1",
        toProjectSlug: "car",
        sourceFreezeRef: { ...mismatch.freeze, workspaceSnapshot: snapshot },
      })).rejects.toThrow(/workspace snapshot metadata.*does not match/i)
      await expect(readFile(path.join(targetWorkspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  test("fails closed when source snapshot evidence or a ready registered target is unavailable", async () => {
    const root = await tempRoot()
    const dataDir = path.join(root, "data")
    const sourceWorkspace = path.join(root, "apartment")
    const targetWorkspace = path.join(root, "car")
    await mkdir(sourceWorkspace, { recursive: true })
    await mkdir(targetWorkspace, { recursive: true })
    await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Frozen rule.\n")
    const snapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: sourceWorkspace,
      taskId: "038-S2",
      snapshotId: "snapshot-static-prerequisites",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    const sourceProject: RegisteredStudyProject = {
      projectId: "project-apartment",
      localPath: sourceWorkspace,
      title: "Apartment rentals",
      starterReady: true,
    }
    const targetProject: RegisteredStudyProject = {
      projectId: "project-car",
      localPath: targetWorkspace,
      title: "Car rentals",
      starterReady: true,
    }
    const input = {
      transitionKey: "snapshot-static-prerequisites:038-S2->098-S1",
      fromTaskId: "038-S2",
      fromProjectSlug: "apartment",
      toTaskId: "098-S1",
      toProjectSlug: "car",
      sourceFreezeRef: {
        taskId: "038-S2",
        snapshotId: snapshot.snapshotId,
        frozenAt: snapshot.frozenAt,
        workspaceSnapshot: snapshot,
      },
    }

    await expect(createStaticProjectCopyAdapter({
      dataDir,
      assignedProjects: new Map([
        ["apartment", sourceProject],
        ["car", targetProject],
      ]),
    }).prepare({
      ...input,
      sourceFreezeRef: {
        taskId: input.sourceFreezeRef.taskId,
        snapshotId: input.sourceFreezeRef.snapshotId,
        frozenAt: input.sourceFreezeRef.frozenAt,
      },
    })).rejects.toThrow(/requires a frozen workspace snapshot/i)

    await expect(createStaticProjectCopyAdapter({
      dataDir,
      assignedProjects: new Map([["apartment", sourceProject]]),
    }).prepare(input)).rejects.toThrow(/registered study project.*car/i)

    await expect(createStaticProjectCopyAdapter({
      dataDir,
      assignedProjects: new Map([
        ["apartment", sourceProject],
        ["car", { ...targetProject, starterReady: false }],
      ]),
    }).prepare(input)).rejects.toThrow(/target project is not ready.*car/i)

    await expect(readFile(path.join(targetWorkspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("verifies authoritative snapshot bytes before touching the target project", async () => {
    const root = await tempRoot()
    const dataDir = path.join(root, "data")
    const sourceWorkspace = path.join(root, "apartment")
    const targetWorkspace = path.join(root, "car")
    await mkdir(sourceWorkspace, { recursive: true })
    await mkdir(targetWorkspace, { recursive: true })
    await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "# Memory\n- Frozen rule.\n")
    const snapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: sourceWorkspace,
      taskId: "038-S2",
      snapshotId: "snapshot-static-tampered",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    const frozenWorkspace = path.resolve(dataDir, ...snapshot.exportedPath.split("/"))
    await chmod(frozenWorkspace, 0o700)
    await chmod(path.join(frozenWorkspace, "MEMORY.md"), 0o600)
    await writeFile(path.join(frozenWorkspace, "MEMORY.md"), "# Memory\n- Tampered after freeze.\n")
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

    await expect(createStaticProjectCopyAdapter({ dataDir, assignedProjects }).prepare({
      transitionKey: "snapshot-static-tampered:038-S2->098-S1",
      fromTaskId: "038-S2",
      fromProjectSlug: "apartment",
      toTaskId: "098-S1",
      toProjectSlug: "car",
      sourceFreezeRef: {
        taskId: "038-S2",
        snapshotId: snapshot.snapshotId,
        frozenAt: snapshot.frozenAt,
        workspaceSnapshot: snapshot,
      },
    })).rejects.toThrow(/snapshot verification failed/i)
    await expect(readFile(path.join(targetWorkspace, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
