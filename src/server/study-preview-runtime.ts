import { spawn } from "node:child_process"
import { readdir, readFile, readlink } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import { isDescendantPid, isPathWithin, listListeningTcpEntries } from "./local-http-servers"
import { studyProjectSubprocessEnv } from "./study-project-runtime"
import { parseStudyProjects } from "./study-projects"

export const STUDY_PREVIEW_FRONTEND_PORT = 3000
export const STUDY_PREVIEW_BACKEND_PORT = 3001

export type StudyPreviewPhase = "stopped" | "starting" | "ready" | "degraded" | "stopping"
export type StudyPreviewDegradedReason =
  | "process_exited"
  | "process_group_missing"
  | "startup_timeout"
  | "ports_lost"
  | "stop_failed"

export interface StudyPreviewSnapshot {
  projectPath: string | null
  phase: StudyPreviewPhase
  pid: number | null
  frontendPort: number
  backendPort: number
  readyPorts: number[]
  exitCode: number | null
  degradedReason: StudyPreviewDegradedReason | null
  /** Bounded recent child output, available to the agent through preview_status. */
  recentLog: string
  lastError: string | null
}

export interface StudyPreviewRuntimeController {
  ensure(projectPath: string): Promise<StudyPreviewSnapshot>
  status(projectPath?: string): Promise<StudyPreviewSnapshot>
  restart(projectPath: string): Promise<StudyPreviewSnapshot>
  recover(projectPath: string, isStillAllowed: () => boolean): Promise<StudyPreviewSnapshot>
  stop(projectPath?: string): Promise<StudyPreviewSnapshot>
}

interface PreviewProcess {
  pid: number
  exited: Promise<number | null>
  recentLog?: () => string
}

export interface StudyPreviewProcessInfo {
  pid: number
  parentPid: number
  processGroupId: number
  command: string
  commandLine: string
  cwd?: string
}

interface StudyPreviewRuntimeDeps {
  spawnPreview?: (projectPath: string) => PreviewProcess
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void
  listListeningEntries?: typeof listListeningTcpEntries
  listProcessGroupMembers?: (processGroupId: number) => Promise<Set<number>>
  listProcesses?: () => Promise<StudyPreviewProcessInfo[]>
  rawStudyProjects?: string
  sleep?: (milliseconds: number) => Promise<void>
  stopGraceMs?: number
  startupGraceMs?: number
  restartCooldownMs?: number
  now?: () => number
}

interface ManagedPreview {
  projectPath: string
  process: PreviewProcess
  phase: Exclude<StudyPreviewPhase, "stopped">
  exitCode: number | null
  startedAt: number
  lastError: string | null
  everReady: boolean
}

function missingProcess(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH")
}

async function defaultListProcessGroupMembers(processGroupId: number): Promise<Set<number>> {
  const members = new Set<number>()
  let entries
  try {
    entries = await readdir("/proc", { withFileTypes: true })
  } catch {
    return members
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => {
      try {
        // /proc/PID/stat's command may contain spaces. Fields after the last
        // ')' begin with state, ppid, then pgrp (the detached child PID).
        const stat = await readFile(`/proc/${entry.name}/stat`, "utf8")
        const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
        if (tail[0] !== "Z" && Number(tail[2]) === processGroupId) members.add(Number(entry.name))
      } catch {
        // The process may exit while /proc is being scanned.
      }
    }))
  return members
}

async function defaultListProcesses(): Promise<StudyPreviewProcessInfo[]> {
  let entries
  try {
    entries = await readdir("/proc", { withFileTypes: true })
  } catch {
    return []
  }
  return (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry): Promise<StudyPreviewProcessInfo | null> => {
      const pid = Number(entry.name)
      try {
        const [stat, command, commandLine, cwd] = await Promise.all([
          readFile(`/proc/${pid}/stat`, "utf8"),
          readFile(`/proc/${pid}/comm`, "utf8").catch(() => "process"),
          readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
          readlink(`/proc/${pid}/cwd`).catch(() => undefined),
        ])
        const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
        if (tail[0] === "Z") return null
        return {
          pid,
          parentPid: Number(tail[1]),
          processGroupId: Number(tail[2]),
          command: command.trim() || "process",
          commandLine: commandLine.replaceAll("\0", " ").trim(),
          cwd,
        }
      } catch {
        return null
      }
    }))).filter((entry): entry is StudyPreviewProcessInfo => entry !== null)
}

