// Workspace metadata + file APIs for client surfaces that live outside a
// chat's ws state (Memory Board origin labels, the Files workbench panel):
// listing, recursive index, content search, and file operations
// (create/mkdir/rename/delete). Same `{ data } / { error }` envelope as the
// memory routes.
import { existsSync } from "node:fs"
import type { Dirent } from "node:fs"
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveExistingPathWithinRoot } from "./paths"
import type { StudyProjectAccess } from "./study-project-access"

interface ProjectLike {
  id: string
  title: string
  localPath: string
}

interface ChatLike {
  id: string
  title: string
  projectId: string
}

export interface WorkspaceStoreLike {
  listProjects(): ProjectLike[]
  listChats(): ChatLike[]
  getProject(projectId: string): ProjectLike | undefined | null
}

export interface WorkspaceFileEntry {
  name: string
  kind: "file" | "dir"
  size: number
}

export interface WorkspaceRouteOptions {
  /** Atomic study boundary: returns a release callback, or null once freeze starts. */
  beginStudyMemoryMutation?: () => (() => void) | null
  /** Present only in study mode: gates project-scoped writes, never reads. */
  studyProjectAccess?: StudyProjectAccess
}

const ok = <T>(data: T): Response => Response.json({ data })
const fail = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

const FILES_RE = /^\/api\/projects\/([^/]+)\/files$/
const FILE_INDEX_RE = /^\/api\/projects\/([^/]+)\/files\/index$/
const FILE_SEARCH_RE = /^\/api\/projects\/([^/]+)\/files\/search$/
const FILE_OP_RE = /^\/api\/projects\/([^/]+)\/files\/op$/
const MEMORY_FILE_RE = /^\/api\/projects\/[^/]+\/memory-file$/

/** Directories skipped by the recursive file index (filter/quick-open only —
 * the lazy per-directory tree still lists them like any other folder). */
const INDEX_IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".cache",
  ".turbo", "coverage", "__pycache__", ".venv", "venv", "target", ".DS_Store",
])
const INDEX_MAX_FILES = 8000
const INDEX_MAX_DEPTH = 16

/** Walk the workspace and collect relative file paths for the filter box. */
async function collectFileIndex(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  const walk = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
    if (truncated || depth > INDEX_MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!INDEX_IGNORED_DIRS.has(entry.name)) await walk(path.join(dirAbs, entry.name), rel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= INDEX_MAX_FILES) {
        truncated = true
        return
      }
      files.push(rel)
    }
  }
  await walk(root, "", 0)
  return { files, truncated }
}

const SEARCH_MAX_RESULTS = 300
const SEARCH_MAX_PER_FILE = 20
const SEARCH_MAX_FILE_BYTES = 512 * 1024

export interface ContentSearchMatch {
  path: string
  line: number
  /** The matching line, trimmed, capped at 200 chars. */
  text: string
  /** 0-based column of the first hit inside `text`. */
  col: number
}

/** Case-insensitive substring search across indexed workspace files. */
async function searchFileContents(root: string, query: string): Promise<{ results: ContentSearchMatch[]; truncated: boolean }> {
  const needle = query.toLowerCase()
  const { files, truncated: indexTruncated } = await collectFileIndex(root)
  const results: ContentSearchMatch[] = []
  let truncated = indexTruncated
  for (const rel of files) {
    if (results.length >= SEARCH_MAX_RESULTS) {
      truncated = true
      break
    }
    const abs = path.join(root, rel)
    try {
      if ((await stat(abs)).size > SEARCH_MAX_FILE_BYTES) continue
      const content = await Bun.file(abs).text()
      // Cheap binary sniff: NUL almost never appears in text files.
      if (content.includes("\0")) continue
      let perFile = 0
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(needle)
        if (idx === -1) continue
        const trimmed = lines[i].trim()
        results.push({
          path: rel,
          line: i + 1,
          text: trimmed.slice(0, 200),
          col: Math.max(0, trimmed.toLowerCase().indexOf(needle)),
        })
        if (++perFile >= SEARCH_MAX_PER_FILE) break
        if (results.length >= SEARCH_MAX_RESULTS) {
          truncated = true
          break
        }
      }
    } catch {
      // Unreadable file (permissions, raced deletion) — skip it.
    }
  }
  return { results, truncated }
}

