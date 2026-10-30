import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { createExecutableResolver } from "./resolver"
import { knownInstallDirectories } from "./discovery-paths"
import { readSdkInstallation } from "./sdk-installation"
import { executableLauncher } from "./launcher"

let home: string
let env: Record<string, string>
let sdkEntry: string
let log: string
const minimum = "2.10.5"
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

async function file(path: string, text: string, mode = 0o755) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  await chmod(path, mode)
  return path
}
async function cli(path: string, version = "codex-cli 0.120.0", support = true) {
  return file(path, `#!/bin/sh\necho "$*" >> ${quote(log)}\nif [ "$1" = "--version" ]; then echo ${quote(version)}; exit 0; fi\nif [ "$1 $2" = "app-server --help" ]; then exit ${support ? 0 : 2}; fi\nexit 77\n`)
}
async function lines() {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) }
  catch { return [] }
}
function resolver(timeoutMs = 1500) {
  return createExecutableResolver({
    knownDirectories: e => knownInstallDirectories(e, [], join(home, "runtime/bun")),
    sdkInstallation: () => readSdkInstallation(sdkEntry),
    probeTimeoutMs: timeoutMs,
  })
}
async function bundle(version = `${minimum} (Claude Code)`, broken = false) {
  const packageDir = join(home, "node_modules", `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`)
  await file(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-cli" }), 0o600)
  const path = join(packageDir, "claude")
  if (broken) await file(path, "#!/bin/sh\nexit 3\n")
  else await cli(path, version)
  return path
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "memosync-executables-")))
  env = { HOME: home, PATH: join(home, "path"), CLAUDE_CONFIG_DIR: join(home, "claude-profile"), CODEX_HOME: join(home, "codex-profile") }
  log = join(home, "probes.log")
  sdkEntry = await file(join(home, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"), "", 0o600)
  await file(join(dirname(sdkEntry), "package.json"), JSON.stringify({ claudeCodeVersion: minimum }), 0o600)
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe("engine executable discovery (isolated HOME, PATH and SDK)", () => {
  test("missing means no candidate; Pi needs no executable", async () => {
    const r = resolver()
    expect(await r.resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "missing" })
    expect(await r.resolveEngineExecutable("claude", undefined, env)).toMatchObject({ state: "missing", minimumVersion: minimum })
    expect(await r.resolveEngineExecutable("pi", undefined, env)).toEqual({ state: "not-needed" })
  })

  test("configured path wins over environment, PATH, known dirs and bundle", async () => {
    const explicit = await cli(join(home, "explicit"), `${minimum} (Claude Code)`)
    env.CLAUDE_EXECUTABLE = await cli(join(home, "override"), "9.0.0 (Claude Code)")
    await cli(join(env.PATH!, "claude"), "9.0.0 (Claude Code)")
    await cli(join(home, ".local/bin/claude"), "9.0.0 (Claude Code)")
    await bundle()
    expect(await resolver().resolveEngineExecutable("claude", { executablePath: ` ${explicit} ` }, env))
      .toEqual({ state: "ready", path: explicit, source: "configured", version: minimum, minimumVersion: minimum })
    expect(await lines()).toEqual(["--version"])
  })

  test("invalid explicit paths report errors without fallback", async () => {
    await cli(join(env.PATH!, "codex"))
    const r = resolver()
    const absent = await r.resolveEngineExecutable("codex", { executablePath: join(home, "absent") }, env)
    expect(absent).toMatchObject({ state: "broken", source: "configured", path: join(home, "absent") })
    expect(absent.detail).toBeTruthy()
    const directory = join(home, "directory")
    await mkdir(directory)
    expect(await r.resolveEngineExecutable("codex", { executablePath: directory }, env)).toMatchObject({ state: "broken" })
    const noExec = await cli(join(home, "not-executable"))
    await chmod(noExec, 0o600)
    expect(await r.resolveEngineExecutable("codex", { executablePath: noExec }, env)).toMatchObject({ state: "broken" })
    expect(await lines()).toEqual([])
  })

  test("explicit empty whitespace is invalid, null enables discovery", async () => {
    const path = await cli(join(env.PATH!, "codex"))
    const r = resolver()
    expect(await r.resolveEngineExecutable("codex", { executablePath: "  " }, env)).toMatchObject({ state: "broken" })
    expect(await r.resolveEngineExecutable("codex", { executablePath: null }, env)).toMatchObject({ state: "ready", path, version: "0.120.0" })
  })

  test("CLAUDE_EXECUTABLE wins over PATH; a broken override permits discovery", async () => {
    const override = await cli(join(home, "override"), `${minimum} (Claude Code)`)
    const path = await cli(join(env.PATH!, "claude"), "3.0.0 (Claude Code)")
    const r = resolver()
    env.CLAUDE_EXECUTABLE = override
    expect(await r.resolveEngineExecutable("claude", undefined, env)).toMatchObject({ path: override, source: "configured", version: minimum })
    env.CLAUDE_EXECUTABLE = join(home, "absent")
    expect(await r.resolveEngineExecutable("claude", undefined, env)).toMatchObject({ path, source: "path", version: "3.0.0" })
  })

  test("all PATH candidates are checked, including broken and incompatible ones", async () => {
    const first = join(home, "one")
    const second = join(home, "two")
    const third = join(home, "three")
    await file(join(first, "codex"), "#!/bin/sh\nexit 1\n")
    await cli(join(second, "codex"), "codex-cli 0.1.0", false)
    const path = await cli(join(third, "codex"))
    env.PATH = [first, second, third].join(":")
    await cli(join(home, ".local/bin/codex"))
    expect(await resolver().resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "ready", path, source: "path", version: "0.120.0" })
    expect(await lines()).toEqual(["--version", "app-server --help", "--version", "app-server --help"])
  })

  test("without a ready candidate the earliest failed candidate supplies diagnostics", async () => {
    const path = await cli(join(env.PATH!, "codex"), "codex-cli 0.1.0", false)
    await file(join(home, ".local/bin/codex"), "#!/bin/sh\nexit 1\n")
    const result = await resolver().resolveEngineExecutable("codex", undefined, env)
    expect(result).toMatchObject({ state: "incompatible", path, source: "path", version: "0.1.0" })
    expect(result.detail).toContain("app-server")
  })

  test("a version command failure is broken, not missing or incompatible", async () => {
    const path = await file(join(env.PATH!, "codex"), "#!/bin/sh\necho failure >&2\nexit 4\n")
    const result = await resolver().resolveEngineExecutable("codex", undefined, env)
    expect(result).toMatchObject({ state: "broken", path, source: "path" })
    expect(result.detail).toContain("4")
  })

  test("malformed successful version output is broken", async () => {
    await cli(join(env.PATH!, "codex"), "this is not a version")
    expect(await resolver().resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "broken" })
  })

  test("Claude minimum comes from SDK metadata and uses semantic version order", async () => {
    const path = await cli(join(env.PATH!, "claude"), "2.9.100 (Claude Code)")
    const r = resolver()
    expect(await r.resolveEngineExecutable("claude", { executablePath: path }, env))
      .toMatchObject({ state: "incompatible", version: "2.9.100", minimumVersion: minimum })
    await cli(path, `${minimum}-beta.1 (Claude Code)`)
    r.refreshExecutables()
    expect(await r.resolveEngineExecutable("claude", { executablePath: path }, env)).toMatchObject({ state: "incompatible" })
    await cli(path, "2.10.6 (Claude Code)")
    expect(await r.resolveEngineExecutable("claude", { executablePath: path }, env)).toMatchObject({ state: "ready", version: "2.10.6" })
  })

  test("known installation beats bundled fallback after unusable PATH entries", async () => {
    await cli(join(env.PATH!, "claude"), "1.0.0 (Claude Code)")
    const path = await cli(join(home, ".claude/local/claude"), `${minimum} (Claude Code)`)
    await bundle()
    expect(await resolver().resolveEngineExecutable("claude", undefined, env)).toMatchObject({ state: "ready", path, source: "known-dir", version: minimum })
  })

  test("known directories cover global prefixes and bounded numeric version scans", async () => {
    env.NPM_CONFIG_PREFIX = join(home, "custom-npm")
    env.PNPM_HOME = join(home, "custom-pnpm")
    env.FNM_DIR = join(home, "custom-fnm")
    await file(join(home, ".npmrc"), 'prefix="~/npmrc-prefix"\n', 0o600)
    const dirs = await knownInstallDirectories(env, [join(home, "homebrew")], join(home, "runtime/bun"))
    for (const dir of ["custom-npm/bin", "custom-pnpm", "npmrc-prefix/bin", ".yarn/bin", ".bun/bin", ".volta/bin", "homebrew"])
      expect(dirs).toContain(join(home, dir))
    for (let i = 1; i <= 35; i++) await mkdir(join(home, `.nvm/versions/node/v${i}.0.0/bin`), { recursive: true })
    const versions = await knownInstallDirectories(env, [], join(home, "runtime/bun"))
    expect(versions.filter(p => p.includes(".nvm/versions/node/"))).toHaveLength(32)
    expect(versions.indexOf(join(home, ".nvm/versions/node/v35.0.0/bin")))
      .toBeLessThan(versions.indexOf(join(home, ".nvm/versions/node/v9.0.0/bin")))
    expect(versions).not.toContain(join(home, ".nvm/versions/node/v3.0.0/bin"))
    const path = await cli(join(home, ".nvm/versions/node/v35.0.0/bin/codex"))
    await cli(join(home, ".nvm/versions/node/v9.0.0/bin/codex"))
    expect(await resolver().resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "ready", path, source: "known-dir" })
  })

  test("fnm/asdf/mise environment roots and numeric order find installations", async () => {
    for (const [key, suffix] of [["FNM_DIR", "node-versions/v22.1.0/installation/bin"], ["ASDF_DATA_DIR", "installs/nodejs/22.1.0/bin"], ["MISE_DATA_DIR", "installs/node/22.1.0/bin"]]) {
      const local = { ...env, [key!]: join(home, key!) }
      const path = await cli(join(local[key!]!, suffix!, "codex"))
      expect(await resolver().resolveEngineExecutable("codex", undefined, local)).toMatchObject({ state: "ready", path, source: "known-dir" })
      await rm(path)
    }
  })

  test("SDK platform CLI is probed only as a last resort", async () => {
    const path = await bundle()
    expect(await resolver().resolveEngineExecutable("claude", undefined, env))
      .toEqual({ state: "ready", path, source: "bundled", version: minimum, minimumVersion: minimum })
    expect(await lines()).toEqual(["--version"])
  })

  test("a broken SDK fallback is diagnosed; explicit failure never uses bundle", async () => {
    await bundle(undefined, true)
    const r = resolver()
    expect(await r.resolveEngineExecutable("claude", undefined, env)).toMatchObject({ state: "broken", source: "bundled" })
    await bundle()
    expect(await r.resolveEngineExecutable("claude", { executablePath: join(home, "absent") }, env)).toMatchObject({ state: "broken", source: "configured" })
    expect(await lines()).toEqual([])
  })

  test("symlinks resolve to real paths and share one probe", async () => {
    const target = await cli(join(home, "target"))
    const alias = join(env.PATH!, "codex")
    await mkdir(env.PATH!, { recursive: true })
    await symlink(target, alias)
    const r = resolver()
    expect(await r.resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "ready", path: target })
    expect(await r.resolveEngineExecutable("codex", { executablePath: target }, env)).toMatchObject({ state: "ready", path: target })
    expect(await lines()).toEqual(["--version", "app-server --help"])
    await rm(target)
    expect(await r.resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "broken" })
  })

  test("JS symlink shims use an adjacent runtime with a fake-only PATH", async () => {
    const target = await file(join(home, "package/entry.mjs"), 'console.log("codex-cli 0.120.0"); if (process.argv[2] !== "--version" && process.argv.slice(2).join(" ") !== "app-server --help") process.exit(2)\n', 0o600)
    const alias = join(env.PATH!, "codex")
    await mkdir(env.PATH!, { recursive: true })
    await symlink(target, alias)
    const node = await file(join(env.PATH!, "node"), `#!/bin/sh\necho node >> ${quote(log)}\nexec ${quote(process.execPath)} "$@"\n`)
    const result = await resolver().resolveEngineExecutable("codex", undefined, env)
    expect(result).toMatchObject({ state: "ready", path: target, version: "0.120.0" })
    const launcher = await executableLauncher(alias, env)
    expect(launcher).toEqual({ command: node, args: [target] })
    expect(await lines()).toEqual(["node", "node"])
  })

  test("extensionless node scripts and JS files use the current runtime if node is absent", async () => {
    const path = await file(join(home, "shim"), '#!/usr/bin/env node\nconsole.log("2.10.6 (Claude Code)")\n', 0o600)
    expect(await resolver().resolveEngineExecutable("claude", { executablePath: path }, env)).toMatchObject({ state: "ready", path, version: "2.10.6" })
    const js = await file(join(home, "entry.cjs"), 'console.log("codex-cli 0.120.0")\n', 0o600)
    expect(await resolver().resolveEngineExecutable("codex", { executablePath: js }, env)).toMatchObject({ state: "ready", path: js })
    const launcher = await executableLauncher(js, env)
    expect(launcher).toEqual({ command: process.execPath, args: [js] })
    // The helper T2 consumes must launch successfully, not just report a path.
    expect(await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launcher.command, [...launcher.args, "--version"], { env, stdio: "ignore" })
      child.once("error", reject)
      child.once("close", resolve)
    })).toBe(0)
  })

  test("mtime and size changes invalidate cache; refresh clears snapshots and probes", async () => {
    const path = await cli(join(env.PATH!, "codex"))
    const r = resolver()
    const result = await r.resolveEngineExecutable("codex", undefined, env)
    expect(r.lastEngineExecutable("codex")).toEqual(result)
    await r.resolveEngineExecutable("codex", undefined, env)
    expect(await lines()).toHaveLength(2)
    const old = await stat(path)
    await utimes(path, old.atime, new Date(old.mtimeMs + 2000))
    await r.resolveEngineExecutable("codex", undefined, env)
    expect(await lines()).toHaveLength(4)
    const changed = await stat(path)
    await file(path, (await readFile(path, "utf8")) + "# changed size\n")
    await utimes(path, changed.atime, changed.mtime)
    await r.resolveEngineExecutable("codex", undefined, env)
    expect(await lines()).toHaveLength(6)
    r.refreshExecutables()
    expect(r.lastEngineExecutable("codex")).toBeUndefined()
    await r.resolveEngineExecutable("codex", undefined, env)
    expect(await lines()).toHaveLength(8)
  })

  test("concurrent callers share probes, while env and engine changes do not", async () => {
    const path = await cli(join(env.PATH!, "codex"), "2.10.6")
    const r = resolver()
    const results = await Promise.all(Array.from({ length: 12 }, () => r.resolveEngineExecutable("codex", { executablePath: path }, env)))
    expect(results.every(s => s.state === "ready" && s.version === "2.10.6")).toBe(true)
    expect(await lines()).toHaveLength(2)
    await r.resolveEngineExecutable("codex", { executablePath: path }, { ...env, OTHER: "different" })
    expect(await lines()).toHaveLength(4)
    await r.resolveEngineExecutable("claude", { executablePath: path }, env)
    expect(await lines()).toHaveLength(5)
  })

  test("fresh PATH and newly installed files are seen without stale missing cache", async () => {
    const r = resolver()
    expect(await r.resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "missing" })
    const path = await cli(join(home, "new-path/codex"))
    env.PATH = dirname(path)
    expect(await r.resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "ready", path })
    await rm(path)
    expect(await r.resolveEngineExecutable("codex", undefined, env)).toMatchObject({ state: "missing" })
  })

  test("hung version and app-server probes time out with the right states", async () => {
    const path = await file(join(env.PATH!, "codex"), "#!/bin/sh\nwhile :; do :; done\n")
    const r = resolver(60)
    const start = performance.now()
    const version = await r.resolveEngineExecutable("codex", undefined, env)
    expect(version).toMatchObject({ state: "broken" })
    expect(version.detail).toContain("timed out")
    await file(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.120.0"; exit 0; fi\nwhile :; do :; done\n')
    const capability = await r.resolveEngineExecutable("codex", undefined, env)
    expect(capability).toMatchObject({ state: "incompatible" })
    expect(capability.detail).toContain("timed out")
    expect(performance.now() - start).toBeLessThan(2000)
  })
})
