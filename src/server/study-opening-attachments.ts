import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ChatAttachment } from "../shared/types"

export interface CapturedOpeningAttachment {
  attachment: ChatAttachment
  bytes: Buffer
  contentSha256: string
  byteSize: number
}

export interface ContainedAttachmentBytes {
  bytes: Buffer
  contentSha256: string
  byteSize: number
}

export interface StudyOpeningAttachmentSnapshot {
  attachmentId: string
  kind: ChatAttachment["kind"]
  displayName: string
  mimeType: string
  contentSha256: string
  byteSize: number
  snapshotPath: string
}

export type StudyOpeningAttachmentVerification =
  | { ok: true; attachments: ChatAttachment[] }
  | { ok: false; error: string }

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`)
}

function openContainedRegularFile(root: string, absolutePath: string): { fd: number; size: number } | null {
  if (!isAbsolute(absolutePath)) return null
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(absolutePath)
  if (!isWithin(lexicalRoot, lexicalTarget)) return null

  try {
    const rootInfo = lstatSync(lexicalRoot)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null
    let cursor = lexicalRoot
    const segments = relative(lexicalRoot, lexicalTarget).split(sep).filter(Boolean)
    if (segments.length === 0) return null
    for (const [index, segment] of segments.entries()) {
      cursor = resolve(cursor, segment)
      const info = lstatSync(cursor)
      if (info.isSymbolicLink()) return null
      const leaf = index === segments.length - 1
      if (leaf ? !info.isFile() : !info.isDirectory()) return null
    }
    const realRoot = realpathSync(lexicalRoot)
    const realTarget = realpathSync(lexicalTarget)
    if (!isWithin(realRoot, realTarget)) return null
    const fd = openSync(lexicalTarget, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = fstatSync(fd)
    if (!info.isFile()) {
      closeSync(fd)
      return null
    }
    return { fd, size: info.size }
  } catch {
    return null
  }
}

function readExact(fd: number, size: number): Buffer | null {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset)
    if (read <= 0) return null
    offset += read
  }
  return bytes
}

export function captureContainedAttachment(
  projectRoot: string,
  attachment: ChatAttachment,
): CapturedOpeningAttachment | null {
  const captured = readContainedAttachmentBytes(projectRoot, attachment.absolutePath)
  if (!captured) return null
  return {
    attachment: structuredClone(attachment),
    ...captured,
  }
}

export function readContainedAttachmentBytes(
  projectRoot: string,
  absolutePath: string,
): ContainedAttachmentBytes | null {
  const opened = openContainedRegularFile(projectRoot, absolutePath)
  if (!opened) return null
  try {
    const bytes = readExact(opened.fd, opened.size)
    if (!bytes) return null
    return {
      bytes,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    }
  } finally {
    closeSync(opened.fd)
  }
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Opening attachment snapshot directory is not a private server directory")
  }
}

function safeExtension(displayName: string): string {
  const extension = extname(displayName).toLocaleLowerCase("en-US")
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ""
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset)
    if (written <= 0) throw new Error("Could not persist the opening attachment snapshot")
    offset += written
  }
}

export function createStudyOpeningAttachmentSnapshotStore(snapshotRootInput: string) {
  const snapshotRoot = resolve(snapshotRootInput)

  const verify = (
    snapshots: readonly StudyOpeningAttachmentSnapshot[],
  ): StudyOpeningAttachmentVerification => {
    const attachments: ChatAttachment[] = []
    const seenIds = new Set<string>()
    for (const snapshot of snapshots) {
      if (
        !snapshot
        || typeof snapshot.attachmentId !== "string"
        || !snapshot.attachmentId
        || (snapshot.kind !== "file" && snapshot.kind !== "image")
        || typeof snapshot.displayName !== "string"
        || typeof snapshot.mimeType !== "string"
        || !/^[a-f0-9]{64}$/.test(snapshot.contentSha256)
        || !Number.isSafeInteger(snapshot.byteSize)
        || snapshot.byteSize < 0
        || typeof snapshot.snapshotPath !== "string"
        || seenIds.has(snapshot.attachmentId)
      ) {
        return { ok: false, error: "The durable opening attachment receipt is invalid" }
      }
      seenIds.add(snapshot.attachmentId)
      const opened = openContainedRegularFile(snapshotRoot, snapshot.snapshotPath)
      if (!opened || opened.size !== snapshot.byteSize) {
        if (opened) closeSync(opened.fd)
        return { ok: false, error: "A durable opening attachment snapshot is missing or has the wrong size" }
      }
      try {
        const bytes = readExact(opened.fd, opened.size)
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== snapshot.contentSha256) {
          return { ok: false, error: "A durable opening attachment snapshot failed its content digest" }
        }
      } finally {
        closeSync(opened.fd)
      }
      const exactPath = resolve(snapshot.snapshotPath)
      attachments.push({
        id: snapshot.attachmentId,
        kind: snapshot.kind,
        displayName: snapshot.displayName,
        absolutePath: exactPath,
        // Claude sees only the immutable server path in either path field.
        relativePath: exactPath,
        contentUrl: "",
        mimeType: snapshot.mimeType,
        size: snapshot.byteSize,
      })
    }
    return { ok: true, attachments }
  }

  const persist = (
    reviewId: string,
    captured: readonly CapturedOpeningAttachment[],
  ): StudyOpeningAttachmentSnapshot[] => {
    if (!reviewId.trim()) throw new Error("Opening review id is required for attachment snapshots")
    ensureDirectory(snapshotRoot)
    const reviewDirectory = join(
      snapshotRoot,
      createHash("sha256").update(reviewId, "utf8").digest("hex"),
    )
    ensureDirectory(reviewDirectory)
    const snapshots = captured.map((item, index) => {
      const fileName = `${String(index).padStart(3, "0")}-${item.contentSha256}${safeExtension(item.attachment.displayName)}`
      const snapshotPath = join(reviewDirectory, fileName)
      const snapshot: StudyOpeningAttachmentSnapshot = {
        attachmentId: item.attachment.id,
        kind: item.attachment.kind,
        displayName: item.attachment.displayName,
        mimeType: item.attachment.mimeType,
        contentSha256: item.contentSha256,
        byteSize: item.byteSize,
        snapshotPath,
      }
      const existing = verify([snapshot])
      if (existing.ok) return snapshot

      const temporaryPath = join(reviewDirectory, `.${fileName}.${randomUUID()}.tmp`)
      let fd: number | null = null
      try {
        fd = openSync(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
        writeAll(fd, item.bytes)
        fsyncSync(fd)
        closeSync(fd)
        fd = null
        chmodSync(temporaryPath, 0o400)
        try {
          linkSync(temporaryPath, snapshotPath)
        } catch (error) {
          const code = error instanceof Error && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined
          if (code !== "EEXIST") throw error
        }
      } finally {
        if (fd !== null) closeSync(fd)
        try { unlinkSync(temporaryPath) } catch { /* already cleaned */ }
      }
      const persisted = verify([snapshot])
      if (!persisted.ok) throw new Error(persisted.error)
      return snapshot
    })
    const verified = verify(snapshots)
    if (!verified.ok) throw new Error(verified.error)
    return snapshots
  }

  return { persist, verify }
}

export type StudyOpeningAttachmentSnapshotStore = ReturnType<typeof createStudyOpeningAttachmentSnapshotStore>
