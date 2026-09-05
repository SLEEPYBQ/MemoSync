import { createHash, randomUUID } from "node:crypto"
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import {
  STATIC_MEMORY_DIR,
  STATIC_MEMORY_FILENAME,
  STATIC_MEMORY_SCAFFOLD_MARKER,
} from "../memory/static-files"

export interface StaticProjectRepresentationFile {
  relPath: string
  byteLength: number
  sha256: string
}

export interface StaticProjectRepresentationManifest {
  schemaVersion: 1
  kind: "static_markdown_files"
  files: StaticProjectRepresentationFile[]
  totalBytes: number
  representationHash: string
}

export interface StaticProjectCopyResult {
  outcome: "copied" | "already_present"
  source: StaticProjectRepresentationManifest
  target: StaticProjectRepresentationManifest
}

export const STATIC_PROJECT_COPY_PREPARING_MARKER = ".memosync-static-project-copy-preparing.json"
const STATIC_PROJECT_COPY_STAGING_PREFIX = ".memosync-static-project-copy-stage-"

interface StaticProjectCopyPreparingJournal {
  schemaVersion: 1
  kind: "static_project_copy_preparing"
  representation: StaticProjectRepresentationManifest
  stagingDirectory: string
}

export interface StaticProjectCopyProgress {
  relPath: string
  publishedCount: number
  totalFiles: number
}

interface LoadedStaticFile extends StaticProjectRepresentationFile {
  bytes: Buffer
}

interface LoadedStaticRepresentation {
  files: LoadedStaticFile[]
  manifest: StaticProjectRepresentationManifest
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
}

