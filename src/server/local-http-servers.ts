import { execFile } from "node:child_process"
import { readdir, readFile, readlink } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
// Cold Next/Turbopack listeners often accept TCP before the first page compile
// can answer. Keep a bounded but realistic probe; failed probes are not put in
// the long-lived positive cache, so the next Browser poll can observe readiness.
const LOCAL_HTTP_SCAN_TIMEOUT_MS = 2_000
const LOCAL_HTTP_CACHE_TTL_MS = 30_000

interface LocalHttpServerCacheEntry {
  signature: string
  scannedAt: number
  results: LocalHttpServerInfo[]
}

const localHttpServerCache = new Map<string, LocalHttpServerCacheEntry>()

export interface LocalHttpServerInfo {
  title: string
  address: string
  port: number
  status: number
  ownerPath?: string
  processName?: string
  sameProject?: boolean
}

interface ListeningPortOwner {
  command: string
  pid: number
}

export interface ListeningPortEntry {
  port: number
  owners: ListeningPortOwner[]
}

export interface ProcListeningSocket {
  inode: string
  port: number
}

export interface ProcSocketProcess {
  pid: number
  command: string
  socketInodes: string[]
}

export function extractHtmlTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ""
  return match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function parseLsofListeningEntries(output: string) {
  const entriesByPort = new Map<number, ListeningPortEntry>()

  for (const line of output.split("\n").slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+).*TCP\s+(?:.+?):(\d+)\s+\(LISTEN\)/)
    if (!match) continue

    const command = match[1]
    const pid = Number(match[2])
    const port = Number(match[3])
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      continue
    }

    const entry = entriesByPort.get(port) ?? { port, owners: [] }
    if (!entry.owners.some((owner) => owner.pid === pid)) {
      entry.owners.push({ command, pid })
    }
    entriesByPort.set(port, entry)
  }

  return [...entriesByPort.values()].sort((a, b) => a.port - b.port)
}

export function parseLsofListeningPorts(output: string) {
  return parseLsofListeningEntries(output).map((entry) => entry.port)
}

export function parseProcNetListeningSockets(...outputs: string[]): ProcListeningSocket[] {
  const socketsByInode = new Map<string, ProcListeningSocket>()
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10 || fields[3] !== "0A") continue
      const localAddress = fields[1]
      const inode = fields[9]
      const separator = localAddress.lastIndexOf(":")
      const port = Number.parseInt(localAddress.slice(separator + 1), 16)
      if (separator < 0 || !/^\d+$/.test(inode) || !Number.isInteger(port) || port <= 0 || port > 65535) {
        continue
      }
      socketsByInode.set(inode, { inode, port })
    }
  }
  return [...socketsByInode.values()].sort((left, right) => left.port - right.port || left.inode.localeCompare(right.inode))
}

export function buildProcListeningEntries(
  sockets: ProcListeningSocket[],
  processes: ProcSocketProcess[],
): ListeningPortEntry[] {
  const entriesByPort = new Map<number, ListeningPortEntry>()
  const socketByInode = new Map(sockets.map((socket) => [socket.inode, socket]))
  for (const processInfo of processes) {
    for (const inode of new Set(processInfo.socketInodes)) {
      const socket = socketByInode.get(inode)
      if (!socket) continue
      const entry = entriesByPort.get(socket.port) ?? { port: socket.port, owners: [] }
      if (!entry.owners.some((owner) => owner.pid === processInfo.pid)) {
        entry.owners.push({ command: processInfo.command, pid: processInfo.pid })
      }
      entriesByPort.set(socket.port, entry)
    }
  }
  return [...entriesByPort.values()].sort((left, right) => left.port - right.port)
}

export function mergeListeningTcpEntries(...sources: ListeningPortEntry[][]): ListeningPortEntry[] {
  const entriesByPort = new Map<number, ListeningPortEntry>()
  for (const source of sources) {
    for (const entry of source) {
      const merged = entriesByPort.get(entry.port) ?? { port: entry.port, owners: [] }
      for (const owner of entry.owners) {
        if (!merged.owners.some((candidate) => candidate.pid === owner.pid)) merged.owners.push(owner)
      }
      entriesByPort.set(entry.port, merged)
    }
  }
  return [...entriesByPort.values()].sort((left, right) => left.port - right.port)
}

export function isPathWithin(parentPath: string | undefined, childPath: string | undefined) {
  if (!parentPath || !childPath) return false
  const normalizedParent = path.resolve(parentPath)
  const normalizedChild = path.resolve(childPath)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
}

