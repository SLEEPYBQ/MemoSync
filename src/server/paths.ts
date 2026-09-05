import { existsSync, renameSync } from "node:fs"
import { mkdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

/** Per-project data directory (uploads, exports, quick actions). */
export const PROJECT_DATA_DIR_NAME = ".memosync"
/** Kanna-era name; migrated to PROJECT_DATA_DIR_NAME on first touch. */
export const LEGACY_PROJECT_DATA_DIR_NAME = ".kanna"

/**
 * Resolve a project's data dir, renaming a legacy `.kanna` dir to `.memosync`
 * the first time the project is touched after the rebrand. Rename-if-absent
 * only — if both exist (hand-made), the legacy dir is left alone.
 */
export function getProjectDataDir(localPath: string) {
  const root = resolveLocalPath(localPath)
  const current = path.join(root, PROJECT_DATA_DIR_NAME)
  const legacy = path.join(root, LEGACY_PROJECT_DATA_DIR_NAME)
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current)
    } catch {
      // Fall through: callers create `current` on demand; the legacy dir is
      // then simply orphaned rather than blocking the operation.
    }
  }
  return current
}

export function resolveLocalPath(localPath: string) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homedir()
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export async function ensureProjectDirectory(localPath: string) {
  const resolvedPath = resolveLocalPath(localPath)

  await mkdir(resolvedPath, { recursive: true })
  const info = await stat(resolvedPath)
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }
}

export function getProjectUploadDir(localPath: string) {
  return path.join(getProjectDataDir(localPath), "uploads")
}

export function getProjectExportDir(localPath: string) {
  return path.join(getProjectDataDir(localPath), "exports")
}

export type ContainedPathResult =
  | { ok: true; path: string; root: string }
  | { ok: false; reason: "outside" | "missing" }

/** Resolve an existing path without allowing lexical traversal or symlink escape. */
export async function resolveExistingPathWithinRoot(rootPath: string, relativePath: string): Promise<ContainedPathResult> {
  const lexicalRoot = path.resolve(rootPath)
  const lexicalTarget = path.resolve(lexicalRoot, relativePath)
  if (lexicalTarget !== lexicalRoot && !lexicalTarget.startsWith(`${lexicalRoot}${path.sep}`)) {
    return { ok: false, reason: "outside" }
  }

  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalTarget),
    ])
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      return { ok: false, reason: "outside" }
    }
    return { ok: true, path: resolvedTarget, root: resolvedRoot }
  } catch {
    return { ok: false, reason: "missing" }
  }
}