export function studyPreviewSubprocessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  projectPath: string,
  rawStudyProjects: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...studyProjectSubprocessEnv(baseEnv, projectPath, rawStudyProjects),
    // Nest reads PORT while Next receives its own explicit CLI port below.
    PORT: String(STUDY_PREVIEW_BACKEND_PORT),
    // The canonical starter uses Next/Watchpack and Nest/TypeScript watch.
    // Polling avoids consuming thousands of inotify watches per participant
    // while keeping the same managed path in all three study conditions.
    WATCHPACK_POLLING: "true",
    WATCHPACK_POLLING_INTERVAL: "1000",
    TSC_WATCHFILE: "DynamicPriorityPolling",
    TSC_WATCHDIRECTORY: "RecursiveDirectoryUsingDynamicPriorityPolling",
    CHOKIDAR_USEPOLLING: "true",
    CHOKIDAR_INTERVAL: "1000",
  } as NodeJS.ProcessEnv
}

export function studyPreviewLaunchSpec(
  projectPath: string,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
  rawStudyProjects: string | undefined = process.env.STUDY_PROJECTS,
) {
  const target = resolve(projectPath)
  return {
    command: resolve(target, "node_modules/.bin/concurrently"),
    args: [
      "--kill-others",
      "--names", "backend,frontend",
      "npm --prefix backend run start:dev",
      // Next 15 uses webpack unless --turbopack is supplied. Invoke Next
      // directly from the frontend directory so the starter's Turbopack
      // package script cannot override it and Next resolves the app root there.
      `cd frontend && exec ./node_modules/.bin/next dev --port ${STUDY_PREVIEW_FRONTEND_PORT}`,
    ],
    cwd: target,
    detached: true as const,
    env: studyPreviewSubprocessEnv(baseEnv, target, rawStudyProjects),
  }
}

function defaultSpawnPreview(projectPath: string): PreviewProcess {
  let recentLog = ""
  const spec = studyPreviewLaunchSpec(projectPath)
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: spec.detached,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (typeof child.pid !== "number") throw new Error(`Could not start the study preview for ${projectPath}`)
  child.unref()
  const capture = (chunk: Buffer, target: NodeJS.WriteStream) => {
    target.write(chunk)
    recentLog = `${recentLog}${chunk.toString("utf8")}`.slice(-16_384)
  }
  child.stdout?.on("data", (chunk: Buffer) => capture(chunk, process.stdout))
  child.stderr?.on("data", (chunk: Buffer) => capture(chunk, process.stderr))
  return {
    pid: child.pid,
    exited: new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => resolveExit(code))
      child.once("error", () => resolveExit(1))
    }),
    recentLog: () => recentLog,
  }
}

