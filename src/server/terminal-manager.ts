import path from "node:path"
import process from "node:process"
import { existsSync } from "node:fs"
import defaultShell, { detectDefaultShell } from "default-shell"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import type { TerminalEvent, TerminalSnapshot } from "../shared/protocol"
import { studyProjectSubprocessEnv } from "./study-project-runtime"

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_SCROLLBACK = 1_000
const MIN_SCROLLBACK = 500
const MAX_SCROLLBACK = 5_000
const FOCUS_IN_SEQUENCE = "\x1b[I"
const FOCUS_OUT_SEQUENCE = "\x1b[O"
const MODE_SEQUENCE_TAIL_LENGTH = 16

interface CreateTerminalArgs {
  projectPath: string
  terminalId: string
  cols: number
  rows: number
  scrollback: number
}

interface TerminalSession {
  terminalId: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  scrollback: number
  status: "running" | "exited"
  exitCode: number | null
  process: Bun.Subprocess | null
  terminal: Bun.Terminal
  headless: Terminal
  serializeAddon: SerializeAddon
  focusReportingEnabled: boolean
  modeSequenceTail: string
}

function clampScrollback(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_SCROLLBACK
  return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(value)))
}

function normalizeTerminalDimension(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

/**
 * Pick the first usable shell from an ordered candidate list. `detectDefaultShell()`
 * can return the sentinel string `"unknown"` (e.g. in a Docker container with no
 * SHELL env and no passwd entry) — which is NOT a throw, so the old try/catch
 * fallback never fired and the terminal tried to spawn `"unknown"`
 * ("Executable not found in $PATH"). This filters that out: skip empty /
 * "unknown", and require absolute paths to actually exist.
 */
export function pickUsableShell(candidates: Array<string | null | undefined>, exists: (p: string) => boolean): string | null {
  for (const candidate of candidates) {
    const shell = typeof candidate === "string" ? candidate.trim() : ""
    if (!shell || shell === "unknown") continue
    if (path.isAbsolute(shell) && !exists(shell)) continue
    return shell
  }
  return null
}

function resolveShell(): string {
  let detected: string | null = null
  try {
    detected = detectDefaultShell()
  } catch {
    /* detection failed — fall through to the ordered fallbacks */
  }
  const candidates = [
    detected,
    defaultShell,
    process.env.SHELL,
    process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : null,
    "/bin/bash",
    "/bin/sh",
  ]
  return pickUsableShell(candidates, existsSync) ?? "/bin/sh"
}

function resolveShellArgs(shellPath: string) {
  if (process.platform === "win32") {
    return []
  }

  const shellName = path.basename(shellPath)
  if (["bash", "zsh", "fish", "sh", "ksh"].includes(shellName)) {
    return ["-l"]
  }

  return []
}

function createTerminalEnv(projectPath: string) {
  return studyProjectSubprocessEnv({
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }, projectPath, process.env.STUDY_PROJECTS)
}

function updateFocusReportingState(session: Pick<TerminalSession, "focusReportingEnabled" | "modeSequenceTail">, chunk: string) {
  const combined = session.modeSequenceTail + chunk
  const regex = /\x1b\[\?1004([hl])/g

  for (const match of combined.matchAll(regex)) {
    session.focusReportingEnabled = match[1] === "h"
  }

  session.modeSequenceTail = combined.slice(-MODE_SEQUENCE_TAIL_LENGTH)
}

function filterFocusReportInput(data: string, allowFocusReporting: boolean) {
  if (allowFocusReporting) {
    return data
  }

  return data.replaceAll(FOCUS_IN_SEQUENCE, "").replaceAll(FOCUS_OUT_SEQUENCE, "")
}

function killTerminalProcessTree(subprocess: Bun.Subprocess | null) {
  if (!subprocess) return

  const pid = subprocess.pid
  if (typeof pid !== "number") return

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL")
      return
    } catch {
      // Fall back to killing only the shell process if group termination fails.
    }
  }

  try {
    subprocess.kill("SIGKILL")
  } catch {
    // Ignore subprocess shutdown errors during disposal.
  }
}