function isExisting(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST"
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function sameManifest(
  left: StaticProjectRepresentationManifest,
  right: StaticProjectRepresentationManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function loadRegularFile(root: string, relPath: string): Promise<LoadedStaticFile> {
  const absolutePath = path.join(root, ...relPath.split("/"))
  const info = await lstat(absolutePath)
  if (!info.isFile()) {
    throw new Error(`Static project representation entry is not a regular file: ${relPath}`)
  }
  const bytes = await readFile(absolutePath)
  return {
    relPath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    bytes,
  }
}

function toManifest(files: readonly LoadedStaticFile[]): StaticProjectRepresentationManifest {
  const publicFiles = files.map(({ relPath, byteLength, sha256: fileHash }) => ({
    relPath,
    byteLength,
    sha256: fileHash,
  }))
  const totalBytes = publicFiles.reduce((total, file) => total + file.byteLength, 0)
  const payload = {
    schemaVersion: 1 as const,
    kind: "static_markdown_files" as const,
    files: publicFiles,
    totalBytes,
  }
  return {
    ...payload,
    representationHash: sha256(JSON.stringify(payload)),
  }
}

async function loadStaticRepresentation(root: string): Promise<LoadedStaticRepresentation> {
  const files: LoadedStaticFile[] = []
  try {
    files.push(await loadRegularFile(root, STATIC_MEMORY_FILENAME))
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const memoryDir = path.join(root, STATIC_MEMORY_DIR)
  try {
    const directoryInfo = await lstat(memoryDir)
    if (!directoryInfo.isDirectory()) {
      throw new Error(`Static project ${STATIC_MEMORY_DIR} path must be a regular directory`)
    }
    const entries = await readdir(memoryDir, { withFileTypes: true })
    const markdownNames = entries
      .filter((entry) => entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort(compareUtf8)
    for (const name of markdownNames) {
      files.push(await loadRegularFile(root, `${STATIC_MEMORY_DIR}/${name}`))
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  return { files, manifest: toManifest(files) }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function regularFileExists(absolutePath: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(absolutePath)
    if (!info.isFile()) throw new Error(`Static project ${label} must be a regular file`)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function publishFileExclusively(source: string, destination: string): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (error) {
    if (isExisting(error)) return false
    throw error
  }
}

async function ensureScaffoldMarker(
  stagingRoot: string,
  destinationRoot: string,
  representationHash: string,
): Promise<boolean> {
  const stagedMarker = path.join(stagingRoot, STATIC_MEMORY_SCAFFOLD_MARKER)
  await writeFile(
    stagedMarker,
    `static baseline project copy\nrepresentation-sha256 ${representationHash}\n`,
  )
  return publishFileExclusively(
    stagedMarker,
    path.join(destinationRoot, STATIC_MEMORY_SCAFFOLD_MARKER),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parsePreparingJournal(
  raw: string,
  expected: StaticProjectRepresentationManifest,
): StaticProjectCopyPreparingJournal {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("Static project destination has a corrupt preparing journal")
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "static_project_copy_preparing"
    || !isRecord(value.representation)
    || typeof value.stagingDirectory !== "string"
    || !value.stagingDirectory.startsWith(STATIC_PROJECT_COPY_STAGING_PREFIX)
    || value.stagingDirectory.includes("/")
    || value.stagingDirectory.includes("\\")
  ) {
    throw new Error("Static project destination has an invalid preparing journal")
  }
  const representation = value.representation as unknown as StaticProjectRepresentationManifest
  if (!sameManifest(representation, expected)) {
    throw new Error("Static project destination is preparing a different representation")
  }
  return {
    schemaVersion: 1,
    kind: "static_project_copy_preparing",
    representation,
    stagingDirectory: value.stagingDirectory,
  }
}

async function readPreparingJournal(
  destinationRoot: string,
  expected: StaticProjectRepresentationManifest,
): Promise<StaticProjectCopyPreparingJournal | null> {
  const journalPath = path.join(destinationRoot, STATIC_PROJECT_COPY_PREPARING_MARKER)
  if (!await regularFileExists(journalPath, "preparing journal")) return null
  try {
    return parsePreparingJournal(
      await readFile(journalPath, "utf8"),
      expected,
    )
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function beginPreparingJournal(
  destinationRoot: string,
  expected: StaticProjectRepresentationManifest,
): Promise<StaticProjectCopyPreparingJournal> {
  const existing = await readPreparingJournal(destinationRoot, expected)
  if (existing) return existing

  const journal: StaticProjectCopyPreparingJournal = {
    schemaVersion: 1,
    kind: "static_project_copy_preparing",
    representation: expected,
    stagingDirectory: `${STATIC_PROJECT_COPY_STAGING_PREFIX}${randomUUID()}`,
  }
  const temporary = path.join(destinationRoot, `${STATIC_PROJECT_COPY_PREPARING_MARKER}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" })
    if (!await publishFileExclusively(
      temporary,
      path.join(destinationRoot, STATIC_PROJECT_COPY_PREPARING_MARKER),
    )) {
      return (await readPreparingJournal(destinationRoot, expected))!
    }
    return journal
  } finally {
    await rm(temporary, { force: true })
  }
}

function assertRecoverablePartialTarget(
  target: LoadedStaticRepresentation,
  source: LoadedStaticRepresentation,
): void {
  const expected = new Map(source.files.map((file) => [file.relPath, file]))
  for (const actual of target.files) {
    const sourceFile = expected.get(actual.relPath)
    if (
      !sourceFile
      || sourceFile.byteLength !== actual.byteLength
      || sourceFile.sha256 !== actual.sha256
    ) {
      throw new Error(
        `Static project destination contains a different representation (${target.manifest.representationHash})`,
      )
    }
  }
}

async function removePreparingState(
  destinationRoot: string,
  journal: StaticProjectCopyPreparingJournal,
): Promise<void> {
  await rm(path.join(destinationRoot, journal.stagingDirectory), { recursive: true, force: true })
  await rm(path.join(destinationRoot, STATIC_PROJECT_COPY_PREPARING_MARKER), { force: true })
}

/**
 * Materialize one independently mutable Static baseline representation from
 * an immutable study workspace snapshot. Only root MEMORY.md and direct
 * memory/*.md files are representation data. Bytes are never decoded,
 * truncated, atomized, filtered, or merged.
 */
export async function copyStaticProjectRepresentation(input: {
  sourceSnapshotWorkspaceDir: string
  destinationWorkspaceDir: string
  /** Diagnostic progress hook; a thrown error leaves resumable preparing state. */
  onFilePublished?: (progress: StaticProjectCopyProgress) => void | Promise<void>
}): Promise<StaticProjectCopyResult> {
  const sourceRoot = path.resolve(input.sourceSnapshotWorkspaceDir)
  const destinationRoot = path.resolve(input.destinationWorkspaceDir)
  if (sourceRoot === destinationRoot) {
    throw new Error("Static project copy source and destination must be different workspaces")
  }

  const sourceInfo = await lstat(sourceRoot)
  if (!sourceInfo.isDirectory()) throw new Error("Static project copy source must be a workspace directory")
  await mkdir(destinationRoot, { recursive: true })
  const destinationInfo = await lstat(destinationRoot)
  if (!destinationInfo.isDirectory()) {
    throw new Error("Static project copy destination must be a regular directory")
  }

  const source = await loadStaticRepresentation(sourceRoot)
  const targetBefore = await loadStaticRepresentation(destinationRoot)
  const markerPath = path.join(destinationRoot, STATIC_MEMORY_SCAFFOLD_MARKER)
  const markerAlreadyPresent = await regularFileExists(markerPath, "scaffold marker")
  const existingJournal = await readPreparingJournal(destinationRoot, source.manifest)

  if (markerAlreadyPresent) {
    if (!sameManifest(targetBefore.manifest, source.manifest)) {
      throw new Error(
        `Static project destination contains a different representation (${targetBefore.manifest.representationHash})`,
      )
    }
    if (existingJournal) await removePreparingState(destinationRoot, existingJournal)
    return {
      outcome: "already_present",
      source: source.manifest,
      target: targetBefore.manifest,
    }
  }

  if (existingJournal) assertRecoverablePartialTarget(targetBefore, source)
  else if (targetBefore.files.length > 0 && !sameManifest(targetBefore.manifest, source.manifest)) {
    throw new Error(
      `Static project destination contains a different representation (${targetBefore.manifest.representationHash})`,
    )
  }

  const journal = existingJournal ?? await beginPreparingJournal(destinationRoot, source.manifest)
  const stagingRoot = path.join(destinationRoot, journal.stagingDirectory)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot)
  try {
    const existingByPath = new Map(targetBefore.files.map((file) => [file.relPath, file]))
    let publishedCount = 0
    for (const file of source.files) {
      const existing = existingByPath.get(file.relPath)
      if (existing) {
        if (existing.byteLength !== file.byteLength || existing.sha256 !== file.sha256) {
          throw new Error(`Static project destination differs at ${file.relPath}`)
        }
        continue
      }
      const stagedPath = path.join(stagingRoot, ...file.relPath.split("/"))
      await mkdir(path.dirname(stagedPath), { recursive: true })
      await writeFile(stagedPath, file.bytes)
      const destinationPath = path.join(destinationRoot, ...file.relPath.split("/"))
      if (file.relPath.startsWith(`${STATIC_MEMORY_DIR}/`) && !await pathExists(path.dirname(destinationPath))) {
        await mkdir(path.dirname(destinationPath))
      }
      if (!await publishFileExclusively(stagedPath, destinationPath)) {
        const raced = await loadRegularFile(destinationRoot, file.relPath)
        if (raced.byteLength !== file.byteLength || raced.sha256 !== file.sha256) {
          throw new Error(`Static project destination changed during copy: ${file.relPath}`)
        }
      }
      publishedCount += 1
      await input.onFilePublished?.({
        relPath: file.relPath,
        publishedCount,
        totalFiles: source.files.length,
      })
    }

    const target = await loadStaticRepresentation(destinationRoot)
    if (!sameManifest(target.manifest, source.manifest)) {
      throw new Error("Static project destination changed while the representation was being published")
    }
    const markerCreated = await ensureScaffoldMarker(
      stagingRoot,
      destinationRoot,
      source.manifest.representationHash,
    )
    if (!markerCreated && !await regularFileExists(markerPath, "scaffold marker")) {
      throw new Error("Static project destination could not commit its scaffold marker")
    }
    await removePreparingState(destinationRoot, journal)
    return {
      outcome: markerCreated ? "copied" : "already_present",
      source: source.manifest,
      target: target.manifest,
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}
