import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { getStudyTask } from "../shared/studyTasks"
import type { RegisteredStudyProject } from "./study-projects"

export const STUDY_WORKSPACE_SNAPSHOT_EXCLUSIONS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.turbo/cache/**",
  "**/.memosync/**",
  "**/.kanna/**",
] as const

export const STUDY_WORKSPACE_SNAPSHOT_LIMITS = {
  maxFiles: 2_000,
  maxEntries: 10_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 64,
} as const

export interface StudyWorkspaceSnapshotMetadata {
  schemaVersion: 1
  taskId: string
  snapshotId: string
  project: {
    slug: "apartment" | "car"
    title: string
  }
  frozenAt: string
  /** POSIX path relative to the participant data root, suitable for export. */
  exportedPath: string
  treeHash: string
  fileCount: number
  totalBytes: number
  exclusions: string[]
}

export interface SnapshotStudyWorkspaceInput {
  dataDir: string
  sourceDir: string
  taskId: string
  snapshotId: string
  project: StudyWorkspaceSnapshotMetadata["project"]
  frozenAt: string
  /** Diagnostic hook used by concurrency tests and optional runtime telemetry. */
  onAttemptCopied?: (attempt: number) => void | Promise<void>
  maxAttempts?: number
}

export function resolveStudyWorkspaceProject(
  taskId: string,
  projects: ReadonlyMap<"apartment" | "car", RegisteredStudyProject>,
): Pick<SnapshotStudyWorkspaceInput, "sourceDir" | "project"> {
  const task = getStudyTask(taskId)
  if (!task) throw new Error(`Unknown study task: ${taskId}`)
  const assigned = projects.get(task.projectSlug)
  if (!assigned) throw new Error(`The assigned ${task.projectTitle} workspace (${task.projectSlug}) is unavailable for ${taskId}`)
  if (!assigned.starterReady) throw new Error(`The assigned ${task.projectTitle} workspace is not ready for ${taskId}`)
  return {
    sourceDir: assigned.localPath,
    project: { slug: task.projectSlug, title: task.projectTitle },
  }
}

type TreeEntry =
  | { type: "directory"; path: string }
  | { type: "file"; path: string; size: number; hash: string; executable: boolean }
  | { type: "symlink"; path: string; target: string }

export interface StudyWorkspaceTreeState {
  treeHash: string
  fileCount: number
  totalBytes: number
}

type TreeDescription = StudyWorkspaceTreeState

interface SnapshotResourceBudget {
  files: number
  entries: number
  totalBytes: number
}

function newResourceBudget(): SnapshotResourceBudget {
  return { files: 0, entries: 0, totalBytes: 0 }
}

function resourceLimitError(reason: string): Error {
  return new Error(
    `Study workspace snapshot ${reason}. Remove generated files or stop the running task, then retry End session.`,
  )
}

function accountEntry(budget: SnapshotResourceBudget, relativePath: string): void {
  budget.entries += 1
  if (budget.entries > STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxEntries) {
    throw resourceLimitError(
      `exceeds the ${STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxEntries.toLocaleString("en-US")}-entry limit at ${relativePath}`,
    )
  }
}