function signalTerminalProcessGroup(subprocess: Bun.Subprocess | null, signal: NodeJS.Signals) {
  if (!subprocess) return false

  const pid = subprocess.pid
  if (typeof pid !== "number") return false

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // Fall back to signaling only the shell if group signaling fails.
    }
  }

  try {
    subprocess.kill(signal)
    return true
  } catch {
    return false
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly listeners = new Set<(event: TerminalEvent) => void>()

  onEvent(listener: (event: TerminalEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  createTerminal(args: CreateTerminalArgs) {
    if (process.platform === "win32") {
      throw new Error("Embedded terminal is currently supported on macOS/Linux only.")
    }
    if (typeof Bun.Terminal !== "function") {
      throw new Error("Embedded terminal requires Bun 1.3.5+ with Bun.Terminal support.")
    }

    const existing = this.sessions.get(args.terminalId)
    if (existing) {
      existing.scrollback = clampScrollback(args.scrollback)
      existing.cols = normalizeTerminalDimension(args.cols, existing.cols)
      existing.rows = normalizeTerminalDimension(args.rows, existing.rows)
      existing.headless.options.scrollback = existing.scrollback
      existing.headless.resize(existing.cols, existing.rows)
      existing.terminal.resize(existing.cols, existing.rows)
      signalTerminalProcessGroup(existing.process, "SIGWINCH")
      return this.snapshotOf(existing)
    }

    const shell = resolveShell()
    const cols = normalizeTerminalDimension(args.cols, DEFAULT_COLS)
    const rows = normalizeTerminalDimension(args.rows, DEFAULT_ROWS)
    const scrollback = clampScrollback(args.scrollback)
    const title = path.basename(shell) || "shell"
    const headless = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    const serializeAddon = new SerializeAddon()
    headless.loadAddon(serializeAddon)

    const session: TerminalSession = {
      terminalId: args.terminalId,
      title,
      cwd: args.projectPath,
      shell,
      cols,
      rows,
      scrollback,
      status: "running",
      exitCode: null,
      process: null,
      terminal: new Bun.Terminal({
        cols,
        rows,
        name: "xterm-256color",
        data: (_terminal, data) => {
          const chunk = Buffer.from(data).toString("utf8")
          updateFocusReportingState(session, chunk)
          headless.write(chunk)
          this.emit({
            type: "terminal.output",
            terminalId: args.terminalId,
            data: chunk,
          })
        },
      }),
      headless,
      serializeAddon,
      focusReportingEnabled: false,
      modeSequenceTail: "",
    }

    try {
      session.process = Bun.spawn([shell, ...resolveShellArgs(shell)], {
        cwd: args.projectPath,
        env: createTerminalEnv(args.projectPath),
        terminal: session.terminal,
      })
    } catch (error) {
      session.terminal.close()
      session.serializeAddon.dispose()
      session.headless.dispose()
      throw error
    }
    void session.process.exited.then((exitCode) => {
      const active = this.sessions.get(args.terminalId)
      if (!active) return
      active.status = "exited"
      active.exitCode = exitCode
      this.emit({
        type: "terminal.exit",
        terminalId: args.terminalId,
        exitCode,
      })
    }).catch((error) => {
      const active = this.sessions.get(args.terminalId)
      if (!active) return
      active.status = "exited"
      active.exitCode = 1
      this.emit({
        type: "terminal.output",
        terminalId: args.terminalId,
        data: `\r\n[terminal error] ${error instanceof Error ? error.message : String(error)}\r\n`,
      })
      this.emit({
        type: "terminal.exit",
        terminalId: args.terminalId,
        exitCode: 1,
      })
    })

    this.sessions.set(args.terminalId, session)
    return this.snapshotOf(session)
  }

  getSnapshot(terminalId: string): TerminalSnapshot | null {
    const session = this.sessions.get(terminalId)
    return session ? this.snapshotOf(session) : null
  }

  write(terminalId: string, data: string) {
    const session = this.sessions.get(terminalId)
    if (!session || session.status === "exited") return

    const filteredData = filterFocusReportInput(data, session.focusReportingEnabled)
    if (!filteredData) return
    // Control characters belong to the PTY input stream. In particular, the
    // terminal driver turns Ctrl-C into SIGINT for the foreground process
    // group. Signaling Bun's shell subprocess directly breaks in containers
    // where the shell PID is not the foreground process-group id.
    session.terminal.write(filteredData)
  }

  resize(terminalId: string, cols: number, rows: number) {
    const session = this.sessions.get(terminalId)
    if (!session) return
    session.cols = normalizeTerminalDimension(cols, session.cols)
    session.rows = normalizeTerminalDimension(rows, session.rows)
    session.headless.resize(session.cols, session.rows)
    session.terminal.resize(session.cols, session.rows)
    signalTerminalProcessGroup(session.process, "SIGWINCH")
  }

  close(terminalId: string) {
    const session = this.sessions.get(terminalId)
    if (!session) return

    this.sessions.delete(terminalId)
    killTerminalProcessTree(session.process)
    session.terminal.close()
    session.serializeAddon.dispose()
    session.headless.dispose()
  }

  closeByCwd(cwd: string) {
    for (const [terminalId, session] of this.sessions.entries()) {
      if (session.cwd !== cwd) continue
      this.close(terminalId)
    }
  }

  closeAll() {
    for (const terminalId of this.sessions.keys()) {
      this.close(terminalId)
    }
  }

  getRootPidsByCwd(cwd: string) {
    const pids: number[] = []
    for (const session of this.sessions.values()) {
      if (session.cwd !== cwd || session.status !== "running") continue
      const pid = session.process?.pid
      if (typeof pid === "number") {
        pids.push(pid)
      }
    }
    return pids
  }

  private snapshotOf(session: TerminalSession): TerminalSnapshot {
    return {
      terminalId: session.terminalId,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      scrollback: session.scrollback,
      serializedState: session.serializeAddon.serialize({ scrollback: session.scrollback }),
      status: session.status,
      exitCode: session.exitCode,
    }
  }

  private emit(event: TerminalEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
