import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as executables from "./model-access/executables"
import { ModelAccessService } from "./model-access/service"
import { fakeExecutableResolver } from "./model-access/test-fixtures"
import * as processUtils from "./process-utils"
import { startMemoSyncServer } from "./server"

test("server awaits login-shell PATH before its first executable resolution and snapshot", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ma-shell-ready-"))
  const previousPath = process.env.PATH
  const importedPath = [previousPath, join(dataDir, "login-bin")].filter(Boolean).join(delimiter)
  let release!: () => void
  let requested!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const shellRequested = new Promise<void>(resolve => { requested = resolve })
  let ready = false
  const shell = spyOn(processUtils, "inheritShellPath").mockImplementation(async () => {
    requested()
    await gate
    process.env.PATH = importedPath
    ready = true
  })
  const resolve = spyOn(executables, "resolveEngineExecutable").mockImplementation(async (engine, setup, env) => {
    expect(ready).toBe(true)
    expect(env?.PATH).toBe(importedPath)
    return fakeExecutableResolver(engine, setup, env)
  })
  const originalSnapshot = ModelAccessService.prototype.getSnapshot
  const snapshot = spyOn(ModelAccessService.prototype, "getSnapshot").mockImplementation(function (this: ModelAccessService) {
    expect(ready).toBe(true)
    return originalSnapshot.call(this)
  })
  let started: Awaited<ReturnType<typeof startMemoSyncServer>> | undefined
  const starting = startMemoSyncServer({ dataDir, host: "127.0.0.1", port: 0, strictPort: true, discoverProjects: () => [] })
  try {
    await shellRequested
    expect(resolve).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    release()
    started = await starting
    expect(resolve.mock.calls.map(call => call[0]).sort()).toEqual(["claude", "codex", "pi"])
    expect(snapshot).toHaveBeenCalled()
  } finally {
    release()
    started ??= await starting.catch(() => undefined)
    await started?.stop()
    shell.mockRestore()
    resolve.mockRestore()
    snapshot.mockRestore()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(dataDir, { recursive: true, force: true })
  }
})
