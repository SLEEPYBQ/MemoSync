import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ExecutableStatus } from "../../shared/model-access"
import { runUpgradePlan, runUpgradeStep, upgradePlan, type UpgradeStep } from "./upgrade"

let home: string
const tooOld = (path: string): ExecutableStatus => ({ state: "incompatible", belowMinimum: true, path, version: "0.1.0", minimumVersion: "1.0.0" })
const env = () => ({ HOME: home, PATH: "/fixture/none" })

async function file(path: string, mode = 0o755) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "#!/bin/sh\n")
  await chmod(path, mode)
  return path
}

beforeEach(async () => { home = await realpath(await mkdtemp(join(tmpdir(), "memosync-upgrade-"))) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe("which installations get an upgrade", () => {
  test("Pi from the old npm package is removed first, because both own bin/pi", async () => {
    const prefix = join(home, "prefix")
    const npm = await file(join(prefix, "bin/npm"))
    const entry = await file(join(prefix, "lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"))
    const plan = await upgradePlan("pi", tooOld(entry), env())
    expect(plan?.steps.map(step => [step.command, ...step.args])).toEqual([
      [npm, "uninstall", "-g", "@mariozechner/pi-coding-agent"],
      [npm, "install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"],
    ])
    expect(plan?.steps.every(step => step.env?.npm_config_prefix === prefix)).toBe(true)
    expect(plan?.display).toBe("npm uninstall -g @mariozechner/pi-coding-agent && npm install -g --ignore-scripts @earendil-works/pi-coding-agent")
  })

  test("Pi from the current npm package updates itself, with that install's npm", async () => {
    const prefix = join(home, "prefix")
    await file(join(prefix, "bin/npm"))
    const node = await file(join(prefix, "bin/node"))
    const entry = await file(join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"))
    expect((await upgradePlan("pi", tooOld(entry), env()))?.steps).toEqual([{
      command: node, args: [entry, "update", "self"], label: "pi update self",
      binDir: join(prefix, "bin"), env: { npm_config_prefix: prefix },
    }])
  })

  test("Pi from the installer updates itself", async () => {
    const launcher = await file(join(home, "agent/bin/pi"))
    await mkdir(join(home, "agent/install"), { recursive: true })
    await writeFile(join(home, "agent/install/managed-install.json"), JSON.stringify({ kind: "pi-managed-install" }))
    expect((await upgradePlan("pi", tooOld(launcher), env()))?.display).toBe("pi update self")
  })

  test("Claude Code from npm or its native installer updates itself", async () => {
    await file(join(home, "prefix/bin/npm"))
    for (const path of [
      await file(join(home, "prefix/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe")),
      await file(join(home, ".local/share/claude/versions/2.0.0")),
      await file(join(home, ".claude/local/claude")),
    ]) {
      expect((await upgradePlan("claude", tooOld(path), env()))?.steps).toEqual([{ command: path, args: ["update"], label: "claude update" }])
    }
  })

  test("Claude Code from a Homebrew cask goes through that Homebrew", async () => {
    const brew = await file(join(home, "brew/bin/brew"))
    const entry = await file(join(home, "brew/Caskroom/claude-code/2.0.0/claude"))
    expect((await upgradePlan("claude", tooOld(entry), env()))?.steps).toEqual([{ command: brew, args: ["upgrade", "--cask", "claude-code"], label: "brew upgrade --cask claude-code" }])
  })

  test("an unknown source gets nothing to run", async () => {
    const elsewhere = await file(join(home, "elsewhere/tool"))
    expect(await upgradePlan("pi", tooOld(elsewhere), env())).toBeUndefined()
    expect(await upgradePlan("claude", tooOld(elsewhere), env())).toBeUndefined()
    expect(await upgradePlan("codex", tooOld(elsewhere), env())).toBeUndefined()
    // pnpm and bun keep global packages elsewhere; npm's commands must not touch them.
    const pnpm = await file(join(home, "pnpm/global/5/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))
    expect(await upgradePlan("pi", tooOld(pnpm), env())).toBeUndefined()
    // An npm layout without its own npm can't be driven from here either.
    const noNpm = await file(join(home, "bare/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))
    expect(await upgradePlan("pi", tooOld(noNpm), env())).toBeUndefined()
  })

  test("only an installation below its minimum qualifies", async () => {
    await file(join(home, "prefix/bin/npm"))
    await file(join(home, "prefix/bin/node"))
    const entry = await file(join(home, "prefix/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))
    expect(await upgradePlan("pi", { ...tooOld(entry), belowMinimum: false }, env())).toBeUndefined()
    expect(await upgradePlan("pi", { ...tooOld(entry), state: "ready" }, env())).toBeUndefined()
    expect(await upgradePlan("pi", { ...tooOld(entry), state: "broken" }, env())).toBeUndefined()
  })
})

describe("running a plan", () => {
  const steps: UpgradeStep[] = [
    { command: "/fixture/a", args: [], label: "first" },
    { command: "/fixture/b", args: [], label: "second" },
  ]

  test("stops at the first failure and reports its output", async () => {
    const ran: string[] = []
    const result = await runUpgradePlan({ display: "", steps }, {}, async step => {
      ran.push(step.label)
      return { ok: false, output: "npm error EACCES\n" }
    })
    expect(ran).toEqual(["first"])
    expect(result).toEqual({ ok: false, detail: "first\nnpm error EACCES" })
  })

  test("runs the real command with the tool's own directory on PATH", async () => {
    const seen = join(home, "seen")
    const script = join(home, "bin/tool")
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, `#!/bin/sh\necho "$PATH $*" > '${seen}'\n`)
    await chmod(script, 0o755)
    const result = await runUpgradePlan({ display: "tool", steps: [{ command: script, args: ["update"], label: "tool update" }] }, { PATH: "/usr/bin:/bin" })
    expect(result).toEqual({ ok: true })
    expect(await Bun.file(seen).text()).toBe(`${dirname(script)}:/usr/bin:/bin update\n`)
  })

  test("a command that fails or can't start is a failure, not a crash", async () => {
    const script = join(home, "bin/fail")
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, "#!/bin/sh\necho nope >&2\nexit 7\n")
    await chmod(script, 0o755)
    expect(await runUpgradePlan({ display: "", steps: [{ command: script, args: [], label: "fail" }] }, {})).toEqual({ ok: false, detail: "fail\nnope" })
    expect((await runUpgradePlan({ display: "", steps: [{ command: join(home, "missing"), args: [], label: "gone" }] }, {})).ok).toBe(false)
  })
})

describe("review findings, reproduced against real processes", () => {
  test("an upgrade launches a JS CLI with the runtime its install owns, not whatever PATH offers", async () => {
    const log = join(home, "ran")
    const prefix = join(home, "prefix")
    await file(join(prefix, "bin/npm"))
    const node = join(prefix, "bin/node")
    await mkdir(dirname(node), { recursive: true })
    await writeFile(node, `#!/bin/sh\necho "$0 $*" > '${log}'\n`)
    await chmod(node, 0o755)
    const entry = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "#!/usr/bin/env node\n")
    await chmod(entry, 0o755)
    // A desktop app's PATH: no runtime anywhere on it.
    const path = await realpath(await mkdtemp(join(home, "empty-")))
    const plan = await upgradePlan("pi", tooOld(entry), { HOME: home, PATH: path })
    expect(await runUpgradePlan(plan!, { HOME: home, PATH: path })).toEqual({ ok: true })
    expect(await Bun.file(log).text()).toBe(`${node} ${entry} update self\n`)
  })

  test("a JS CLI that could only run under this server's Bun gets no plan, because Pi would pick the wrong package manager", async () => {
    await file(join(home, "prefix/bin/npm"))
    const entry = join(home, "prefix/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "#!/usr/bin/env node\n")
    await chmod(entry, 0o755)
    const path = await realpath(await mkdtemp(join(home, "empty-")))
    expect(await upgradePlan("pi", tooOld(entry), { HOME: home, PATH: path })).toBeUndefined()
  })

  const writer = async (body: string) => {
    const marker = join(home, "still-writing")
    const script = join(home, "bin/installer")
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, `#!/bin/sh\n(while :; do echo x >> '${marker}'; sleep 0.02; done) &\n${body}\n`)
    await chmod(script, 0o755)
    return { marker, script }
  }
  const expectStopped = async (marker: string) => {
    const settled = await Bun.file(marker).text()
    await Bun.sleep(200)
    expect((await Bun.file(marker).text()).length).toBe(settled.length)
  }

  test("a timeout stops the installer's children too, and only then reports back", async () => {
    const { marker, script } = await writer("wait")
    const result = await runUpgradeStep({ command: script, args: [], label: "installer" }, { PATH: "/usr/bin:/bin" }, 300)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("timed out")
    await expectStopped(marker)
  })

  test("a timeout also stops children that outlived their parent", async () => {
    // The parent is gone, so only the process group still reaches this child.
    const { marker, script } = await writer("exit 0")
    const result = await runUpgradeStep({ command: script, args: [], label: "installer" }, { PATH: "/usr/bin:/bin" }, 300)
    expect(result.output).toContain("timed out")
    await expectStopped(marker)
  })
})