export function isDescendantPid(pid: number, rootPids: Set<number>, parentByPid: Map<number, number>) {
  let current: number | undefined = pid
  const visited = new Set<number>()

  while (current !== undefined && current > 0 && !visited.has(current)) {
    if (rootPids.has(current)) return true
    visited.add(current)
    current = parentByPid.get(current)
  }

  return false
}

function isLikelyInternalResponder(server: LocalHttpServerInfo) {
  if (server.status < 200 || server.status >= 400) return true
  if (/^(localhost:\d+|502 Bad Gateway|Welcome to nginx!)$/i.test(server.title)) return true
  if (/^(nginx|cloudflar|workerd|agent-bro|Google|Cursor|ControlCe|figma_age|Superhuma|Spotify|redis|postgres|mysqld)/i.test(server.processName ?? "")) {
    return true
  }
  return false
}

export function filterLocalHttpServers(servers: LocalHttpServerInfo[]) {
  return servers.filter((server) => !isLikelyInternalResponder(server))
}

async function listProcListeningTcpEntries(excludedPorts: Set<number>) {
  try {
    const procNetOutputs = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(async (filePath) => {
      try {
        return await readFile(filePath, "utf8")
      } catch {
        return ""
      }
    }))
    const sockets = parseProcNetListeningSockets(...procNetOutputs)
      .filter((socket) => !excludedPorts.has(socket.port))
    if (sockets.length === 0) return []

    const desiredInodes = new Set(sockets.map((socket) => socket.inode))
    const procEntries = await readdir("/proc", { withFileTypes: true })
    const processes = (await Promise.all(procEntries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry): Promise<ProcSocketProcess | null> => {
        const pid = Number(entry.name)
        try {
          const fdNames = await readdir(`/proc/${pid}/fd`)
          const socketInodes = (await Promise.all(fdNames.map(async (fdName) => {
            try {
              const target = await readlink(`/proc/${pid}/fd/${fdName}`)
              const match = target.match(/^socket:\[(\d+)\]$/)
              return match && desiredInodes.has(match[1]) ? match[1] : null
            } catch {
              return null
            }
          }))).filter((inode): inode is string => inode !== null)
          if (socketInodes.length === 0) return null
          const command = (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "process")).trim() || "process"
          return { pid, command, socketInodes }
        } catch {
          return null
        }
      })))
      .filter((processInfo): processInfo is ProcSocketProcess => processInfo !== null)
    return buildProcListeningEntries(sockets, processes)
  } catch {
    return []
  }
}

export async function listListeningTcpEntries() {
  let lsofEntries: ListeningPortEntry[] = []
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      timeout: 1_500,
      maxBuffer: 1024 * 1024,
    })
    lsofEntries = parseLsofListeningEntries(stdout)
  } catch {
    // Linux /proc remains available when lsof is absent or incomplete.
  }
  if (process.platform !== "linux") return lsofEntries
  const procEntries = await listProcListeningTcpEntries(new Set(lsofEntries.map((entry) => entry.port)))
  return mergeListeningTcpEntries(lsofEntries, procEntries)
}

function getListeningEntriesSignature(entries: ListeningPortEntry) {
  return `${entries.port}:${entries.owners.map((owner) => `${owner.command}:${owner.pid}`).join(",")}`
}

function getListeningEntryListSignature(entries: ListeningPortEntry[]) {
  return entries.map(getListeningEntriesSignature).join("|")
}

async function findListeningTcpEntry(port: number) {
  const entries = await listListeningTcpEntries()
  return entries.find((entry) => entry.port === port)
}

export async function killLocalHttpServer(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port is invalid.")
  }

  const entry = await findListeningTcpEntry(port)
  const owner = entry?.owners[0]
  if (!owner) {
    throw new Error(`No listening process found on port ${port}.`)
  }

  try {
    process.kill(owner.pid, "SIGTERM")
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `Unable to kill process on port ${port}.`)
  }

  return {
    ok: true,
    port,
    processName: owner.command,
  }
}

