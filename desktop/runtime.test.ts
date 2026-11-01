import { afterEach, describe, expect, test } from "bun:test"
import { createInterface } from "node:readline"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { once } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { delimiter, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { findBundledAgentPackages } from "./runtime-packages"

const runtimeDir = resolve(import.meta.dir, "build/runtime")
const active: ChildProcessWithoutNullStreams[] = []

interface RunningServer {
  child: ChildProcessWithoutNullStreams
  origin: string
  output: () => string
}

function testEnvironment(home: string) {
  return {
    HOME: home,
    PATH: [runtimeDir, "/usr/bin", "/bin"].join(delimiter),
    USER: "memosync-test",
    TMPDIR: home,
    LANG: "en_US.UTF-8",
    NO_PROXY: "*",
    MEMOSYNC_EXTERNAL_AGENTS: "1",
    MEMOSYNC_RUNTIME_PROFILE: "prod",
    MEMOSYNC_USAGE_LOG: "0",
  }
}

async function createHome() {
  const root = await mkdtemp(join(tmpdir(), "memosync-desktop-smoke-"))
  const home = join(root, "home")
  await mkdir(home)
  return { root, home, dataDir: join(root, "data") }
}

async function startServer(home: string, dataDir: string): Promise<RunningServer> {
  const child = spawn(join(runtimeDir, "bun"), [join(runtimeDir, "desktop/server.ts")], {
    cwd: home,
    env: testEnvironment(home),
    stdio: ["pipe", "pipe", "pipe"],
  })
  active.push(child)
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk.toString() })
  child.stderr.on("data", (chunk) => { output += chunk.toString() })
  const lines = createInterface({ input: child.stdout })
  child.stdin.write(`${JSON.stringify({ type: "start", password: "desktop-smoke-password-012345678901234567890123", dataDir })}\n`)
  const origin = await new Promise<string>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Backend readiness timed out:\n${output}`)), 30_000)
    const fail = (error: Error) => {
      clearTimeout(timeout)
      reject(new Error(`${error.message}\n${output}`))
    }
    child.once("error", fail)
    child.once("exit", (code, signal) => {
      fail(new Error(`Backend exited before readiness (${signal ?? `code ${code}`})`))
    })
    lines.on("line", (line) => {
      if (!line.startsWith("MEMOSYNC_DESKTOP_READY:")) return
      try {
        const port = (JSON.parse(line.slice("MEMOSYNC_DESKTOP_READY:".length)) as { port?: unknown }).port
        if (typeof port !== "number") throw new Error("Invalid readiness port")
        clearTimeout(timeout)
        resolveReady(`http://127.0.0.1:${port}`)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  return { child, origin, output: () => output }
}

async function stopServer(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin.end()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Backend did not stop after stdin EOF")), 15_000)
    }),
  ])
  await stopped
  if (timer) clearTimeout(timer)
}

afterEach(async () => {
  for (const child of active.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})

describe("staged desktop backend", () => {
  test("stages Bun without Claude, Codex or Pi agent packages", async () => {
    expect(await stat(join(runtimeDir, "bun"))).toBeTruthy()
    expect(await findBundledAgentPackages(join(runtimeDir, "node_modules"))).toEqual([])
    await expect(stat(join(runtimeDir, "src/server/auth.test.ts"))).rejects.toThrow()
    await expect(stat(join(runtimeDir, "src/server/fixtures"))).rejects.toThrow()
  })

  test("starts on an ephemeral loopback port and protects API routes", async () => {
    const { root, home, dataDir } = await createHome()
    const server = await startServer(home, dataDir)
    const unauthorized = await fetch(`${server.origin}/api/providers`, {
      headers: { Origin: server.origin },
    })
    expect(unauthorized.status).toBe(401)

    const password = "desktop-smoke-password-012345678901234567890123"
    const login = await fetch(`${server.origin}/auth/login`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0]
    expect(cookie).toBeTruthy()
    const status = await fetch(`${server.origin}/auth/status`, {
      headers: { Origin: server.origin, Cookie: cookie ?? "" },
    })
    expect((await status.json()) as { authenticated?: boolean }).toMatchObject({ authenticated: true })
    await stopServer(server.child)
    await rm(root, { recursive: true, force: true })
  })

  test("parent EOF shuts down cleanly and data can be relaunched", async () => {
    const { root, home, dataDir } = await createHome()
    const first = await startServer(home, dataDir)
    await stopServer(first.child)
    expect(await stat(join(dataDir, "settings.json"))).toBeTruthy()

    const second = await startServer(home, dataDir)
    await stopServer(second.child)
    await rm(root, { recursive: true, force: true })
  })

  test("rejects a second startup command after runtime is initialized", async () => {
    const { root, home, dataDir } = await createHome()
    const server = await startServer(home, dataDir)
    server.child.stdin.write(`${JSON.stringify({ type: "start", password: "desktop-smoke-password-012345678901234567890123", dataDir })}\n`)
    const [code] = await once(server.child, "exit") as [number | null, string | null]
    expect({ code, output: server.output() }).toMatchObject({ code: 1 })
    expect(server.output()).toContain("Invalid desktop startup message")
    await rm(root, { recursive: true, force: true })
  })

  test("rejects a second process using the same data directory", async () => {
    const firstContext = await createHome()
    const secondContext = await createHome()
    const first = await startServer(firstContext.home, firstContext.dataDir)
    const conflict = spawn(join(runtimeDir, "bun"), [join(runtimeDir, "desktop/server.ts")], {
      cwd: secondContext.home,
      env: testEnvironment(secondContext.home),
      stdio: ["pipe", "pipe", "pipe"],
    })
    active.push(conflict)
    let output = ""
    conflict.stdout.on("data", (chunk) => { output += chunk.toString() })
    conflict.stderr.on("data", (chunk) => { output += chunk.toString() })
    conflict.stdin.write(`${JSON.stringify({ type: "start", password: "desktop-smoke-password-012345678901234567890123", dataDir: firstContext.dataDir })}\n`)
    conflict.stdin.end()
    const [code] = await once(conflict, "exit") as [number | null, string | null]
    expect({ code, output }).toMatchObject({ code: 1 })
    expect(output).toContain("already using data directory")
    await stopServer(first.child)
    await rm(firstContext.root, { recursive: true, force: true })
    await rm(secondContext.root, { recursive: true, force: true })
  })
})