type TargetPathResult =
  | { ok: true; path: string; exists: boolean }
  | { ok: false; reason: "outside" | "invalid" }

/**
 * Resolve a possibly-not-yet-existing relative path without lexical traversal
 * or symlink escape: the deepest existing ancestor's realpath must stay inside
 * the (realpathed) root.
 */
async function resolveTargetPathWithinRoot(rootPath: string, rel: string): Promise<TargetPathResult> {
  const normalized = path.posix.normalize(rel.replaceAll("\\", "/"))
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    return { ok: false, reason: "invalid" }
  }
  const rootResolved = await resolveExistingPathWithinRoot(rootPath, "")
  if (!rootResolved.ok) return { ok: false, reason: "invalid" }
  const root = rootResolved.path
  const target = path.resolve(root, normalized)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return { ok: false, reason: "outside" }

  let ancestor = path.dirname(target)
  while (ancestor !== root && !existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const ancestorRel = path.relative(root, ancestor).split(path.sep).join("/")
  const ancestorResolved = await resolveExistingPathWithinRoot(root, ancestorRel)
  if (!ancestorResolved.ok) return { ok: false, reason: "outside" }

  const suffix = path.relative(ancestor, target)
  const realTarget = suffix ? path.join(ancestorResolved.path, suffix) : ancestorResolved.path
  return { ok: true, path: realTarget, exists: existsSync(realTarget) }
}

const FILE_OPS = new Set(["create", "mkdir", "rename", "delete"])

async function handleFileOp(req: Request, localPath: string): Promise<Response> {
  let body: { op?: string; path?: string; toPath?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return fail(400, "BAD_REQUEST", "invalid JSON body")
  }
  const { op, path: rel, toPath } = body
  if (!op || !FILE_OPS.has(op)) return fail(400, "BAD_REQUEST", "unknown op")
  if (typeof rel !== "string" || !rel) return fail(400, "BAD_REQUEST", "path is required")

  const target = await resolveTargetPathWithinRoot(localPath, rel)
  if (!target.ok) return fail(400, "BAD_REQUEST", "path escapes the project root")

  try {
    switch (op) {
      case "create": {
        if (target.exists) return fail(409, "CONFLICT", "file already exists")
        await mkdir(path.dirname(target.path), { recursive: true })
        await writeFile(target.path, "", { flag: "wx" })
        return ok({ done: true })
      }
      case "mkdir": {
        if (target.exists) return fail(409, "CONFLICT", "directory already exists")
        await mkdir(target.path, { recursive: true })
        return ok({ done: true })
      }
      case "rename": {
        if (!target.exists) return fail(404, "NOT_FOUND", "source not found")
        if (typeof toPath !== "string" || !toPath) return fail(400, "BAD_REQUEST", "toPath is required")
        const dest = await resolveTargetPathWithinRoot(localPath, toPath)
        if (!dest.ok) return fail(400, "BAD_REQUEST", "toPath escapes the project root")
        if (dest.exists) return fail(409, "CONFLICT", "target already exists")
        await mkdir(path.dirname(dest.path), { recursive: true })
        await rename(target.path, dest.path)
        return ok({ done: true })
      }
      case "delete": {
        if (!target.exists) return fail(404, "NOT_FOUND", "path not found")
        await rm(target.path, { recursive: true })
        return ok({ done: true })
      }
    }
  } catch {
    return fail(500, "INTERNAL", `${op} failed`)
  }
  return fail(400, "BAD_REQUEST", "unknown op")
}

/**
 * Handle `/api/projects`, `/api/chats`, `/api/projects/:id/files?dir=rel`,
 * `/api/projects/:id/files/index`, `/api/projects/:id/files/search?q=` and
 * `POST /api/projects/:id/files/op`. Returns null when the path is not ours
 * (caller falls through).
 */