function accountFile(budget: SnapshotResourceBudget, relativePath: string, size: number): void {
  budget.files += 1
  budget.totalBytes += size
  if (size > STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxFileBytes) {
    throw resourceLimitError(
      `exceeds the ${STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxFileBytes / (1024 * 1024)} MB single-file limit at ${relativePath}`,
    )
  }
  if (budget.files > STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxFiles) {
    throw resourceLimitError(
      `exceeds the ${STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxFiles.toLocaleString("en-US")}-file limit at ${relativePath}`,
    )
  }
  if (budget.totalBytes > STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxTotalBytes) {
    throw resourceLimitError(
      `exceeds the ${STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxTotalBytes / (1024 * 1024)} MB total-byte limit at ${relativePath}`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isExistingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`)
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isExcluded(parts: string[]): boolean {
  if (parts.some((part) => ["node_modules", ".git", ".next", "dist", "coverage", ".memosync", ".kanna"].includes(part))) {
    return true
  }
  return parts.some((part, index) => part === ".turbo" && parts[index + 1] === "cache")
}

function assertSafeSymlink(sourceRoot: string, linkPath: string, target: string, relativePath: string): void {
  if (path.isAbsolute(target)) {
    throw new Error(`Absolute symlink is not allowed in a study project: ${relativePath}`)
  }
  const resolvedRoot = path.resolve(sourceRoot)
  const resolvedTarget = path.resolve(path.dirname(linkPath), target)
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget)
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new Error(`Symlink points outside the study project: ${relativePath}`)
  }
}

async function copyWorkspace(
  sourceDir: string,
  destinationDir: string,
  parts: string[] = [],
  sourceRoot: string = sourceDir,
  budget: SnapshotResourceBudget = newResourceBudget(),
): Promise<void> {
  if (parts.length > STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxDepth) {
    throw resourceLimitError(`exceeds the ${STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxDepth}-level directory-depth limit`)
  }
  await mkdir(destinationDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  entries.sort((left, right) => compareText(left.name, right.name))
  for (const entry of entries) {
    const childParts = [...parts, entry.name]
    if (isExcluded(childParts)) continue
    const relativePath = childParts.join("/")
    accountEntry(budget, relativePath)
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)
    if (entry.isDirectory()) {
      await copyWorkspace(sourcePath, destinationPath, childParts, sourceRoot, budget)
      continue
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(sourcePath)
      assertSafeSymlink(sourceRoot, sourcePath, target, relativePath)
      await symlink(target, destinationPath)
      continue
    }
    if (!entry.isFile()) throw new Error(`Unsupported workspace entry: ${relativePath}`)
    const stat = await lstat(sourcePath)
    accountFile(budget, relativePath, stat.size)
    await copyRegularFileBounded(sourcePath, destinationPath, stat.size, stat.mode)
    await chmod(destinationPath, stat.mode & 0o777)
  }
}

async function copyRegularFileBounded(
  sourcePath: string,
  destinationPath: string,
  expectedSize: number,
  mode: number,
): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let destination: Awaited<ReturnType<typeof open>> | null = null
  try {
    const sourceInfo = await source.stat()
    if (!sourceInfo.isFile() || sourceInfo.size !== expectedSize) {
      throw new Error("Study project changed while a file was being opened for snapshot")
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode & 0o777,
    )
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedSize)))
    let position = 0
    while (position < expectedSize) {
      const length = Math.min(buffer.byteLength, expectedSize - position)
      const { bytesRead } = await source.read(buffer, 0, length, position)
      if (bytesRead === 0) throw new Error("Study project changed while a file was being copied for snapshot")
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    if ((await source.stat()).size !== expectedSize) {
      throw new Error("Study project changed while a file was being copied for snapshot")
    }
  } finally {
    await destination?.close()
    await source.close()
  }
}

async function hashRegularFileBounded(absolutePath: string, expectedSize: number): Promise<string> {
  const file = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size !== expectedSize) {
      throw new Error("Study project changed while a file was being hashed for snapshot")
    }
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedSize)))
    let position = 0
    while (position < expectedSize) {
      const length = Math.min(buffer.byteLength, expectedSize - position)
      const { bytesRead } = await file.read(buffer, 0, length, position)
      if (bytesRead === 0) throw new Error("Study project changed while a file was being hashed for snapshot")
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if ((await file.stat()).size !== expectedSize) {
      throw new Error("Study project changed while a file was being hashed for snapshot")
    }
    return hash.digest("hex")
  } finally {
    await file.close()
  }
}

async function describeTree(
  root: string,
  options: { excludeArtifacts?: boolean } = {},
  parts: string[] = [],
): Promise<TreeDescription> {
  const entries: TreeEntry[] = []
  const pendingFiles: Array<{
    absolutePath: string
    entry: Extract<TreeEntry, { type: "file" }>
  }> = []
  const budget = newResourceBudget()

  async function visit(directory: string, relativeParts: string[]): Promise<void> {
    if (relativeParts.length > STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxDepth) {
      throw resourceLimitError(`exceeds the ${STUDY_WORKSPACE_SNAPSHOT_LIMITS.maxDepth}-level directory-depth limit`)
    }
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => compareText(left.name, right.name))
    for (const entry of children) {
      const childParts = [...relativeParts, entry.name]
      if (options.excludeArtifacts && isExcluded(childParts)) continue
      const relativePath = childParts.join("/")
      accountEntry(budget, relativePath)
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        entries.push({ type: "directory", path: relativePath })
        await visit(absolutePath, childParts)
        continue
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolutePath)
        assertSafeSymlink(root, absolutePath, target, relativePath)
        entries.push({ type: "symlink", path: relativePath, target })
        continue
      }
      if (!entry.isFile()) throw new Error(`Unsupported workspace entry: ${relativePath}`)
      const stat = await lstat(absolutePath)
      accountFile(budget, relativePath, stat.size)
      const fileEntry: Extract<TreeEntry, { type: "file" }> = {
        type: "file",
        path: relativePath,
        size: stat.size,
        hash: "",
        executable: (stat.mode & 0o111) !== 0,
      }
      entries.push(fileEntry)
      pendingFiles.push({ absolutePath, entry: fileEntry })
    }
  }

  await visit(root, parts)
  for (const pending of pendingFiles) {
    pending.entry.hash = await hashRegularFileBounded(pending.absolutePath, pending.entry.size)
  }
  entries.sort((left, right) => compareText(left.path, right.path))
  const files = entries.filter((entry): entry is Extract<TreeEntry, { type: "file" }> => entry.type === "file")
  return {
    treeHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  }
}

/** Read-only scoreable workspace state used by the server-owned Finish gate. */
export async function describeStudyWorkspace(sourceDir: string): Promise<StudyWorkspaceTreeState> {
  const sourceStat = await lstat(sourceDir)
  if (!sourceStat.isDirectory()) throw new Error(`Study project workspace is not a directory: ${sourceDir}`)
  return describeTree(sourceDir, { excludeArtifacts: true })
}

function sameMetadata(
  actual: StudyWorkspaceSnapshotMetadata,
  expected: StudyWorkspaceSnapshotMetadata,
): boolean {
  return actual.schemaVersion === expected.schemaVersion
    && actual.taskId === expected.taskId
    && actual.snapshotId === expected.snapshotId
    && actual.project.slug === expected.project.slug
    && actual.project.title === expected.project.title
    && actual.frozenAt === expected.frozenAt
    && actual.exportedPath === expected.exportedPath
    && actual.treeHash === expected.treeHash
    && actual.fileCount === expected.fileCount
    && actual.totalBytes === expected.totalBytes
    && actual.exclusions.length === expected.exclusions.length
    && actual.exclusions.every((entry, index) => entry === expected.exclusions[index])
}

/**
 * Verify a snapshot against metadata loaded from the authoritative study
 * database before copying it to an evaluator or grading it. The manifest
 * inside the snapshot is not trusted as the authority because a process with
 * filesystem write access could alter both the tree and that manifest.
 */
export async function verifyStudyWorkspaceSnapshot(
  dataDir: string,
  expected: StudyWorkspaceSnapshotMetadata,
): Promise<void> {
  assertSafeSegment(expected.taskId, "taskId")
  assertSafeSegment(expected.snapshotId, "snapshotId")
  const relativeSnapshotRoot = path.posix.join(
    "experiments",
    "workspace-snapshots",
    expected.taskId,
    expected.snapshotId,
  )
  const expectedExportedPath = path.posix.join(relativeSnapshotRoot, "workspace")
  const snapshotRoot = path.join(dataDir, relativeSnapshotRoot)

  try {
    if (expected.exportedPath !== expectedExportedPath) throw new Error("unexpected exportedPath")
    const persisted = JSON.parse(
      await readFile(path.join(snapshotRoot, "manifest.json"), "utf8"),
    ) as StudyWorkspaceSnapshotMetadata
    if (!sameMetadata(persisted, expected)) throw new Error("manifest differs from authoritative metadata")
    const actual = await describeTree(path.join(snapshotRoot, "workspace"))
    if (
      actual.treeHash !== expected.treeHash
      || actual.fileCount !== expected.fileCount
      || actual.totalBytes !== expected.totalBytes
    ) {
      throw new Error("workspace tree differs from authoritative metadata")
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Study workspace snapshot verification failed for ${expected.taskId}/${expected.snapshotId}: ${reason}. Do not export or grade this snapshot.`,
    )
  }
}

