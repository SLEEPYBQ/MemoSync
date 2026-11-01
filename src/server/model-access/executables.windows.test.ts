import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { delimiter, dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
import { createExecutableResolver } from "./resolver"
import { readSdkInstallation } from "./sdk-installation"

let home: string
let pathDirectory: string
let env: Record<string, string>
let sdkEntry: string

async function writeCli(cmdPath: string, jsPath: string, version: string, codexSupport = true) {
  await mkdir(dirname(jsPath), { recursive: true })
  await mkdir(dirname(cmdPath), { recursive: true })
  await writeFile(jsPath, [
    `const args = process.argv.slice(2)`,
    `if (args[0] === "--version") console.log(${JSON.stringify(version)})`,
    `else if (args[0] === "app-server" && args[1] === "--help") process.exit(${codexSupport ? 0 : 2})`,
    "else process.exit(77)",
  ].join("\n"))
  const entry = relative(dirname(cmdPath), jsPath).replaceAll("\\", "/")
  const windowsEntry = entry.replaceAll("/", "\\")
  await writeFile(cmdPath, [
    "@ECHO off",
    "SETLOCAL",
    'SET "dp0=%~dp0"',
    `IF EXIST "%~dp0\\node.exe" (`,
    `  "%~dp0\\node.exe" "%~dp0\\${windowsEntry}" %*`,
    ") ELSE (",
    `  node "%~dp0\\${windowsEntry}" %*`,
    ")",
  ].join("\r\n"))
}

function resolver() {
  return createExecutableResolver({
    knownDirectories: async () => [],
    sdkInstallation: () => readSdkInstallation(sdkEntry, "win32", "x64"),
    probeTimeoutMs: 2000,
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "memosync Windows executable fixtures "))
  pathDirectory = join(home, "path with spaces")
  sdkEntry = join(home, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")
  await mkdir(dirname(sdkEntry), { recursive: true })
  await writeFile(sdkEntry, "")
  await writeFile(join(dirname(sdkEntry), "package.json"), JSON.stringify({ claudeCodeVersion: "2.10.5" }))
  const bundledPackage = join(home, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64")
  await mkdir(bundledPackage, { recursive: true })
  await writeFile(join(bundledPackage, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-win32-x64" }))
  await writeFile(join(bundledPackage, "claude.exe"), "bundled fixture must not run")
  env = {
    HOME: home,
    USERPROFILE: home,
    PATH: pathDirectory,
    CLAUDE_CONFIG_DIR: join(home, "claude profile"),
    CODEX_HOME: join(home, "codex profile"),
    MEMOSYNC_EXTERNAL_AGENTS: "1",
  }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

test.skipIf(process.platform !== "win32")("discovers Claude, Codex and Pi through safe .cmd-to-JS fixtures in paths with spaces", async () => {
  const claude = join(pathDirectory, "claude.cmd")
  const codex = join(pathDirectory, "codex.cmd")
  await writeCli(claude, join(pathDirectory, "claude entry.js"), "2.10.5 (Claude Code)")
  await writeCli(codex, join(pathDirectory, "codex entry.js"), "0.120.0")

  const piRoot = join(home, "local Pi SDK with spaces", "node_modules", "@mariozechner", "pi-coding-agent")
  const piEntry = join(piRoot, "dist", "cli.js")
  const pi = join(pathDirectory, "pi.cmd")
  await writeCli(pi, piEntry, "0.73.1")
  await writeFile(join(piRoot, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    version: "0.73.1",
    main: "dist/index.js",
  }))
  await writeFile(join(piRoot, "dist", "index.js"), "export const local = true")

  const r = resolver()
  const claudeResult = await r.resolveEngineExecutable("claude", undefined, env)
  expect(claudeResult)
    .toMatchObject({ state: "ready", source: "path", version: "2.10.5", minimumVersion: "2.10.5" })
  expect(claudeResult.path?.toLowerCase()).toContain("path with spaces\\claude.cmd")
  const codexResult = await r.resolveEngineExecutable("codex", undefined, env)
  expect(codexResult).toMatchObject({ state: "ready", source: "path", version: "0.120.0" })
  expect(codexResult.path?.toLowerCase()).toContain("path with spaces\\codex.cmd")
  const piResult = await r.resolveEngineExecutable("pi", undefined, env)
  expect(piResult).toMatchObject({ state: "ready", source: "path", version: "0.73.1" })
  expect(piResult.path?.toLowerCase()).toContain("path with spaces\\pi.cmd")

  await writeFile(join(piRoot, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    version: "0.72.0",
    main: "dist/index.js",
  }))
  r.refreshExecutables()
  const incompatiblePi = await r.resolveEngineExecutable("pi", undefined, env)
  expect(incompatiblePi).toMatchObject({ state: "incompatible", source: "path" })
  expect(incompatiblePi.path?.toLowerCase()).toContain("path with spaces\\pi.cmd")
})

test.skipIf(process.platform !== "win32")("does not fall back to bundled Claude when external agents are required", async () => {
  const result = await resolver().resolveEngineExecutable("claude", undefined, {
    ...env,
    PATH: [join(home, "empty path"), join(home, "another empty path")].join(delimiter),
  })
  expect(result).toMatchObject({ state: "missing", minimumVersion: "2.10.5" })
})