export async function handleWorkspaceRequest(
  req: Request,
  url: URL,
  store: WorkspaceStoreLike,
  options: WorkspaceRouteOptions = {},
): Promise<Response | null> {
  const { pathname } = url
  const filesMatch = pathname.match(FILES_RE)
  const indexMatch = pathname.match(FILE_INDEX_RE)
  const searchMatch = pathname.match(FILE_SEARCH_RE)
  const opMatch = pathname.match(FILE_OP_RE)
  if (pathname !== "/api/projects" && pathname !== "/api/chats" && !filesMatch && !indexMatch && !searchMatch && !opMatch && !MEMORY_FILE_RE.test(pathname)) {
    return null
  }

  if (MEMORY_FILE_RE.test(pathname)) return fail(404, "NOT_FOUND", "route not found")

  if (opMatch) {
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "use POST")
    const projectId = decodeURIComponent(opMatch[1])
    const projectRefusal = options.studyProjectAccess?.projectRefusal(projectId)
    if (projectRefusal) return fail(409, "STUDY_PROJECT_LOCKED", projectRefusal)
    const release = options.beginStudyMemoryMutation?.()
    if (options.beginStudyMemoryMutation && !release) {
      return fail(409, "STUDY_FROZEN", "The current session is ending. Workspace files can no longer be changed.")
    }
    const project = store.getProject(projectId)
    try {
      if (!project) return fail(404, "NOT_FOUND", "unknown project")
      return await handleFileOp(req, project.localPath)
    } finally {
      release?.()
    }
  }

  if (req.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "use GET")

  if (searchMatch) {
    const project = store.getProject(decodeURIComponent(searchMatch[1]))
    if (!project) return fail(404, "NOT_FOUND", "unknown project")
    const q = url.searchParams.get("q") ?? ""
    if (q.trim().length < 2) return fail(400, "BAD_REQUEST", "query must be at least 2 characters")
    const resolved = await resolveExistingPathWithinRoot(project.localPath, "")
    if (!resolved.ok) return fail(404, "NOT_FOUND", "project directory not found")
    return ok(await searchFileContents(resolved.path, q.trim()))
  }

  if (pathname === "/api/projects") {
    return ok(store.listProjects().map((p) => ({ id: p.id, title: p.title })))
  }

  if (pathname === "/api/chats") {
    return ok(store.listChats().map((c) => ({ id: c.id, title: c.title, projectId: c.projectId })))
  }

  if (indexMatch) {
    const project = store.getProject(decodeURIComponent(indexMatch[1]))
    if (!project) return fail(404, "NOT_FOUND", "unknown project")
    const resolved = await resolveExistingPathWithinRoot(project.localPath, "")
    if (!resolved.ok) return fail(404, "NOT_FOUND", "project directory not found")
    return ok(await collectFileIndex(resolved.path))
  }

  const project = store.getProject(decodeURIComponent(filesMatch![1]))
  if (!project) return fail(404, "NOT_FOUND", "unknown project")

  const rel = url.searchParams.get("dir") ?? ""
  const resolved = await resolveExistingPathWithinRoot(project.localPath, rel)
  if (!resolved.ok) {
    return resolved.reason === "outside"
      ? fail(400, "BAD_REQUEST", "directory escapes the project root")
      : fail(404, "NOT_FOUND", "directory not found")
  }
  const { path: target, root } = resolved

  let names: Dirent[]
  try {
    names = await readdir(target, { withFileTypes: true })
  } catch {
    return fail(404, "NOT_FOUND", "directory not found")
  }

  const entries: WorkspaceFileEntry[] = []
  for (const entry of names) {
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: "dir", size: 0 })
      continue
    }
    if (!entry.isFile()) continue
    let size = 0
    try {
      size = (await stat(path.join(target, entry.name))).size
    } catch {
      continue
    }
    entries.push({ name: entry.name, kind: "file", size })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))

  return ok({ dir: path.relative(root, target).split(path.sep).join("/"), entries })
}
