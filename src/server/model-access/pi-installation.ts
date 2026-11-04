import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { executableLauncher } from "./launcher"
import type { ExecutableEnvironment } from "./discovery-paths"
import { meetsMinimumVersion } from "./probe"

export const PI_PACKAGE = "@earendil-works/pi-coding-agent"
/** The package name Pi published under before 1.0. It cannot be updated in place. */
export const LEGACY_PI_PACKAGE = "@mariozechner/pi-coding-agent"
/** The oldest release this integration has been run against. */
export const PI_SDK_MINIMUM = "1.3.0"

/** The installation is Pi, but not a version MemoSync can drive. */
export class PiVersionError extends Error {
  constructor(message: string, readonly version: string | undefined, readonly belowMinimum: boolean) {
    super(message)
  }
}

/** The installer's launcher sits at `<root>/bin/pi`, beside a marker that says so. */
export async function managedPiRoot(entry: string) {
  const root = dirname(dirname(entry))
  try {
    const marker = JSON.parse(await readFile(join(root, "install/managed-install.json"), "utf8")) as { kind?: unknown }
    return marker.kind === "pi-managed-install" ? root : undefined
  } catch { return undefined }
}

/** That launcher is a shell script, so the package it runs has to be found from its root. */
async function managedPiPackage(entry: string) {
  const root = await managedPiRoot(entry)
  if (!root) return undefined
  const version = (await readFile(join(root, "install/current-version"), "utf8").catch(() => "")).trim()
  if (!/^[\w.+-]+$/.test(version) || version.startsWith(".")) return undefined
  return join(root, "install/releases", version, "node_modules", PI_PACKAGE, "package.json")
}

/** Use the SDK belonging to the discovered CLI, never a second bundled agent. */
export async function readPiInstallation(file: string, env: ExecutableEnvironment) {
  const launcher = await executableLauncher(file, env)
  const entry = await realpath(launcher.args[0] ?? launcher.command)
  let directory = dirname(await managedPiPackage(entry) ?? entry)
  for (let depth = 0; depth < 8; depth++) {
    let metadata: { name?: string; version?: string; main?: string } | undefined
    try { metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) }
    catch { /* not the package root */ }
    if (metadata?.name === LEGACY_PI_PACKAGE)
      throw new PiVersionError(`MemoSync requires ${PI_PACKAGE} ${PI_SDK_MINIMUM} or later; found ${LEGACY_PI_PACKAGE} ${metadata.version ?? "unknown"}`, metadata.version, true)
    if (metadata?.name === PI_PACKAGE) {
      const version = metadata.version ?? ""
      if (!/^1\.\d+\.\d+$/.test(version) || !meetsMinimumVersion(version, PI_SDK_MINIMUM)) {
        const parsed = /^\d+\.\d+\.\d+/.test(version)
        throw new PiVersionError(
          `MemoSync requires a local Pi 1.x installation (at least ${PI_SDK_MINIMUM}); found ${version || "unknown"}`,
          version || undefined, parsed && !meetsMinimumVersion(version, PI_SDK_MINIMUM),
        )
      }
      const sdk = resolve(directory, metadata.main ?? "dist/index.js")
      if (!(await stat(sdk)).isFile()) throw new Error("The local Pi SDK entry is missing")
      return { entry: sdk, version }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Configure the CLI from a local ${PI_PACKAGE} installation`)
}
