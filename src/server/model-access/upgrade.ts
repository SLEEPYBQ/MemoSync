import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, realpath } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import type { EngineId, ExecutableStatus } from "../../shared/model-access"
import type { ExecutableEnvironment } from "./discovery-paths"
import { LEGACY_PI_PACKAGE, managedPiRoot, PI_PACKAGE } from "./pi-installation"

const UPGRADE_TIMEOUT_MS = 5 * 60_000
const OUTPUT_TAIL_BYTES = 4_000

export interface UpgradeStep {
  command: string
  args: string[]
  label: string
  env?: Record<string, string>
}
export interface UpgradePlan {
  /** What the settings page shows, and what the user could run themselves. */
  display: string
  steps: UpgradeStep[]
}
export type UpgradeRunner = (step: UpgradeStep, env: ExecutableEnvironment) => Promise<{ ok: boolean; output: string }>

async function runnable(file: string) {
  try { await access(file, constants.X_OK); return true }
  catch { return false }
}

/** `<prefix>/lib/node_modules/<package>/…`, and only when that prefix has its own npm. */
async function npmGlobalPrefix(entry: string, packageName: string) {
  const marker = `/lib/node_modules/${packageName}/`
  const index = entry.replaceAll("\\", "/").indexOf(marker)
  if (index <= 0) return undefined
  const prefix = entry.slice(0, index)
  return await runnable(join(prefix, "bin/npm")) ? prefix : undefined
}

function plan(steps: UpgradeStep[]): UpgradePlan {
  return { display: steps.map(step => step.label).join(" && "), steps }
}

/**
 * How this installation updates itself. Undefined when its source can't be
 * established: a command for the wrong package manager can break a working
 * install, so the settings page then only offers a command to copy.
 */
export async function upgradePlan(engine: EngineId, executable: ExecutableStatus, env: ExecutableEnvironment): Promise<UpgradePlan | undefined> {
  if (executable.state !== "incompatible" || !executable.belowMinimum || !executable.path) return undefined
  const entry = await realpath(executable.path).catch(() => undefined)
  if (!entry) return undefined
  const self = (args: string[], label: string): UpgradeStep => ({ command: executable.path!, args, label })

  if (engine === "claude") {
    const cask = /^(.*)\/Caskroom\/([^/]+)\//.exec(entry)
    if (cask) {
      const brew = join(cask[1]!, "bin/brew")
      if (!await runnable(brew)) return undefined
      return plan([{ command: brew, args: ["upgrade", "--cask", cask[2]!], label: `brew upgrade --cask ${cask[2]}` }])
    }
    const home = env.HOME || env.USERPROFILE
    const native = Boolean(home) && [join(home!, ".local/share/claude/"), join(home!, ".claude/local/")].some(root => entry.startsWith(root))
    if (native || await npmGlobalPrefix(entry, "@anthropic-ai/claude-code")) return plan([self(["update"], "claude update")])
    return undefined
  }

  if (engine === "pi") {
    // Both packages own bin/pi, so npm refuses the new one until the old one is gone.
    const legacyPrefix = await npmGlobalPrefix(entry, LEGACY_PI_PACKAGE)
    if (legacyPrefix) {
      const npm = join(legacyPrefix, "bin/npm")
      // A user-level npmrc can name another prefix. The replacement belongs where the old one was.
      const env = { npm_config_prefix: legacyPrefix }
      return plan([
        { command: npm, args: ["uninstall", "-g", LEGACY_PI_PACKAGE], label: `npm uninstall -g ${LEGACY_PI_PACKAGE}`, env },
        { command: npm, args: ["install", "-g", "--ignore-scripts", PI_PACKAGE], label: `npm install -g --ignore-scripts ${PI_PACKAGE}`, env },
      ])
    }
    if (await managedPiRoot(entry) || await npmGlobalPrefix(entry, PI_PACKAGE)) return plan([self(["update", "self"], "pi update self")])
  }
  return undefined
}

export const runUpgradeStep: UpgradeRunner = (step, env) => new Promise(resolve => {
  let output = ""
  const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES) }
  // Package managers and their shebangs need the runtime that sits beside them.
  const path = [dirname(step.command), env.PATH ?? env.Path].filter(Boolean).join(delimiter)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(step.command, step.args, { env: { ...env, ...step.env, PATH: path } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true })
  } catch (error) {
    resolve({ ok: false, output: error instanceof Error ? error.message : String(error) })
    return
  }
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
    resolve({ ok: false, output: `${step.label} timed out\n${output}` })
  }, UPGRADE_TIMEOUT_MS)
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)
  child.on("error", error => { clearTimeout(timer); resolve({ ok: false, output: error.message }) })
  child.on("close", code => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
})

/** Runs each step in order and stops at the first failure, returning its output. */
export async function runUpgradePlan(upgrade: UpgradePlan, env: ExecutableEnvironment, run: UpgradeRunner = runUpgradeStep) {
  for (const step of upgrade.steps) {
    const result = await run(step, env)
    if (!result.ok) return { ok: false as const, detail: `${step.label}\n${result.output.trim()}`.trim() }
  }
  return { ok: true as const }
}
