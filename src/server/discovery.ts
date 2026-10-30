import { access, open, readFile, readdir, stat } from "node:fs/promises"

async function exists(filePath: string) {
  try { await access(filePath); return true } catch { return false }
}
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import { resolveLocalPath } from "./paths"

export interface DiscoveredProject {
  localPath: string
  title: string
  modifiedAt: number
}

export interface ProviderDiscoveredProject extends DiscoveredProject {
  provider: AgentProvider
}

export interface ProjectDiscoveryAdapter {
  provider: AgentProvider
  scan(homeDir?: string): ProviderDiscoveredProject[] | Promise<ProviderDiscoveredProject[]>
}

async function resolveEncodedClaudePath(folderName: string) {
  const segments = folderName.replace(/^-/, "").split("-").filter(Boolean)
  let currentPath = ""
  let remainingSegments = [...segments]

  while (remainingSegments.length > 0) {
    let found = false

    for (let index = remainingSegments.length; index >= 1; index -= 1) {
      const segment = remainingSegments.slice(0, index).join("-")
      const candidate = `${currentPath}/${segment}`

      if (await exists(candidate)) {
        currentPath = candidate
        remainingSegments = remainingSegments.slice(index)
        found = true
        break
      }
    }

    if (!found) {
      const [head, ...tail] = remainingSegments
      currentPath = `${currentPath}/${head}`
      remainingSegments = tail
    }
  }

  return currentPath || "/"
}

