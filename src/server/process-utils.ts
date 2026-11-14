import path from "node:path"
import { execFile, spawn, spawnSync } from "node:child_process"
import { promisify } from "node:util"

type ProcessTreeChild = {
  pid?: number
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): unknown
}

const execFileAsync = promisify(execFile)
const processTreeCleanupPromises = new WeakMap<object, Promise<void>>()
const PROCESS_TREE_TIMEOUT_MS = 5_000

function childHasExited(child: ProcessTreeChild) {
  return child.exitCode != null || child.signalCode != null
}

/**
 * Best-effort cleanup of active descendants owned by this child. Already
 * daemonized or reparented processes are out of scope; this is not containment.
 */
async function cleanupProcessTree(child: ProcessTreeChild): Promise<void> {
  if (childHasExited(child)) return

  const pid = child.pid
  if (pid === undefined) {
    try { child.kill("SIGKILL") } catch { /* Already exited. */ }
    return
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return

  if (process.platform === "win32") {
    try {
      await execFileAsync(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
      )
    } catch (error) {
      console.warn("Subprocess tree cleanup failed:", error)
    } finally {
      if (!childHasExited(child)) {
        try { child.kill("SIGKILL") } catch { /* Already exited. */ }
      }
    }
    return
  }

  let rootFrozen: unknown
  try {
    rootFrozen = child.kill("SIGSTOP")
  } catch (error) {
    console.warn("Subprocess tree cleanup failed:", error)
    return
  }
  if (rootFrozen === false) return

  const stopped = new Set<number>([pid])
  const deadline = Date.now() + PROCESS_TREE_TIMEOUT_MS
  try {
    let discovered = true
    while (discovered) {
      if (Date.now() >= deadline) throw new Error("Subprocess ancestry scan timed out")
      discovered = false
      const result = await execFileAsync("/bin/ps", ["-axo", "pid=", "-o", "ppid="], {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
      if (childHasExited(child)) break
      if (Date.now() >= deadline) throw new Error("Subprocess ancestry scan timed out")
      for (const line of String(result.stdout).split("\n")) {
        if (childHasExited(child)) break
        if (Date.now() >= deadline) throw new Error("Subprocess ancestry scan timed out")
        const [descendant, parent] = line.trim().split(/\s+/).map(Number)
        if (!descendant || descendant <= 1 || descendant === process.pid || !parent || !stopped.has(parent) || stopped.has(descendant)) continue
        let frozen = false
        try {
          frozen = process.kill(descendant, "SIGSTOP")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
        if (!frozen) continue
        stopped.add(descendant)
        discovered = true
      }
    }
  } catch (error) {
    console.warn("Subprocess tree cleanup failed:", error)
  } finally {
    for (const descendant of [...stopped].reverse()) {
      if (descendant === pid) continue
      try { process.kill(descendant, "SIGKILL") } catch { /* Already exited. */ }
    }
    if (!childHasExited(child)) {
      try { child.kill("SIGKILL") } catch { /* Already exited. */ }
    }
  }
}

export function killProcessTree(child: ProcessTreeChild): Promise<void> {
  const existing = processTreeCleanupPromises.get(child)
  if (existing) return existing

  let resolveCleanup!: () => void
  const cleanup = new Promise<void>((resolve) => {
    resolveCleanup = resolve
  })
  processTreeCleanupPromises.set(child, cleanup)
  cleanupProcessTree(child).then(resolveCleanup, (error) => {
    console.warn("Subprocess tree cleanup failed:", error)
    resolveCleanup()
  })
  return cleanup
}

function formatSpawnError(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(`Failed to start ${command}`)
  }

  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  if (code === "ENOENT") {
    return new Error(`Command not found: ${command}`)
  }

  return new Error(error.message || `Failed to start ${command}`)
}

export function spawnDetached(command: string, args: string[], options: { cwd?: string } = {}) {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { ...options, stdio: "ignore", detached: true })
    } catch (error) {
      reject(formatSpawnError(command, error))
      return
    }

    const handleError = (error: Error) => {
      reject(formatSpawnError(command, error))
    }

    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resolve()
    })
  })
}

export function hasCommand(command: string) {
  // Bun.which otherwise reads the startup PATH, before inheritShellPath.
  if (Bun.which(command, { PATH: process.env.PATH ?? "" })) return true
  if (process.platform === "win32") return false
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

const SHELL_PATH_MARKER = "__MEMOSYNC_SHELL_PATH__"
const SHELL_PATH_TIMEOUT_MS = 5_000

/**
 * `current` in its own order, then every `shell` entry it lacks. Appending
 * rather than replacing means a command the server already found keeps
 * resolving to the same binary (e.g. `bun run dev`'s node_modules/.bin).
 */
export function mergePathLists(current: string, shell: string) {
  const entries = [...current.split(path.delimiter), ...shell.split(path.delimiter)]
  return [...new Set(entries.filter(Boolean))].join(path.delimiter)
}

/** The PATH between the two markers, ignoring whatever the rc files print. */
export function parseShellPathOutput(output: string) {
  const parts = output.split(SHELL_PATH_MARKER)
  if (parts.length < 3) return null
  return parts[1]?.trim() || null
}

/**
 * Add the user's interactive login shell PATH to this process's PATH.
 *
 * Agents inherit `process.env` whole, and a server started by launchd, a
 * detached `memosync`, or the desktop app gets a PATH that skips ~/.zshrc, where
 * installers like to put ~/.local/bin. Skills then fail with "command not
 * found" for CLIs that work in the user's terminal. `hasCommand`
 * covers the few binaries MemoSync runs itself; this covers what agents run.
 *
 * `-i` is what reads ~/.zshrc. `printenv` rather than `$PATH` so fish, which
 * joins list variables with spaces, prints the same thing.
 */
export async function inheritShellPath(options: { shell?: string; timeoutMs?: number } = {}) {
  if (process.platform === "win32") return
  const shell = options.shell || process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  const script = `echo ${SHELL_PATH_MARKER}; printenv PATH; echo ${SHELL_PATH_MARKER}`
  const output = await new Promise<string>((resolve) => {
    let stdout = ""
    let child
    try {
      child = spawn(shell, ["-ilc", script], {
        stdio: ["ignore", "pipe", "ignore"],
        // oh-my-zsh otherwise asks whether to update, and nobody can answer.
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      })
    } catch {
      resolve("")
      return
    }
    // A slow or hung rc file must not stall boot.
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      child.stdout.destroy()
      resolve("")
    }, options.timeoutMs ?? SHELL_PATH_TIMEOUT_MS)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.once("error", () => { clearTimeout(timer); resolve("") })
    child.once("close", () => { clearTimeout(timer); resolve(stdout) })
  })
  const shellPath = parseShellPathOutput(output)
  if (!shellPath) return
  process.env.PATH = mergePathLists(process.env.PATH ?? "", shellPath)
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}
