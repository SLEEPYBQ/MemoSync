import { spawn } from "node:child_process"
import type { ExecutableEnvironment } from "./discovery-paths"
import type { ExecutableLauncher } from "./launcher"

interface ProbeOutput { ok: boolean; output: string; detail?: string }

/** Bounded metadata probes only: never starts an agent session or checks login. */
export function runExecutableProbe(
  launcher: ExecutableLauncher,
  args: readonly string[],
  env: ExecutableEnvironment,
  timeoutMs: number,
): Promise<ProbeOutput> {
  return new Promise(resolve => {
    let output = ""
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof spawn>
    const finish = (result: ProbeOutput) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const stop = (detail: string) => {
      // A shim may have children holding pipes open. Kill the whole probe group.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { child.kill("SIGKILL") }
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish({ ok: false, output: "", detail })
    }
    try {
      child = spawn(launcher.command, [...launcher.args, ...args], {
        env, stdio: ["ignore", "pipe", "pipe"], shell: false,
        detached: process.platform !== "win32", windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, output: "", detail: `Could not launch executable (${(error as NodeJS.ErrnoException).code ?? "spawn error"})` })
      return
    }
    const collect = (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > 64 * 1024) { stop("Probe output exceeded 64 KiB"); return }
      output += chunk.toString("utf8")
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.once("error", error => finish({ ok: false, output: "", detail: `Could not launch executable (${(error as NodeJS.ErrnoException).code ?? "spawn error"})` }))
    child.once("close", (code, signal) => finish(code === 0
      ? { ok: true, output }
      : { ok: false, output: "", detail: `Probe exited with ${signal ?? `code ${code}`}` }))
    timer = setTimeout(() => stop(`Probe timed out after ${timeoutMs} ms`), timeoutMs)
  })
}

export function parseExecutableVersion(output: string): string | undefined {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "")
  return /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$|\()/.exec(clean)?.[1]
}

/** SDK minimums are stable semver; an equal-core prerelease is below it. */
export function meetsMinimumVersion(version: string, minimum: string) {
  const actual = version.split(/[.+-]/).slice(0, 3).map(Number)
  const required = minimum.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (actual[i]! !== required[i]!) return actual[i]! > required[i]!
  }
  return !version.split("+", 1)[0]!.includes("-")
}
