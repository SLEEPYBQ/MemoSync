import { randomUUID } from "node:crypto"
import { constants, lstatSync, rmSync, type BigIntStats } from "node:fs"
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import type { ChatAttachment } from "../shared/types"
import {
  getProjectDataDir,
  getProjectUploadDir,
  PROJECT_DATA_DIR_NAME,
  resolveExistingPathWithinRoot,
  resolveLocalPath,
  type ContainedPathResult,
} from "./paths"

const DEFAULT_BINARY_MIME_TYPE = "application/octet-stream"
const IMAGE_MIME_PREFIX = "image/"
const TEXT_PLAIN_CONTENT_TYPE = "text/plain; charset=utf-8"
const MAX_RECENT_DRAFT_UPLOAD_RECEIPTS = 1024
const DRAFT_VERIFY_CHUNK_BYTES = 256 * 1024

const TEXT_CONTENT_TYPE_BY_EXTENSION = new Map<string, string>([
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsonc", TEXT_PLAIN_CONTENT_TYPE],
  [".md", "text/markdown; charset=utf-8"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
])

const TEXT_LIKE_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".env", ".go", ".graphql", ".h", ".hpp", ".htm", ".html",
  ".ini", ".java", ".js", ".jsx", ".kt", ".lua", ".mjs", ".php", ".pl", ".properties", ".py", ".rb", ".rs",
  ".scss", ".sh", ".shtml", ".sql", ".svg", ".svgz", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xht", ".xhtml", ".xml", ".yaml", ".yml", ".zsh",
])

function isWithin(root: string, target: string) {
  return target === root || target.startsWith(`${root}${path.sep}`)
}

async function ensureContainedDirectory(
  directoryPath: string,
  projectRoot: string,
  create: boolean,
): Promise<ContainedPathResult> {
  try {
    let info
    try {
      info = await lstat(directoryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
        return { ok: false, reason: "missing" }
      }
      try {
        await mkdir(directoryPath)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError
      }
      info = await lstat(directoryPath)
    }

    // Reject links even when they currently point inside the project: keeping
    // the upload boundary as real directories avoids link swaps redirecting a
    // later write or delete.
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { ok: false, reason: "outside" }
    }
    const resolved = await realpath(directoryPath)
    if (!isWithin(projectRoot, resolved)) {
      return { ok: false, reason: "outside" }
    }
    return { ok: true, path: resolved, root: projectRoot }
  } catch {
    return { ok: false, reason: "missing" }
  }
}

async function resolveProjectUploadDirectory(localPath: string, create: boolean): Promise<ContainedPathResult> {
  try {
    const projectPath = resolveLocalPath(localPath)
    const projectRoot = await realpath(projectPath)
    if (!(await stat(projectRoot)).isDirectory()) return { ok: false, reason: "missing" }

    // getProjectDataDir also migrates a legacy `.kanna` dir on first touch.
    const dataDir = await ensureContainedDirectory(getProjectDataDir(projectPath), projectRoot, create)
    if (!dataDir.ok) return dataDir
    return ensureContainedDirectory(path.join(projectPath, PROJECT_DATA_DIR_NAME, "uploads"), projectRoot, create)
  } catch {
    return { ok: false, reason: "missing" }
  }
}

export async function resolveExistingProjectUpload(
  localPath: string,
  storedName: string,
): Promise<ContainedPathResult> {
  const uploadDir = await resolveProjectUploadDirectory(localPath, false)
  if (!uploadDir.ok) return uploadDir
  const lexicalTarget = path.resolve(uploadDir.path, storedName)
  if (!isWithin(uploadDir.path, lexicalTarget)) return { ok: false, reason: "outside" }
  try {
    if ((await lstat(lexicalTarget)).isSymbolicLink()) return { ok: false, reason: "outside" }
  } catch {
    return { ok: false, reason: "missing" }
  }
  return resolveExistingPathWithinRoot(uploadDir.path, storedName)
}