async function normalizeExistingDirectory(localPath: string) {
  try {
    const normalized = resolveLocalPath(localPath)
    if (!(await stat(normalized)).isDirectory()) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

function mergeDiscoveredProjects(projects: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const merged = new Map<string, DiscoveredProject>()

  for (const project of projects) {
    const existing = merged.get(project.localPath)
    if (!existing || project.modifiedAt > existing.modifiedAt) {
      merged.set(project.localPath, {
        localPath: project.localPath,
        title: project.title || path.basename(project.localPath) || project.localPath,
        modifiedAt: project.modifiedAt,
      })
      continue
    }

    if (!existing.title && project.title) {
      existing.title = project.title
    }
  }

  return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export class ClaudeProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "claude" as const

  async scan(homeDir: string = homedir()): Promise<ProviderDiscoveredProject[]> {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    if (!await exists(projectsDir)) {
      return []
    }

    const entries = await readdir(projectsDir, { withFileTypes: true })
    const projects: ProviderDiscoveredProject[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const resolvedPath = await resolveEncodedClaudePath(entry.name)
      const normalizedPath = await normalizeExistingDirectory(resolvedPath)
      if (!normalizedPath) {
        continue
      }

      const marker = await stat(path.join(projectsDir, entry.name)).catch(() => null)
      if (!marker) continue
      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: marker.mtimeMs,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function readCodexSessionIndex(indexPath: string) {
  const updatedAtById = new Map<string, number>()
  if (!await exists(indexPath)) {
    return updatedAtById
  }

  for (const line of (await readFile(indexPath, "utf8")).split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    const id = typeof record.id === "string" ? record.id : null
    const updatedAt = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN
    if (!id || Number.isNaN(updatedAt)) continue

    const existing = updatedAtById.get(id)
    if (existing === undefined || updatedAt > existing) {
      updatedAtById.set(id, updatedAt)
    }
  }

  return updatedAtById
}

async function collectCodexSessionFiles(directory: string): Promise<string[]> {
  if (!await exists(directory)) {
    return []
  }

  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectCodexSessionFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath)
    }
  }
  return files
}

async function readCodexConfiguredProjects(configPath: string) {
  const projects = new Map<string, number>()
  if (!await exists(configPath)) {
    return projects
  }

  const configMtime = (await stat(configPath)).mtimeMs
  for (const line of (await readFile(configPath, "utf8")).split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configMtime)
  }

  return projects
}

// Rollout session files grow to hundreds of MB, and only the session_meta
// FIRST line matters here. Reading whole files wedged the single-threaded
// server for a minute+ on hosts with a large ~/.codex (observed: 23 GB / 789
// sessions → 63 s of synchronous CPU per discovery scan). A session_meta line
// is well under 8 KB; anything longer parses as null and is skipped.
const FIRST_LINE_READ_BYTES = 8192

async function readBoundedFirstLine(filePath: string): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>>
  try {
    fd = await open(filePath, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(FIRST_LINE_READ_BYTES)
    const { bytesRead: bytes } = await fd.read(buffer, 0, buffer.length, 0)
    const text = buffer.toString("utf8", 0, bytes)
    const newline = text.indexOf("\n")
    return newline === -1 ? text : text.slice(0, newline)
  } catch {
    return null
  } finally {
    await fd.close()
  }
}

async function readCodexSessionMetadata(sessionsDir: string, cache: Map<string, { stamp: string; line: string | null }>) {
  const metadataById = new Map<string, { cwd: string; modifiedAt: number }>()

  const files = await collectCodexSessionFiles(sessionsDir)
  const liveFiles = new Set(files)
  for (const key of cache.keys()) if (!liveFiles.has(key)) cache.delete(key)
  for (const sessionFile of files) {
    const fileStat = await stat(sessionFile).catch(() => null)
    if (!fileStat) continue
    const stamp = `${fileStat.mtimeMs}:${fileStat.size}`
    const cached = cache.get(sessionFile)
    const firstLine = cached?.stamp === stamp ? cached.line : await readBoundedFirstLine(sessionFile)
    // Cache only successful reads: a transient open/read failure must be retried
    // on the next scan, not hide the session until the file changes.
    if (firstLine === null) cache.delete(sessionFile)
    else cache.set(sessionFile, { stamp, line: firstLine })
    if (!firstLine?.trim()) continue

    const record = parseJsonRecord(firstLine)
    if (!record || record.type !== "session_meta") continue

    const payload = record.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue

    const payloadRecord = payload as Record<string, unknown>
    const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
    const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
    if (!sessionId || !cwd) continue

    const recordTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    const payloadTimestamp = typeof payloadRecord.timestamp === "string" ? Date.parse(payloadRecord.timestamp) : Number.NaN
    const modifiedAt = [recordTimestamp, payloadTimestamp, fileStat.mtimeMs].find((value) => !Number.isNaN(value)) ?? fileStat.mtimeMs

    metadataById.set(sessionId, { cwd, modifiedAt })
  }

  return metadataById
}

export class CodexProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "codex" as const
  private readonly metadataCache = new Map<string, { stamp: string; line: string | null }>()

  async scan(homeDir: string = homedir()): Promise<ProviderDiscoveredProject[]> {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const updatedAtById = await readCodexSessionIndex(indexPath)
    const metadataById = await readCodexSessionMetadata(sessionsDir, this.metadataCache)
    const configuredProjects = await readCodexConfiguredProjects(configPath)
    const projects: ProviderDiscoveredProject[] = []

    for (const [sessionId, metadata] of metadataById.entries()) {
      const modifiedAt = updatedAtById.get(sessionId) ?? metadata.modifiedAt
      const cwd = metadata.cwd
      if (!cwd) {
        continue
      }
      if (!path.isAbsolute(cwd)) {
        continue
      }

      const normalizedPath = await normalizeExistingDirectory(cwd)
      if (!normalizedPath) {
        continue
      }

      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      })
    }

    for (const [configuredPath, modifiedAt] of configuredProjects.entries()) {
      if (!path.isAbsolute(configuredPath)) {
        continue
      }

      const normalizedPath = await normalizeExistingDirectory(configuredPath)
      if (!normalizedPath) {
        continue
      }

      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

// Claude-only deployment: the Codex adapter stays exported for direct use and
// tests, but the default scan no longer touches ~/.codex — this build ships
// without the Codex engine, and hosts with years of Codex history pay dearly
// for a scan whose results the picker would never use.
export const DEFAULT_PROJECT_DISCOVERY_ADAPTERS: ProjectDiscoveryAdapter[] = [
  new ClaudeProjectDiscoveryAdapter(),
]

// Concurrent reconnects share a scan. Entries are removed on both success and
// failure, so an errored scan never poisons subsequent discovery.
const inFlight = new WeakMap<ProjectDiscoveryAdapter[], Map<string, Promise<DiscoveredProject[]>>>()
export function discoverProjects(
  homeDir: string = homedir(),
  adapters: ProjectDiscoveryAdapter[] = DEFAULT_PROJECT_DISCOVERY_ADAPTERS
): Promise<DiscoveredProject[]> {
  let scans = inFlight.get(adapters)
  if (!scans) { scans = new Map(); inFlight.set(adapters, scans) }
  const pending = scans.get(homeDir)
  if (pending) return pending
  const result = Promise.all(adapters.map(adapter => adapter.scan(homeDir)))
    .then(results => mergeDiscoveredProjects(results.flat().map(({ provider: _provider, ...project }) => project)))
    .finally(() => scans!.delete(homeDir))
  scans.set(homeDir, result)
  return result
}