/** Owns exactly one fixed-port study preview process group per participant container. */
export class StudyPreviewRuntime implements StudyPreviewRuntimeController {
  private readonly spawnPreview: NonNullable<StudyPreviewRuntimeDeps["spawnPreview"]>
  private readonly signalProcessGroup: NonNullable<StudyPreviewRuntimeDeps["signalProcessGroup"]>
  private readonly signalProcess: NonNullable<StudyPreviewRuntimeDeps["signalProcess"]>
  private readonly listListeningEntries: NonNullable<StudyPreviewRuntimeDeps["listListeningEntries"]>
  private readonly listProcessGroupMembers: NonNullable<StudyPreviewRuntimeDeps["listProcessGroupMembers"]>
  private readonly listProcesses: NonNullable<StudyPreviewRuntimeDeps["listProcesses"]>
  private readonly assignedProjectPaths: string[]
  private readonly sleep: NonNullable<StudyPreviewRuntimeDeps["sleep"]>
  private readonly stopGraceMs: number
  private readonly startupGraceMs: number
  private readonly restartCooldownMs: number
  private readonly now: () => number
  private current: ManagedPreview | null = null
  /** Set synchronously by stop so a queued Browser heal cannot resurrect a frozen project. */
  private readonly autoHealBlocked = new Set<string>()
  /** At most one automatic respawn until that project reaches ready again. */
  private readonly autoRecoveryAttempted = new Set<string>()
  private readonly lastManualRestartAt = new Map<string, number>()
  private transition: Promise<StudyPreviewSnapshot> = Promise.resolve(this.stoppedSnapshot())

