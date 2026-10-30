import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

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

export function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true })
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
