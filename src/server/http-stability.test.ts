import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LOG_PREFIX } from "../shared/branding"
import { startMemoSyncServer } from "./server"

test("server uses a 60 second idle timeout and logs escaped request errors without exposing them", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-http-stability-"))
  const originalServe = Bun.serve
  let idleTimeout: number | undefined
  const serve = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    idleTimeout = options.idleTimeout
    return originalServe(options)
  }) as typeof Bun.serve)
  const log = spyOn(console, "error").mockImplementation(() => {})
  let started: Awaited<ReturnType<typeof startMemoSyncServer>> | undefined
  try {
    started = await startMemoSyncServer({ dataDir, host: "127.0.0.1", port: 0, strictPort: true, discoverProjects: () => [] })
    const failure = new Error("private storage failure")
    const listProjects = spyOn(started.store, "listProjects").mockImplementation(() => { throw failure })
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/projects`)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: "Internal server error", uiText: { code: "internalServerError" } })
      expect(log).toHaveBeenCalledWith(`${LOG_PREFIX} http handler error:`, failure)
      expect(idleTimeout).toBe(60)
    } finally { listProjects.mockRestore() }
    expect((await fetch(`http://127.0.0.1:${started.port}/health`)).status).toBe(200)
  } finally {
    serve.mockRestore()
    log.mockRestore()
    await started?.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("CLI logs an unhandled rejection with the existing prefix and stays alive", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "memosync-cli-rejection-"))
  try {
    const cli = new URL("./cli.ts", import.meta.url).pathname
    const runtime = new URL("./cli-runtime.ts", import.meta.url).pathname
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test"
      const actual = await import(${JSON.stringify(runtime)})
      mock.module(${JSON.stringify(runtime)}, () => ({
        ...actual,
        fetchLatestPackageVersion() {}, installPackageVersion() {}, openUrl() {},
        runCli: async () => {
          Promise.reject(new Error("test escaped rejection"))
          setTimeout(() => { console.log("still alive"); process.exit(0) }, 25)
          return await new Promise(() => {})
        },
      }))
      await import(${JSON.stringify(cli)})
    `], {
      env: { ...process.env, HOME: home, MEMOSYNC_ISOLATE_CLI: "1" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exit, stderr).toBe(0)
    expect(stdout).toContain("still alive")
    expect(stderr).toContain(`${LOG_PREFIX} unhandled rejection:`)
    expect(stderr).toContain("test escaped rejection")
  } finally { await rm(home, { recursive: true, force: true }) }
})