function sanitizeFileName(fileName: string) {
  const baseName = path.basename(fileName).trim()
  // Keep Unicode letters/marks/numbers (CJK, accents, etc.) plus . _ -; collapse
  // everything else to "-". `\w` is ASCII-only, so it erased entire non-Latin
  // names — "报告.pdf" became ".pdf", a hidden extension-less dotfile whose
  // Content-Type could not be inferred and which collided with every other
  // pure-CJK file of the same type (BUG HTTP-2).
  const cleaned = baseName
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  // A leading dot means the base name collapsed away (e.g. an all-emoji name),
  // leaving only an extension — path.parse reads ".png" as a dotfile with NO
  // extension. Give it a real base so the extension (and Content-Type) survives.
  if (!cleaned || cleaned.startsWith(".")) return `upload${cleaned}`
  return cleaned
}

function getUploadCandidateNames(originalName: string) {
  const sanitizedName = sanitizeFileName(originalName)
  const parsed = path.parse(sanitizedName)
  const extension = parsed.ext
  const name = parsed.name || "upload"

  return {
    first: sanitizedName,
    withCounter(counter: number) {
      return `${name}-${counter}${extension}`
    },
  }
}

export interface DraftUploadWrite {
  projectId: string
  localPath: string
  physicalPath: string
  storedName: string
  receipt: string
  version?: string
}

