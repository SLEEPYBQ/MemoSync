import { afterEach, describe, expect, test } from "bun:test"
import { createInterface } from "node:readline"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { delimiter, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { findBundledAgentPackages } from "./runtime-packages"

const runtimeDir = resolve(import.meta.dir, "build/runtime")
const runtimeExecutable = process.platform === "win32" ? "bun.exe" : "bun"
const active: ChildProcessWithoutNullStreams[] = []

interface RunningServer {
  child: ChildProcessWithoutNullStreams
  origin: string
  output: () => string
}

function testEnvironment(home: string) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"
  const systemPath = process.platform === "win32"
    ? [join(systemRoot, "System32"), systemRoot]
    : ["/usr/bin", "/bin"]
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: [runtimeDir, ...systemPath].join(delimiter),
    USER: "memosync-test",
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    LANG: "en_US.UTF-8",
    NO_PROXY: "*",
    MEMOSYNC_EXTERNAL_AGENTS: "1",
    MEMOSYNC_RUNTIME_PROFILE: "prod",
    MEMOSYNC_USAGE_LOG: "0",
  }
}

async function createHome() {
  const root = await mkdtemp(join(tmpdir(), "memosync desktop smoke "))
  const home = join(root, "home")
  await mkdir(home)
  return { root, home, dataDir: join(root, "data") }
}

async function startServer(home: string, dataDir: string): Promise<RunningServer> {
  const child = spawn(join(runtimeDir, runtimeExecutable), [join(runtimeDir, "desktop/server.ts")], {
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
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
})

describe("staged desktop backend", () => {
  test("stages Bun without Claude, Codex or Pi agent packages", async () => {
    expect(await stat(join(runtimeDir, runtimeExecutable))).toBeTruthy()
    expect(await findBundledAgentPackages(join(runtimeDir, "node_modules"))).toEqual([])
    if (process.platform === "win32") await expect(stat(join(runtimeDir, "bun"))).rejects.toThrow()
    await expect(stat(join(runtimeDir, "node_modules", ".bin"))).rejects.toThrow()
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
    expect(await status.json()).toMatchObject({ authenticated: true, canSignOut: false })
    const logout = await fetch(`${server.origin}/auth/logout`, {
      method: "POST",
      headers: { Origin: server.origin, Cookie: cookie ?? "" },
    })
    expect(logout.status).toBe(403)
    expect(logout.headers.get("set-cookie")).toBeNull()
    await stopServer(server.child)
    await rm(root, { recursive: true, force: true })
  })

  test("parent EOF shuts down cleanly and data can be relaunched", async () => {
    const { root, home, dataDir } = await createHome()
    const first = await startServer(home, dataDir)
    await stopServer(first.child)
    const settingsPath = join(dataDir, "settings.json")
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
    settings.theme = "dark"
    await writeFile(settingsPath, JSON.stringify(settings))

    const second = await startServer(home, dataDir)
    await stopServer(second.child)
    expect((JSON.parse(await readFile(settingsPath, "utf8")) as { theme?: string }).theme).toBe("dark")
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
    const conflict = spawn(join(runtimeDir, runtimeExecutable), [join(runtimeDir, "desktop/server.ts")], {
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
