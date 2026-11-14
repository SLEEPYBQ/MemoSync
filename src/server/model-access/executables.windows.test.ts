import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { knownInstallDirectories } from "./discovery-paths"
import { createExecutableResolver } from "./resolver"
import { findWindowsEditor } from "../external-open"

test.skipIf(process.platform !== "win32")("discovers Windows npm globals and launches npm shims without shell interpretation", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "memosync CLI 中文 & spaces-")))
  try {
    const appData = path.join(root, "AppData", "Roaming")
    const prefix = path.join(appData, "npm")
    const entry = path.join(prefix, "node_modules", "synthetic-cli", "cli.js")
    await mkdir(path.dirname(entry), { recursive: true })
    await writeFile(entry, "console.log(process.argv.includes('--version') ? '2.1.241' : 'app-server help')")
    const env = { ...process.env, PATH: "", Path: "", HOME: root, USERPROFILE: root, APPDATA: appData, NPM_CONFIG_PREFIX: prefix }
    const known = await knownInstallDirectories(env, [], process.execPath)
    expect(known).toContain(prefix)
    expect(known).not.toContain(path.join(prefix, "bin"))
    for (const reference of ['%dp0%\\', '%~dp0']) {
      await writeFile(path.join(prefix, "codex.cmd"), `@echo off\r\n"node" "${reference}node_modules\\synthetic-cli\\cli.js" %*\r\n`)
      const resolver = createExecutableResolver({ knownDirectories: async () => known })
      const result = await resolver.resolveEngineExecutable("codex", undefined, env)
      expect(result).toMatchObject({ state: "ready", version: "2.1.241", source: "known-dir" })
      expect(result.path).toBe(path.join(prefix, "codex.cmd"))
    }
    const editor = path.join(root, "Programs", "Microsoft VS Code", "Code.exe")
    await mkdir(path.dirname(editor), { recursive: true })
    await writeFile(editor, "synthetic executable location only")
    expect(findWindowsEditor("vscode", { PATH: "", LOCALAPPDATA: root })).toBe(editor)
  } finally { await rm(root, { recursive: true, force: true }) }
})
