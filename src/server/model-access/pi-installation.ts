import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { executableLauncher } from "./launcher"
import type { ExecutableEnvironment } from "./discovery-paths"
import { meetsMinimumVersion } from "./probe"

export const PI_SDK_MINIMUM = "0.73.1"

/** Use the SDK belonging to the discovered CLI, never a second bundled agent. */
export async function readPiInstallation(file: string, env: ExecutableEnvironment) {
  const launcher = await executableLauncher(file, env)
  const entry = await realpath(launcher.args[0] ?? launcher.command)
  let directory = dirname(entry)
  for (let depth = 0; depth < 8; depth++) {
    let metadata: { name?: string; version?: string; main?: string } | undefined
    try { metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) }
    catch { /* not the package root */ }
    if (metadata?.name === "@mariozechner/pi-coding-agent") {
      const version = metadata.version ?? ""
      if (!/^0\.73\.\d+$/.test(version) || !meetsMinimumVersion(version, PI_SDK_MINIMUM))
        throw new Error(`MemoSync requires a local Pi 0.73.x installation (at least ${PI_SDK_MINIMUM}); found ${version || "unknown"}`)
      const sdk = resolve(directory, metadata.main ?? "dist/index.js")
      if (!(await stat(sdk)).isFile()) throw new Error("The local Pi SDK entry is missing")
      return { entry: sdk, version }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error("Configure the CLI from a local @mariozechner/pi-coding-agent installation")
}