  constructor(deps: StudyPreviewRuntimeDeps = {}) {
    this.spawnPreview = deps.spawnPreview ?? defaultSpawnPreview
    this.signalProcessGroup = deps.signalProcessGroup ?? ((pid, signal) => process.kill(-pid, signal))
    this.signalProcess = deps.signalProcess ?? ((pid, signal) => process.kill(pid, signal))
    this.listListeningEntries = deps.listListeningEntries ?? listListeningTcpEntries
    this.listProcessGroupMembers = deps.listProcessGroupMembers ?? defaultListProcessGroupMembers
    this.listProcesses = deps.listProcesses ?? defaultListProcesses
    this.assignedProjectPaths = parseStudyProjects(deps.rawStudyProjects ?? process.env.STUDY_PROJECTS)
      .map((project) => resolve(project.localPath))
    this.sleep = deps.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)))
    this.stopGraceMs = deps.stopGraceMs ?? 3_000
    this.startupGraceMs = deps.startupGraceMs ?? 30_000
    this.restartCooldownMs = deps.restartCooldownMs ?? 30_000
    this.now = deps.now ?? Date.now
  }

  ensure(projectPath: string) {
    const target = resolve(projectPath)
    this.autoHealBlocked.delete(target)
    return this.serialize(async () => {
      const current = this.current
      const replacingSameProject = current?.projectPath === target
      if (replacingSameProject) {
        const snapshot = await this.snapshot(current)
        if (
          snapshot.phase === "ready"
          || snapshot.phase === "starting"
          || snapshot.degradedReason === "startup_timeout"
          || snapshot.degradedReason === "ports_lost"
        ) return snapshot
        if (this.autoRecoveryAttempted.has(target)) return snapshot
        this.autoRecoveryAttempted.add(target)
        await this.stopCurrent()
      }
      if (!replacingSameProject) this.autoRecoveryAttempted.delete(target)
      if (this.current) await this.stopCurrent()
      const managed = await this.startAfterPortReconciliation(target)
      return this.snapshot(managed)
    })
  }

  status(projectPath?: string) {
    return this.serialize(async () => {
      if (!this.current) return this.stoppedSnapshot(projectPath ? resolve(projectPath) : null)
      if (projectPath && this.current.projectPath !== resolve(projectPath)) {
        return this.stoppedSnapshot(resolve(projectPath))
      }
      return this.snapshot(this.current)
    })
  }

  restart(projectPath: string) {
    const target = resolve(projectPath)
    return this.serialize(async () => {
      if (!this.current || this.current.projectPath !== target) {
        throw new Error("The managed preview is not running for this project")
      }
      const snapshot = await this.snapshot(this.current)
      if (snapshot.phase !== "degraded") {
        throw new Error(`The managed preview is ${snapshot.phase}; restart is only available when degraded`)
      }
      const previousRestart = this.lastManualRestartAt.get(target)
      if (previousRestart !== undefined && this.now() - previousRestart < this.restartCooldownMs) {
        throw new Error("The managed preview was restarted recently; inspect preview_status before retrying")
      }
      this.lastManualRestartAt.set(target, this.now())
      await this.stopCurrent()
      if (this.autoHealBlocked.has(target)) return this.stoppedSnapshot(target)
      const managed = await this.startAfterPortReconciliation(target)
      return this.snapshot(managed)
    })
  }

  /** Browser-only recovery. The admission check and restart share the runtime transition. */
  recover(projectPath: string, isStillAllowed: () => boolean) {
    const target = resolve(projectPath)
    return this.serialize(async () => {
      if (this.autoHealBlocked.has(target) || !isStillAllowed()) {
        return this.current?.projectPath === target ? this.snapshot(this.current) : this.stoppedSnapshot(target)
      }
      if (!this.current || this.current.projectPath !== target) return this.stoppedSnapshot(target)
      const snapshot = await this.snapshot(this.current)
      if (
        snapshot.degradedReason !== "process_exited"
        && snapshot.degradedReason !== "process_group_missing"
      ) return snapshot
      if (this.autoRecoveryAttempted.has(target)) return snapshot
      this.autoRecoveryAttempted.add(target)
      await this.stopCurrent()
      // stop() marks the project synchronously before its serialized work. A
      // freeze racing this await therefore wins even if its transition queues
      // behind this one.
      if (this.autoHealBlocked.has(target) || !isStillAllowed()) return this.stoppedSnapshot(target)
      return this.snapshot(await this.startAfterPortReconciliation(target))
    })
  }

  stop(projectPath?: string) {
    const target = projectPath ? resolve(projectPath) : this.current?.projectPath
    if (target) this.autoHealBlocked.add(target)
    return this.serialize(async () => {
      if (!this.current) return this.stoppedSnapshot(projectPath ? resolve(projectPath) : null)
      if (projectPath && this.current.projectPath !== resolve(projectPath)) return this.snapshot(this.current)
      const stoppedPath = this.current.projectPath
      await this.stopCurrent()
      return this.stoppedSnapshot(stoppedPath)
    })
  }

  private serialize(operation: () => Promise<StudyPreviewSnapshot>) {
    const next = this.transition.then(operation, operation)
    this.transition = next.catch(() => this.stoppedSnapshot())
    return next
  }

  private async stopCurrent() {
    const managed = this.current
    if (!managed) return
    managed.phase = "stopping"
    await this.signalManagedProcessGroup(managed.process.pid, "SIGTERM")
    const exited = await this.waitForProcessGroupExit(managed.process.pid, this.stopGraceMs)
    if (!exited) {
      await this.signalManagedProcessGroup(managed.process.pid, "SIGKILL")
      const killed = await this.waitForProcessGroupExit(managed.process.pid, 500)
      if (!killed) {
        managed.phase = "degraded"
        managed.lastError = `Preview process group ${managed.process.pid} survived SIGKILL`
        throw new Error(managed.lastError)
      }
    }
    if (this.current === managed) this.current = null
  }

  private startManaged(projectPath: string) {
    const managed: ManagedPreview = {
      projectPath,
      process: this.spawnPreview(projectPath),
      phase: "starting",
      exitCode: null,
      startedAt: this.now(),
      lastError: null,
      everReady: false,
    }
    this.current = managed
    void managed.process.exited.then((exitCode) => {
      managed.exitCode = exitCode
      if (this.current === managed && managed.phase !== "stopping") managed.phase = "degraded"
    })
    return managed
  }

  private async startAfterPortReconciliation(projectPath: string) {
    await this.reconcileFixedPorts(projectPath)
    return this.startManaged(projectPath)
  }

  private async waitForProcessGroupExit(processGroupId: number, timeoutMs: number) {
    const intervalMs = 100
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((await this.previewProcessGroupMembers(processGroupId)).size === 0) return true
      await this.sleep(Math.min(intervalMs, timeoutMs))
    }
    return (await this.previewProcessGroupMembers(processGroupId)).size === 0
  }

  private async previewProcessGroupMembers(processGroupId: number) {
    const members = new Set(await this.listProcessGroupMembers(processGroupId))
    members.delete(1)
    members.delete(process.pid)
    return members
  }

  private async signalManagedProcessGroup(pid: number, signal: NodeJS.Signals) {
    const members = await this.listProcessGroupMembers(pid)
    if (!members.has(1) && !members.has(process.pid)) {
      this.signal(pid, signal)
      return
    }
    for (const member of members) {
      if (member !== 1 && member !== process.pid) this.signalOne(member, signal)
    }
  }

  private signal(pid: number, signal: NodeJS.Signals) {
    try {
      this.signalProcessGroup(pid, signal)
    } catch (error) {
      if (!missingProcess(error)) throw error
    }
  }

  private signalOne(pid: number, signal: NodeJS.Signals) {
    try {
      this.signalProcess(pid, signal)
    } catch (error) {
      if (!missingProcess(error)) throw error
    }
  }

  private fixedPortEntries(entries: Awaited<ReturnType<typeof listListeningTcpEntries>>) {
    return entries.filter((entry) => (
      entry.port === STUDY_PREVIEW_FRONTEND_PORT || entry.port === STUDY_PREVIEW_BACKEND_PORT
    ))
  }

  private isPreviewLauncher(processInfo: StudyPreviewProcessInfo) {
    const text = `${processInfo.command} ${processInfo.commandLine}`
    return /next-server|\bnext\s+dev\b|\bconcurrently\b|\bnest\s+start\b|\btsc\b.*(?:--watch|-w)\b|\bnpm\b.*\b(?:run|exec)\b.*\b(?:dev|start:dev|next)\b|\/backend\/(?:dist\/)?main(?:\.js)?\b/i.test(text)
  }

  private async foreignPreviewCleanupPlan(target: string) {
    const entries = this.fixedPortEntries(await this.listListeningEntries())
    if (entries.length === 0) return { entries, pids: new Set<number>() }
    const processes = await this.listProcesses()
    const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]))
    const parentByPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo.parentPid]))
    const allowedProjectPaths = [...new Set([...this.assignedProjectPaths, target])]
    const roots = new Set<number>()

    for (const owner of entries.flatMap((entry) => entry.owners)) {
      if (owner.pid === 1 || owner.pid === process.pid) {
        throw new Error(`Refusing to stop protected process ${owner.pid} on study preview port`)
      }
      const processInfo = byPid.get(owner.pid)
      const projectPath = allowedProjectPaths.find((candidate) => isPathWithin(candidate, processInfo?.cwd))
      if (!processInfo || !projectPath || !this.isPreviewLauncher(processInfo)) {
        throw new Error(`Refusing to stop unrecognized process ${owner.pid} on study preview port`)
      }
      let root = processInfo
      while (root.parentPid !== 1 && root.parentPid !== process.pid) {
        const parent = byPid.get(root.parentPid)
        if (!parent || !isPathWithin(projectPath, parent.cwd) || !this.isPreviewLauncher(parent)) break
        root = parent
      }
      roots.add(root.pid)
    }

    const pids = new Set<number>()
    for (const processInfo of processes) {
      if (processInfo.pid === 1 || processInfo.pid === process.pid) continue
      if (isDescendantPid(processInfo.pid, roots, parentByPid)) pids.add(processInfo.pid)
    }
    return { entries, pids }
  }

  private async cleanupFinished(pids: Set<number>) {
    const [entries, processes] = await Promise.all([this.listListeningEntries(), this.listProcesses()])
    const livePids = new Set(processes.map((processInfo) => processInfo.pid))
    return this.fixedPortEntries(entries).length === 0 && [...pids].every((pid) => !livePids.has(pid))
  }

  private async waitForCleanup(pids: Set<number>, timeoutMs: number) {
    const intervalMs = 100
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.cleanupFinished(pids)) return true
      await this.sleep(Math.min(intervalMs, timeoutMs))
    }
    return this.cleanupFinished(pids)
  }

  private async reconcileFixedPorts(target: string) {
    const initial = await this.foreignPreviewCleanupPlan(target)
    if (initial.entries.length === 0) return
    for (const pid of initial.pids) this.signalOne(pid, "SIGTERM")
    if (await this.waitForCleanup(initial.pids, this.stopGraceMs)) return

    const remaining = await this.foreignPreviewCleanupPlan(target)
    const killPids = new Set([...initial.pids, ...remaining.pids])
    for (const pid of killPids) this.signalOne(pid, "SIGKILL")
    if (await this.waitForCleanup(killPids, 500)) return
    const ports = this.fixedPortEntries(await this.listListeningEntries()).map((entry) => entry.port)
    throw new Error(`Could not clear study preview port(s): ${[...new Set(ports)].sort().join(", ")}`)
  }

  private async snapshot(managed: ManagedPreview): Promise<StudyPreviewSnapshot> {
    const [entries, processGroupMembers] = await Promise.all([
      this.listListeningEntries(),
      this.previewProcessGroupMembers(managed.process.pid),
    ])
    const readyPorts = entries
      .filter((entry) => (
        (entry.port === STUDY_PREVIEW_FRONTEND_PORT || entry.port === STUDY_PREVIEW_BACKEND_PORT)
        && entry.owners.some((owner) => processGroupMembers.has(owner.pid))
      ))
      .map((entry) => entry.port)
    let degradedReason: StudyPreviewDegradedReason | null = null
    if (managed.lastError?.includes("survived SIGKILL")) {
      managed.phase = "degraded"
      degradedReason = "stop_failed"
    } else if (managed.exitCode !== null) {
      managed.phase = "degraded"
      degradedReason = "process_exited"
    } else if (processGroupMembers.size === 0) {
      managed.phase = "degraded"
      degradedReason = "process_group_missing"
    } else if (readyPorts.includes(STUDY_PREVIEW_FRONTEND_PORT) && readyPorts.includes(STUDY_PREVIEW_BACKEND_PORT)) {
      managed.phase = "ready"
      managed.everReady = true
      this.autoRecoveryAttempted.delete(managed.projectPath)
    } else if (managed.phase !== "stopping") {
      managed.phase = this.now() - managed.startedAt < this.startupGraceMs ? "starting" : "degraded"
      if (managed.phase === "degraded") degradedReason = managed.everReady ? "ports_lost" : "startup_timeout"
    }
    const recentLog = managed.process.recentLog?.() ?? ""
    const missingPorts = [STUDY_PREVIEW_FRONTEND_PORT, STUDY_PREVIEW_BACKEND_PORT]
      .filter((port) => !readyPorts.includes(port))
    return {
      projectPath: managed.projectPath,
      phase: managed.phase,
      pid: managed.process.pid,
      frontendPort: STUDY_PREVIEW_FRONTEND_PORT,
      backendPort: STUDY_PREVIEW_BACKEND_PORT,
      readyPorts: [...new Set(readyPorts)].sort((left, right) => left - right),
      exitCode: managed.exitCode,
      degradedReason,
      recentLog,
      lastError: managed.lastError ?? (managed.exitCode !== null
        ? `Preview process exited with code ${managed.exitCode}`
        : processGroupMembers.size === 0
          ? `Preview process group ${managed.process.pid} is no longer running`
        : managed.phase === "degraded"
          ? `Preview did not bind required port(s): ${missingPorts.join(", ")}`
          : null),
    }
  }

  private stoppedSnapshot(projectPath: string | null = null): StudyPreviewSnapshot {
    return {
      projectPath,
      phase: "stopped",
      pid: null,
      frontendPort: STUDY_PREVIEW_FRONTEND_PORT,
      backendPort: STUDY_PREVIEW_BACKEND_PORT,
      readyPorts: [],
      exitCode: null,
      degradedReason: null,
      recentLog: "",
      lastError: null,
    }
  }
}