function fileIdentity(s: BigIntStats) {
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`
}

function fileVersion(s: BigIntStats) {
  return s.isFile() && s.ino !== 0n ? `${fileIdentity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : undefined
}

// The writer has closed (Windows can publish its last-write time on close).
// A workspace edit can keep the same inode and length, so neither alone
// proves this is still our upload. Compare the bytes using one bounded buffer.
async function verifiedDraftVersion(physicalPath: string, identity: string, expected: Uint8Array) {
  const before = await lstat(physicalPath, { bigint: true })
  const version = fileVersion(before)
  if (!version || fileIdentity(before) !== identity || before.size !== BigInt(expected.byteLength)) return

  const reader = await open(physicalPath, process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (fileVersion(await reader.stat({ bigint: true })) !== version) return
    const chunk = Buffer.allocUnsafe(Math.min(expected.byteLength, DRAFT_VERIFY_CHUNK_BYTES))
    for (let pos = 0; pos < expected.byteLength;) {
      const { bytesRead } = await reader.read(chunk, 0, Math.min(chunk.length, expected.byteLength - pos), pos)
      if (!bytesRead || !chunk.subarray(0, bytesRead).equals(expected.subarray(pos, pos + bytesRead))) return
      pos += bytesRead
    }
    // Keep the checked stamp, never a newer version observed after the read.
    if (fileVersion(await lstat(physicalPath, { bigint: true })) === version) return version
  } finally { await reader.close() }
}

/** Only unadopted POST results use these receipts. Eviction forgets authority, never files. */
export class DraftUploadReceipts {
  private readonly byPath = new Map<string, DraftUploadWrite>()
  private readonly published = new Map<string, DraftUploadWrite>()

  private forget(write: DraftUploadWrite) {
    this.published.delete(write.receipt)
    if (this.byPath.get(write.physicalPath) === write) this.byPath.delete(write.physicalPath)
  }

  opened(physicalPath: string, localPath: string, projectId: string, batch?: DraftUploadWrite[]) {
    const previous = this.byPath.get(physicalPath)
    if (previous) this.forget(previous) // A new exclusive create supersedes any old receipt.
    if (!batch) return
    const write: DraftUploadWrite = { projectId, localPath, physicalPath, storedName: path.basename(physicalPath), receipt: randomUUID() }
    this.byPath.set(physicalPath, write)
    batch.push(write)
    return write
  }

  publish(write: DraftUploadWrite) {
    if (this.byPath.get(write.physicalPath) === write) {
      // Bound completed responses, not writes still owned by a running POST.
      if (this.published.size >= MAX_RECENT_DRAFT_UPLOAD_RECEIPTS) this.forget(this.published.values().next().value!)
      this.published.set(write.receipt, write)
    }
    return write.receipt
  }

  take(projectId: string, storedName: string, receipt: string) {
    const write = this.published.get(receipt)
    if (write?.projectId !== projectId || write.storedName !== storedName) return
    this.published.delete(receipt)
    return write
  }

  async discard(write: DraftUploadWrite) {
    try {
      return await deleteProjectUpload({
        localPath: write.localPath, storedName: write.storedName,
        beforeDelete: physicalPath => this.byPath.get(write.physicalPath) === write
          && path.relative(path.dirname(write.physicalPath), path.dirname(physicalPath)) === ""
          && !!write.version && fileVersion(lstatSync(physicalPath, { bigint: true })) === write.version,
      })
    } finally { this.forget(write) }
  }
}

export interface UploadTracking {
  receipts: DraftUploadReceipts
  draftWrites?: DraftUploadWrite[]
}

export async function persistProjectUpload(args: {
  projectId: string
  localPath: string
  fileName: string
  bytes: Uint8Array
  fallbackMimeType?: string
  tracking?: UploadTracking
}): Promise<ChatAttachment> {
  const resolvedUploadDir = await resolveProjectUploadDirectory(args.localPath, true)
  if (!resolvedUploadDir.ok) {
    throw new Error("Project upload directory is missing or escapes the project root")
  }
  // Write in the verified directory, but keep the public attachment path in
  // the lexical form the caller supplied (e.g. /var vs /private/var on macOS).
  const uploadDir = getProjectUploadDir(args.localPath)

  const detectedType = await fileTypeFromBuffer(args.bytes)
  const mimeType = inferAttachmentContentType(
    args.fileName,
    detectedType?.mime ?? args.fallbackMimeType ?? DEFAULT_BINARY_MIME_TYPE,
  )
  const candidates = getUploadCandidateNames(args.fileName)

  let storedName = candidates.first
  let absolutePath = path.join(uploadDir, storedName)
  let counter = 1

  while (true) {
    try {
      const physicalPath = path.join(resolvedUploadDir.path, storedName)
      const handle = await open(physicalPath, "wx")
      const write = args.tracking?.receipts.opened(physicalPath, resolvedUploadDir.root, args.projectId, args.tracking.draftWrites)
      let identity: string | undefined
      try {
        await handle.writeFile(args.bytes)
        if (write) identity = await handle.stat({ bigint: true }).then(fileIdentity, () => undefined)
      } finally {
        await handle.close()
      }
      if (write && identity) {
        write.version = await verifiedDraftVersion(physicalPath, identity, args.bytes).catch(() => undefined)
      }
      break
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== "EEXIST") {
        throw error
      }

      storedName = candidates.withCounter(counter)
      absolutePath = path.join(uploadDir, storedName)
      counter += 1
    }
  }

  return {
    id: randomUUID(),
    kind: mimeType.startsWith(IMAGE_MIME_PREFIX) ? "image" : "file",
    displayName: args.fileName,
    absolutePath,
    relativePath: `./${PROJECT_DATA_DIR_NAME}/uploads/${storedName}`,
    contentUrl: `/api/projects/${args.projectId}/uploads/${encodeURIComponent(storedName)}/content`,
    mimeType,
    size: args.bytes.byteLength,
  }
}

export function inferAttachmentContentType(fileName: string, fallbackType?: string): string {
  const extension = path.extname(fileName).toLowerCase()
  const mappedType = TEXT_CONTENT_TYPE_BY_EXTENSION.get(extension)
  if (mappedType) {
    return mappedType
  }

  if (TEXT_LIKE_EXTENSIONS.has(extension)) {
    return TEXT_PLAIN_CONTENT_TYPE
  }

  return fallbackType || DEFAULT_BINARY_MIME_TYPE
}

export function inferProjectFileContentType(fileName: string, fallbackType?: string): string {
  return inferAttachmentContentType(fileName, fallbackType)
}

export async function deleteProjectUpload(args: {
  localPath: string
  storedName: string
  beforeDelete?: (physicalPath: string) => boolean
}): Promise<boolean> {
  const storedName = args.storedName
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return false
  }

  const resolved = await resolveExistingProjectUpload(args.localPath, storedName)
  if (!resolved.ok) return false
  try {
    // No intervening MemoSync delete/recreate between the ownership check and unlink.
    if (args.beforeDelete && !args.beforeDelete(resolved.path)) return false
    rmSync(resolved.path, { force: true })
    return true
  } catch {
    return false
  }
}
