import { spawn } from "node:child_process"
import type { ConnectionModel } from "../../shared/model-access"
import { killProcessTree } from "../process-utils"
import { executableLauncher } from "./launcher"
import { cleanConnectionEnv, type RuntimeEnv } from "./legacy"

const PROBE_TIMEOUT_MS = 10_000

export interface AntigravityAccountResult {
  accountModels: ConnectionModel[]
  accountDefaultModel?: string
  problem?: "account-signed-out" | "account-config-invalid"
  problemDetail?: string
}

/** `agy models` is both the account probe and the catalog: signed-out CLI exits 1 with an explicit sign-in error. */
export function parseAntigravityModels(stdout: string): ConnectionModel[] {
  const models: ConnectionModel[] = []
  const seen = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [id, label] = trimmed.split(/\t+/, 2).map(part => part?.trim())
    if (!id || !label || seen.has(id) || id.length > 200 || label.length > 300) continue
    seen.add(id)
    models.push({ id, label, supportsReasoning: true, supportsImages: true })
  }
  return models
}

export async function probeAntigravityAccount(executable: string, env: RuntimeEnv): Promise<AntigravityAccountResult> {
  const clean = cleanConnectionEnv(env)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const launcher = await executableLauncher(executable, clean)
    child = spawn(launcher.command, [...launcher.args, "models"], {
      env: clean as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = "", stderr = ""
    child.stdout!.setEncoding("utf8")
    child.stderr!.setEncoding("utf8")
    child.stdout!.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-256_000) })
    child.stderr!.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_000) })
    const closed = new Promise<number | null>(resolve => child!.once("close", code => resolve(code)))
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS))
    const code = await Promise.race([closed, timeout])
    if (code === null) {
      await killProcessTree(child).catch(() => {})
      return { accountModels: [], problem: "account-config-invalid", problemDetail: "Antigravity model probe timed out." }
    }
    if (code !== 0) {
      const detail = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line && line !== "Fetching available models...").join("\n")
      const signedOut = /sign in|authentication required|unauthorized/i.test(detail)
      return { accountModels: [], problem: signedOut ? "account-signed-out" : "account-config-invalid", problemDetail: detail || "Unable to load Antigravity account models." }
    }
    const accountModels = parseAntigravityModels(stdout)
    if (!accountModels.length) return { accountModels: [], problem: "account-config-invalid", problemDetail: "Antigravity returned no account models." }
    return { accountModels, accountDefaultModel: accountModels[0]!.id }
  } catch (error) {
    return { accountModels: [], problem: "account-config-invalid", problemDetail: error instanceof Error ? error.message : "Unable to load Antigravity account models." }
  } finally {
    if (child && child.exitCode === null && !child.killed) await killProcessTree(child).catch(() => {})
  }
}