function sameTree(left: TreeDescription, right: TreeDescription): boolean {
  return left.treeHash === right.treeHash
    && left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
}

async function lockSnapshotEvidence(snapshotRoot: string): Promise<void> {
  async function lockDirectory(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await lockDirectory(absolutePath)
        continue
      }
      if (entry.isSymbolicLink()) continue
      if (!entry.isFile()) throw new Error(`Unsupported snapshot evidence entry: ${absolutePath}`)
      const info = await lstat(absolutePath)
      await chmod(absolutePath, (info.mode & 0o111) === 0 ? 0o400 : 0o500)
    }
    await chmod(directory, 0o500)
  }

  await lockDirectory(path.join(snapshotRoot, "workspace"))
  await chmod(path.join(snapshotRoot, "manifest.json"), 0o400)
  await chmod(snapshotRoot, 0o500)
}

async function readExistingSnapshot(
  snapshotRoot: string,
  expected: SnapshotStudyWorkspaceInput,
  expectedExportedPath: string,
): Promise<StudyWorkspaceSnapshotMetadata | null> {
  let raw: string
  try {
    raw = await readFile(path.join(snapshotRoot, "manifest.json"), "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (
    !isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.taskId !== expected.taskId
    || parsed.snapshotId !== expected.snapshotId
    || parsed.frozenAt !== expected.frozenAt
    || parsed.exportedPath !== expectedExportedPath
    || !isRecord(parsed.project)
    || parsed.project.slug !== expected.project.slug
    || parsed.project.title !== expected.project.title
    || typeof parsed.treeHash !== "string"
    || typeof parsed.fileCount !== "number"
    || typeof parsed.totalBytes !== "number"
    || !Array.isArray(parsed.exclusions)
    || parsed.exclusions.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Existing study workspace snapshot does not match ${expected.taskId}/${expected.snapshotId}`)
  }
  const metadata = parsed as unknown as StudyWorkspaceSnapshotMetadata
  const actual = await describeTree(path.join(snapshotRoot, "workspace"))
  if (
    actual.treeHash !== metadata.treeHash
    || actual.fileCount !== metadata.fileCount
    || actual.totalBytes !== metadata.totalBytes
  ) {
    throw new Error(`Existing study workspace snapshot is corrupt: ${expected.taskId}/${expected.snapshotId}`)
  }
  await lockSnapshotEvidence(snapshotRoot)
  await verifyStudyWorkspaceSnapshot(expected.dataDir, metadata)
  return metadata
}

export async function snapshotStudyWorkspace(
  input: SnapshotStudyWorkspaceInput,
): Promise<StudyWorkspaceSnapshotMetadata> {
  assertSafeSegment(input.taskId, "taskId")
  assertSafeSegment(input.snapshotId, "snapshotId")
  const relativeSnapshotRoot = path.posix.join(
    "experiments",
    "workspace-snapshots",
    input.taskId,
    input.snapshotId,
  )
  const taskRoot = path.join(input.dataDir, "experiments", "workspace-snapshots", input.taskId)
  const snapshotRoot = path.join(taskRoot, input.snapshotId)
  const exportedPath = path.posix.join(relativeSnapshotRoot, "workspace")
  const existing = await readExistingSnapshot(snapshotRoot, input, exportedPath)
  if (existing) return existing

  const sourceStat = await lstat(input.sourceDir)
  if (!sourceStat.isDirectory()) throw new Error(`Study project workspace is not a directory: ${input.sourceDir}`)
  const maxAttempts = input.maxAttempts ?? 3
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error(`Invalid workspace snapshot maxAttempts: ${maxAttempts}`)
  }
  const tempRoot = path.join(taskRoot, `.${input.snapshotId}.tmp-${randomUUID()}`)
  const tempWorkspace = path.join(tempRoot, "workspace")
  await mkdir(taskRoot, { recursive: true })

  try {
    let tree: TreeDescription | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await rm(tempRoot, { recursive: true, force: true })
      const before = await describeTree(input.sourceDir, { excludeArtifacts: true })
      await copyWorkspace(input.sourceDir, tempWorkspace)
      const copied = await describeTree(tempWorkspace)
      await input.onAttemptCopied?.(attempt)
      const after = await describeTree(input.sourceDir, { excludeArtifacts: true })
      if (sameTree(before, copied) && sameTree(before, after)) {
        tree = copied
        break
      }
    }
    if (!tree) {
      throw new Error(
        `Study project changed while it was being snapshotted after ${maxAttempts} attempt(s). Stop the running task, then retry End session.`,
      )
    }
    const metadata: StudyWorkspaceSnapshotMetadata = {
      schemaVersion: 1,
      taskId: input.taskId,
      snapshotId: input.snapshotId,
      project: { ...input.project },
      frozenAt: input.frozenAt,
      exportedPath,
      ...tree,
      exclusions: [...STUDY_WORKSPACE_SNAPSHOT_EXCLUSIONS],
    }
    await writeFile(path.join(tempRoot, "manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" })
    try {
      await rename(tempRoot, snapshotRoot)
    } catch (error) {
      if (!isExistingPathError(error)) throw error
      await rm(tempRoot, { recursive: true, force: true })
      const raced = await readExistingSnapshot(snapshotRoot, input, exportedPath)
      if (!raced) throw error
      return raced
    }
    await lockSnapshotEvidence(snapshotRoot)
    await verifyStudyWorkspaceSnapshot(input.dataDir, metadata)
    return metadata
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true })
    throw error
  }
}
