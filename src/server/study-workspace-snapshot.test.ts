import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  resolveStudyWorkspaceProject,
  snapshotStudyWorkspace,
  verifyStudyWorkspaceSnapshot,
} from "./study-workspace-snapshot"

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memosync-study-workspace-snapshot-"))
}

async function removeTempRoot(root: string): Promise<void> {
  async function makeWritable(target: string): Promise<void> {
    const info = await lstat(target)
    if (info.isSymbolicLink()) return
    if (!info.isDirectory()) {
      await chmod(target, 0o600)
      return
    }
    await chmod(target, 0o700)
    for (const entry of await readdir(target)) await makeWritable(join(target, entry))
  }

  try {
    await makeWritable(root)
  } catch {
    // A failed snapshot can remove its temporary tree before cleanup runs.
  }
  await rm(root, { recursive: true, force: true })
}

describe("snapshotStudyWorkspace", () => {
  test("resolves each session to its assigned apartment or car project", () => {
    const projects = new Map([
      ["car", { projectId: "project-car", localPath: "/workspace/car", title: "Car rentals", starterReady: true }],
      ["apartment", { projectId: "project-apartment", localPath: "/workspace/apartment", title: "Apartment rentals", starterReady: true }],
    ] as const)

    expect(resolveStudyWorkspaceProject("038-S2", projects)).toEqual({
      sourceDir: "/workspace/apartment",
      project: { slug: "apartment", title: "Apartment rentals" },
    })
    expect(resolveStudyWorkspaceProject("098-S1", projects)).toEqual({
      sourceDir: "/workspace/car",
      project: { slug: "car", title: "Car rentals" },
    })
    expect(() => resolveStudyWorkspaceProject("038-S1", new Map([
      ["car", projects.get("car")!],
    ]))).toThrow(/apartment/i)
    expect(() => resolveStudyWorkspaceProject("038-S1", new Map([
      ["apartment", {
        projectId: "spoof",
        localPath: "/tmp/unregistered/apartment",
        title: "Apartment rentals",
        starterReady: false,
      }],
    ]))).toThrow(/not ready/i)
  })

  test("keeps the S1 source immutable while S2 captures the continued project", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(join(sourceDir, "src"), { recursive: true })
      await writeFile(join(sourceDir, "src", "app.ts"), "export const session = 'S1'\n")

      const s1 = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-s1",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T09:00:00.000Z",
      })

      await writeFile(join(sourceDir, "src", "app.ts"), "export const session = 'S2'\n")

      const s2 = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S2",
        snapshotId: "snapshot-s2",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T10:00:00.000Z",
      })

      expect(await readFile(join(dataDir, s1.exportedPath, "src", "app.ts"), "utf8"))
        .toBe("export const session = 'S1'\n")
      expect(await readFile(join(dataDir, s2.exportedPath, "src", "app.ts"), "utf8"))
        .toBe("export const session = 'S2'\n")
      expect(s1.treeHash).not.toBe(s2.treeHash)
      expect(s1).toMatchObject({
        taskId: "038-S1",
        snapshotId: "snapshot-s1",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T09:00:00.000Z",
        exportedPath: "experiments/workspace-snapshots/038-S1/snapshot-s1/workspace",
        fileCount: 1,
      })
      expect(JSON.parse(await readFile(
        join(dataDir, "experiments", "workspace-snapshots", "038-S1", "snapshot-s1", "manifest.json"),
        "utf8",
      ))).toEqual(s1)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("omits dependency, VCS, coverage, and build artifacts", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "car")
      const dataDir = join(root, "data")
      const omitted = [
        "node_modules/pkg/index.js",
        ".git/config",
        ".next/server/page.js",
        "frontend/dist/bundle.js",
        "backend/coverage/lcov.info",
        ".turbo/cache/build.bin",
        ".memosync/uploads/task-instruction.png",
        ".memosync/exports/chat/transcript.json",
        ".kanna/uploads/legacy.pdf",
        ".kanna/exports/legacy/index.html",
      ]
      await mkdir(join(sourceDir, "src"), { recursive: true })
      await writeFile(join(sourceDir, "src", "app.ts"), "export const app = true\n")
      for (const relPath of omitted) {
        await mkdir(join(sourceDir, relPath, ".."), { recursive: true })
        await writeFile(join(sourceDir, relPath), "generated\n")
      }

      const snapshot = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "098-S1",
        snapshotId: "snapshot-exclusions",
        project: { slug: "car", title: "Car rentals" },
        frozenAt: "2026-08-18T11:00:00.000Z",
      })

      expect(snapshot.fileCount).toBe(1)
      expect(snapshot.totalBytes).toBe(Buffer.byteLength("export const app = true\n"))
      expect(snapshot.exclusions).toEqual([
        "**/node_modules/**",
        "**/.git/**",
        "**/.next/**",
        "**/dist/**",
        "**/coverage/**",
        "**/.turbo/cache/**",
        "**/.memosync/**",
        "**/.kanna/**",
      ])
      for (const relPath of omitted) {
        expect(existsSync(join(dataDir, snapshot.exportedPath, relPath))).toBe(false)
      }
    } finally {
      await removeTempRoot(root)
    }
  })

  test("excludes an image-seed node_modules link before external-symlink validation", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const seedDir = join(root, "image", "node_modules")
      const dataDir = join(root, "data")
      await mkdir(join(sourceDir, "src"), { recursive: true })
      await mkdir(seedDir, { recursive: true })
      await writeFile(join(sourceDir, "src", "app.ts"), "export const app = true\n")
      await writeFile(join(seedDir, "large-runtime-package.js"), "runtime only\n")
      await symlink(seedDir, join(sourceDir, "node_modules"), "dir")

      const snapshot = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-image-seed",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T11:30:00.000Z",
      })

      expect(snapshot.fileCount).toBe(1)
      expect(existsSync(join(dataDir, snapshot.exportedPath, "node_modules"))).toBe(false)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("returns an existing snapshot idempotently without overwriting its source", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(sourceDir, { recursive: true })
      await writeFile(join(sourceDir, "answer.ts"), "first\n")
      const input = {
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-retry",
        project: { slug: "apartment" as const, title: "Apartment rentals" },
        frozenAt: "2026-08-18T12:00:00.000Z",
      }

      const first = await snapshotStudyWorkspace(input)
      await writeFile(join(sourceDir, "answer.ts"), "changed after freeze\n")
      const retry = await snapshotStudyWorkspace(input)

      expect(retry).toEqual(first)
      expect(await readFile(join(dataDir, retry.exportedPath, "answer.ts"), "utf8")).toBe("first\n")
    } finally {
      await removeTempRoot(root)
    }
  })

  test("publishes restrictive evidence permissions without losing executable metadata", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(sourceDir, { recursive: true })
      await writeFile(join(sourceDir, "answer.ts"), "export const answer = true\n")
      await writeFile(join(sourceDir, "run.sh"), "#!/bin/sh\n")
      await chmod(join(sourceDir, "run.sh"), 0o755)

      const snapshot = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-permissions",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T12:30:00.000Z",
      })
      const snapshotRoot = join(dataDir, "experiments", "workspace-snapshots", "038-S1", "snapshot-permissions")
      const mode = async (target: string) => (await stat(target)).mode & 0o777

      expect(await mode(snapshotRoot)).toBe(0o500)
      expect(await mode(join(dataDir, snapshot.exportedPath))).toBe(0o500)
      expect(await mode(join(dataDir, snapshot.exportedPath, "answer.ts"))).toBe(0o400)
      expect(await mode(join(dataDir, snapshot.exportedPath, "run.sh"))).toBe(0o500)
      expect(await mode(join(snapshotRoot, "manifest.json"))).toBe(0o400)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("verifies authoritative frozen metadata before export or grading", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(sourceDir, { recursive: true })
      await writeFile(join(sourceDir, "answer.ts"), "export const answer = true\n")
      const snapshot = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-verify",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T12:31:00.000Z",
      })

      await expect(verifyStudyWorkspaceSnapshot(dataDir, snapshot)).resolves.toBeUndefined()

      const frozenFile = join(dataDir, snapshot.exportedPath, "answer.ts")
      await chmod(frozenFile, 0o600)
      await writeFile(frozenFile, "tampered after freeze\n")
      await expect(verifyStudyWorkspaceSnapshot(dataDir, snapshot))
        .rejects.toThrow(/verification failed.*do not export or grade/i)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("rejects absolute symlinks and relative symlinks that escape the project", async () => {
    const root = await tempRoot()
    try {
      const dataDir = join(root, "data")
      const sourceDir = join(root, "workspace", "car")
      await mkdir(sourceDir, { recursive: true })
      const outside = join(root, "private.txt")
      await writeFile(outside, "must not be exported\n")

      await symlink("../../private.txt", join(sourceDir, "relative-escape"))
      await expect(snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "098-S1",
        snapshotId: "snapshot-relative-link",
        project: { slug: "car", title: "Car rentals" },
        frozenAt: "2026-08-18T13:00:00.000Z",
      })).rejects.toThrow(/outside the study project/i)

      await rm(join(sourceDir, "relative-escape"))
      await symlink(outside, join(sourceDir, "absolute-escape"))
      await expect(snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "098-S1",
        snapshotId: "snapshot-absolute-link",
        project: { slug: "car", title: "Car rentals" },
        frozenAt: "2026-08-18T13:01:00.000Z",
      })).rejects.toThrow(/absolute symlink/i)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("preserves and hashes a relative symlink whose target stays inside the project", async () => {
    const root = await tempRoot()
    try {
      const dataDir = join(root, "data")
      const sourceDir = join(root, "workspace", "car")
      await mkdir(join(sourceDir, "src"), { recursive: true })
      await writeFile(join(sourceDir, "src", "app.ts"), "inside\n")
      await symlink("src/app.ts", join(sourceDir, "app-link.ts"))

      const snapshot = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "098-S1",
        snapshotId: "snapshot-internal-link",
        project: { slug: "car", title: "Car rentals" },
        frozenAt: "2026-08-18T13:02:00.000Z",
      })

      expect(await readlink(join(dataDir, snapshot.exportedPath, "app-link.ts"))).toBe("src/app.ts")
      expect(snapshot.fileCount).toBe(1)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("retries when the source changes during copy and only publishes a stable tree", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(sourceDir, { recursive: true })
      await writeFile(join(sourceDir, "state.txt"), "before\n")
      const attempts: number[] = []

      const snapshot = await snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-mutation",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T14:00:00.000Z",
        onAttemptCopied: async (attempt) => {
          attempts.push(attempt)
          if (attempt === 1) await writeFile(join(sourceDir, "state.txt"), "after\n")
        },
      })

      expect(attempts).toEqual([1, 2])
      expect(await readFile(join(dataDir, snapshot.exportedPath, "state.txt"), "utf8")).toBe("after\n")
    } finally {
      await removeTempRoot(root)
    }
  })

  test("bounds repeated source mutation and never publishes an unstable destination", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(sourceDir, { recursive: true })
      await writeFile(join(sourceDir, "state.txt"), "initial\n")
      const attempts: number[] = []

      await expect(snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-never-stable",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T14:01:00.000Z",
        maxAttempts: 2,
        onAttemptCopied: async (attempt) => {
          attempts.push(attempt)
          await writeFile(join(sourceDir, "state.txt"), `mutation-${attempt}\n`)
        },
      })).rejects.toThrow(/changed.*2 attempt.*stop the running task.*retry End session/i)

      expect(attempts).toEqual([1, 2])
      const taskRoot = join(dataDir, "experiments", "workspace-snapshots", "038-S1")
      expect(existsSync(join(taskRoot, "snapshot-never-stable"))).toBe(false)
      expect((await readdir(taskRoot)).filter((name) => name.includes("snapshot-never-stable"))).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  test("rejects an oversized source file before copying it into snapshot storage", async () => {
    const root = await tempRoot()
    try {
      const sourceDir = join(root, "workspace", "apartment")
      const dataDir = join(root, "data")
      await mkdir(sourceDir, { recursive: true })
      const oversized = join(sourceDir, "accidental-dump.bin")
      await writeFile(oversized, "")
      await truncate(oversized, 64 * 1024 * 1024 + 1)

      await expect(snapshotStudyWorkspace({
        dataDir,
        sourceDir,
        taskId: "038-S1",
        snapshotId: "snapshot-oversized-file",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T14:01:30.000Z",
      })).rejects.toThrow(/single-file limit.*remove generated files.*retry End session/i)

      expect(existsSync(join(
        dataDir,
        "experiments",
        "workspace-snapshots",
        "038-S1",
        "snapshot-oversized-file",
      ))).toBe(false)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("bounds source file count and aggregate bytes before hashing or copying", async () => {
    const root = await tempRoot()
    try {
      const dataDir = join(root, "data")
      const tooManyDir = join(root, "workspace", "too-many")
      await mkdir(tooManyDir, { recursive: true })
      for (let start = 0; start <= 2_000; start += 100) {
        await Promise.all(Array.from(
          { length: Math.min(100, 2_001 - start) },
          (_, offset) => writeFile(join(tooManyDir, `file-${start + offset}.txt`), ""),
        ))
      }

      await expect(snapshotStudyWorkspace({
        dataDir,
        sourceDir: tooManyDir,
        taskId: "038-S1",
        snapshotId: "snapshot-too-many-files",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T14:01:31.000Z",
      })).rejects.toThrow(/2,000-file limit.*retry End session/i)

      const tooLargeDir = join(root, "workspace", "too-large")
      await mkdir(tooLargeDir, { recursive: true })
      for (let index = 0; index < 9; index += 1) {
        const file = join(tooLargeDir, `chunk-${index}.bin`)
        await writeFile(file, "")
        await truncate(file, 60 * 1024 * 1024)
      }
      await expect(snapshotStudyWorkspace({
        dataDir,
        sourceDir: tooLargeDir,
        taskId: "038-S2",
        snapshotId: "snapshot-too-many-bytes",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T14:01:32.000Z",
      })).rejects.toThrow(/512 MB total-byte limit.*retry End session/i)
    } finally {
      await removeTempRoot(root)
    }
  })

  test("computes the same tree hash regardless of creation order and timestamps", async () => {
    const root = await tempRoot()
    try {
      const dataDir = join(root, "data")
      const firstSource = join(root, "first")
      const secondSource = join(root, "second")
      await mkdir(join(firstSource, "src", "empty"), { recursive: true })
      await writeFile(join(firstSource, "src", "b.ts"), "b\n")
      await writeFile(join(firstSource, "src", "a.ts"), "a\n")
      await mkdir(join(secondSource, "src", "empty"), { recursive: true })
      await writeFile(join(secondSource, "src", "a.ts"), "a\n")
      await writeFile(join(secondSource, "src", "b.ts"), "b\n")
      await chmod(join(firstSource, "src", "a.ts"), 0o755)
      await chmod(join(secondSource, "src", "a.ts"), 0o755)

      const first = await snapshotStudyWorkspace({
        dataDir,
        sourceDir: firstSource,
        taskId: "038-S1",
        snapshotId: "snapshot-deterministic-a",
        project: { slug: "apartment", title: "Apartment rentals" },
        frozenAt: "2026-08-18T14:02:00.000Z",
      })
      const second = await snapshotStudyWorkspace({
        dataDir,
        sourceDir: secondSource,
        taskId: "098-S1",
        snapshotId: "snapshot-deterministic-b",
        project: { slug: "car", title: "Car rentals" },
        frozenAt: "2026-08-18T14:03:00.000Z",
      })

      expect(first.treeHash).toBe(second.treeHash)
      expect(first.fileCount).toBe(second.fileCount)
      expect(first.totalBytes).toBe(second.totalBytes)
    } finally {
      await removeTempRoot(root)
    }
  })
})
