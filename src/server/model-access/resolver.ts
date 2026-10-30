import { createHash } from "node:crypto"
import { lstat, realpath, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import type { EngineId, EngineSetup, ExecutableStatus } from "../../shared/model-access"
import { knownInstallDirectories, type ExecutableEnvironment } from "./discovery-paths"
import { executableLauncher } from "./launcher"
import { meetsMinimumVersion, parseExecutableVersion, runExecutableProbe } from "./probe"
import { readSdkInstallation, type SdkInstallation } from "./sdk-installation"

/** Dependency seam for tests: fake SDK and installation roots, never host CLIs. */
export interface ResolverOptions {
  knownDirectories?: (env: ExecutableEnvironment) => Promise<readonly string[]>
  sdkInstallation?: () => SdkInstallation
  probeTimeoutMs?: number
}

type Source = NonNullable<ExecutableStatus["source"]>
type ProbeStatus = Pick<ExecutableStatus, "state" | "version" | "detail">

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : "Unable to inspect executable"
}
async function fingerprint(file: string) {
  const info = await stat(file)
  return `${file}\0${info.mtimeMs}\0${info.size}\0${info.mode}`
}

export function createExecutableResolver(options: ResolverOptions = {}) {
  const knownDirectories = options.knownDirectories ?? knownInstallDirectories
  const sdkInstallation = options.sdkInstallation ?? readSdkInstallation
  const timeoutMs = options.probeTimeoutMs ?? 3000
  const probes = new Map<string, Promise<ProbeStatus>>()
  const last = new Map<EngineId, ExecutableStatus>()
  let generation = 0

  async function inspect(
    engine: "claude" | "codex", file: string, source: Source,
    env: ExecutableEnvironment, minimumVersion?: string, explicit = false,
  ): Promise<ExecutableStatus | undefined> {
    const base = { path: file, source, ...(minimumVersion ? { minimumVersion } : {}) }
    try {
      // lstat distinguishes absent candidates from dangling symlinks. An absent
      // automatic candidate is not a failure; a dangling installation is broken.
      try { await lstat(file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return undefined
        throw error
      }
      const target = await realpath(file)
      // Probe exactly the canonical path T2 will launch from status.path.
      const launcher = await executableLauncher(target, env)
      const files = [...new Set([target, launcher.command, ...launcher.args.filter(isAbsolute)])]
      const identities = await Promise.all(files.map(fingerprint))
      // Wrapper probes can depend on env/runtime/engine. Hash env rather than
      // retaining credentials in cache keys. Identity always includes realpath,
      // mtime and size, and permissions are rechecked before using the cache.
      const context = createHash("sha256").update(JSON.stringify(Object.entries(env).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))).digest("hex")
      const key = JSON.stringify([engine, identities, minimumVersion, context])
      let pending = probes.get(key)
      if (!pending) {
        pending = (async (): Promise<ProbeStatus> => {
          const versionProbe = await runExecutableProbe(launcher, ["--version"], env, timeoutMs)
          if (!versionProbe.ok) return { state: "broken", detail: `--version: ${versionProbe.detail}` }
          const version = parseExecutableVersion(versionProbe.output)
          if (!version) return { state: "broken", detail: "--version did not return a semantic version" }
          if (engine === "claude" && minimumVersion && !meetsMinimumVersion(version, minimumVersion))
            return { state: "incompatible", version, detail: `Claude ${version} is below the SDK minimum ${minimumVersion}` }
          if (engine === "codex") {
            const capability = await runExecutableProbe(launcher, ["app-server", "--help"], env, timeoutMs)
            if (!capability.ok) return { state: "incompatible", version, detail: `Codex app-server is unavailable: ${capability.detail}` }
          }
          return { state: "ready", version }
        })()
        // Bound old identities after repeated installs/environment changes.
        if (probes.size >= 256) probes.delete(probes.keys().next().value!)
        probes.set(key, pending)
      }
      return { ...base, path: target, ...await pending }
    } catch (error) { return { ...base, state: "broken", detail: errorDetail(error) } }
  }

  async function discover(
    engine: EngineId,
    setup: Pick<EngineSetup, "executablePath"> | undefined,
    env: ExecutableEnvironment,
  ): Promise<ExecutableStatus> {
    if (engine === "pi") return { state: "not-needed" }
    let sdk: SdkInstallation | undefined
    if (engine === "claude") {
      try { sdk = sdkInstallation() }
      catch (error) { return { state: "broken", detail: `Claude Agent SDK: ${errorDetail(error)}` } }
    }
    const minimumVersion = sdk?.minimumVersion
    const expand = (file: string) => resolve(file.startsWith("~/") && (env.HOME || env.USERPROFILE)
      ? join((env.HOME || env.USERPROFILE)!, file.slice(2)) : file)
    if (setup?.executablePath != null) {
      const configured = setup.executablePath.trim()
      if (!configured) return { state: "broken", source: "configured", detail: "Configured executable path is empty", ...(minimumVersion ? { minimumVersion } : {}) }
      return (await inspect(engine, expand(configured), "configured", env, minimumVersion, true))!
    }
    let firstFailure: ExecutableStatus | undefined
    const seen = new Set<string>()
    const candidate = async (file: string, source: Source) => {
      if (seen.has(file)) return undefined
      seen.add(file)
      const result = await inspect(engine, file, source, env, minimumVersion)
      if (result?.state === "ready") return result
      firstFailure ??= result
      return undefined
    }
    if (engine === "claude" && env.CLAUDE_EXECUTABLE?.trim()) {
      const result = await candidate(expand(env.CLAUDE_EXECUTABLE.trim()), "configured")
      if (result) return result
    }
    const names = process.platform === "win32" ? [`${engine}.exe`, `${engine}.cmd`, engine] : [engine]
    const inDirectories = async (dirs: readonly string[], source: Source) => {
      for (const dir of dirs) for (const name of names) {
        const result = await candidate(resolve(dir.replace(/^"|"$/g, ""), name), source)
        if (result) return result
      }
      return undefined
    }
    // Do not use Bun.which's startup PATH or launch another login shell here.
    // server.ts owns shellPathReady; T2 must await it before resolving engines.
    const fromPath = await inDirectories((env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), "path")
    if (fromPath) return fromPath
    const fromKnown = await inDirectories(await knownDirectories(env), "known-dir")
    if (fromKnown) return fromKnown
    for (const file of sdk?.bundledPaths ?? []) {
      const result = await candidate(file, "bundled")
      if (result) return result
    }
    return firstFailure ?? { state: "missing", ...(minimumVersion ? { minimumVersion } : {}), detail: `No ${engine} executable found` }
  }

  async function resolveEngineExecutable(
    engine: EngineId,
    setup?: Pick<EngineSetup, "executablePath">,
    env: ExecutableEnvironment = process.env,
  ): Promise<ExecutableStatus> {
    const started = generation
    const result = await discover(engine, setup, { ...env })
    if (generation === started) last.set(engine, { ...result })
    return result
  }
  return {
    resolveEngineExecutable,
    refreshExecutables() { generation++; probes.clear(); last.clear() },
    lastEngineExecutable(engine: EngineId): ExecutableStatus | undefined {
      const result = last.get(engine)
      return result ? { ...result } : undefined
    },
  }
}