export async function readProcessCwd(pid: number) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"], {
      timeout: 500,
      maxBuffer: 128 * 1024,
    })
    const cwd = stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1)
    if (cwd) return cwd
  } catch {
    // Fall through to /proc on Linux. Debian lsof can omit listeners and cwd
    // for Next's worker even though the process owns a visible socket.
  }
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`)
    } catch {
      // Process exit and permission races are normal during discovery.
    }
  }
  return undefined
}

async function readParentProcessMap() {
  const parentByPid = new Map<number, number>()
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=", "-o", "ppid="], {
      timeout: 500,
      maxBuffer: 1024 * 1024,
    })
    for (const line of stdout.split("\n")) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const ppid = Number(ppidText)
      if (Number.isInteger(pid) && Number.isInteger(ppid)) {
        parentByPid.set(pid, ppid)
      }
    }
  } catch {
    // Process ancestry is an enrichment only; discovery still works without it.
  }
  return parentByPid
}

async function readHttpServer(
  entry: ListeningPortEntry,
  args: {
    fetchImpl: typeof fetch
    ownerPath?: string
    processName?: string
    projectPath?: string
    projectTerminalRootPids: Set<number>
    parentByPid: Map<number, number>
    probeTimeoutMs: number
  }
): Promise<LocalHttpServerInfo | null> {
  const address = `http://localhost:${entry.port}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), args.probeTimeoutMs)

  try {
    const response = await args.fetchImpl(address, {
      signal: controller.signal,
      redirect: "follow",
    })
    const contentType = response.headers.get("content-type") ?? ""
    const text = await response.text().catch(() => "")
    const title = contentType.toLowerCase().includes("text/html")
      ? extractHtmlTitle(text)
      : ""
    const sameProject = isPathWithin(args.projectPath, args.ownerPath)
      || entry.owners.some((owner) => isDescendantPid(owner.pid, args.projectTerminalRootPids, args.parentByPid))

    return {
      title: title || `localhost:${entry.port}`,
      address,
      port: entry.port,
      status: response.status,
      ownerPath: args.ownerPath,
      processName: args.processName,
      sameProject,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function listLocalHttpServers(options: {
  fetchImpl?: typeof fetch
  projectPath?: string
  projectTerminalRootPids?: number[]
  /** Ports to omit — chiefly the app's own serving port, which the in-container
   * lsof scan would otherwise "discover" as a local server. */
  excludePorts?: number[]
  /** Injectable discovery boundary for deterministic cold-start regressions. */
  listEntries?: () => Promise<ListeningPortEntry[]>
  /** Test/embedding override; production uses the bounded cold-start window. */
  probeTimeoutMs?: number
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const excludePorts = new Set((options.excludePorts ?? []).filter((port) => Number.isInteger(port) && port > 0))
  const entries = (await (options.listEntries ?? listListeningTcpEntries)())
    .filter((entry) => !excludePorts.has(entry.port))
  const projectTerminalRootPids = new Set(options.projectTerminalRootPids ?? [])
  const cacheKey = `${options.projectPath ?? ""}\u0000${[...projectTerminalRootPids].sort((a, b) => a - b).join(",")}`
  const signature = getListeningEntryListSignature(entries)
  const cached = localHttpServerCache.get(cacheKey)
  if (cached && cached.signature === signature && Date.now() - cached.scannedAt < LOCAL_HTTP_CACHE_TTL_MS) {
    return cached.results
  }

  const parentByPid = await readParentProcessMap()
  const ownerCwds = new Map<number, string | undefined>()

  await Promise.all(entries.flatMap((entry) => entry.owners.map(async (owner) => {
    if (ownerCwds.has(owner.pid)) return
    ownerCwds.set(owner.pid, await readProcessCwd(owner.pid))
  })))

  const results = await Promise.all(entries.map((entry) => {
    const primaryOwner = entry.owners[0]
    const ownerPath = entry.owners.map((owner) => ownerCwds.get(owner.pid)).find(Boolean)
    return readHttpServer(entry, {
      fetchImpl,
      ownerPath,
      processName: primaryOwner?.command,
      projectPath: options.projectPath,
      projectTerminalRootPids,
      parentByPid,
      probeTimeoutMs: options.probeTimeoutMs ?? LOCAL_HTTP_SCAN_TIMEOUT_MS,
    })
  }))

  const filteredResults = filterLocalHttpServers(results
    .filter((result): result is LocalHttpServerInfo => result !== null)
  ).sort((a, b) => Number(b.sameProject) - Number(a.sameProject) || a.port - b.port)
  const scanComplete = results.every((result) => result !== null)
  if (scanComplete && filteredResults.length > 0) {
    localHttpServerCache.set(cacheKey, {
      signature,
      scannedAt: Date.now(),
      results: filteredResults,
    })
  } else {
    localHttpServerCache.delete(cacheKey)
  }

  return filteredResults
}
