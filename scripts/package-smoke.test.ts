import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "..")
const artifactDir = path.join(repo, "artifacts")
const privilegedNamespace = process.env.MEMOSYNC_SMOKE_PRIVILEGED_NETNS === "1"
let fixture = ""
let consumer = ""
let runtimeEnv: Record<string, string> = {}
let logs = ""

function log(value: string) {
  const sanitized = value
    .replaceAll(fixture || "\0", "<fixture>")
    .replaceAll(repo, "<checkout>")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1<redacted>@")
    .replace(/((?:token|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,]+/gi, "$1<redacted>")
  logs = `${logs}${sanitized}\n`.slice(-64 * 1024)
}

async function command(cmd: string[], cwd: string, env: Record<string, string>, timeout: number) {
  log(`$ ${cmd.join(" ")}`)
  const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })
  let output = ""
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output = `${output}${decoder.decode(value, { stream: true })}`.slice(-16 * 1024)
      }
    } finally {
      reader.releaseLock()
    }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeout)
  try {
    const [exitCode] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)])
    log(`exit=${exitCode} timedOut=${timedOut}\n${output}`)
    if (timedOut || exitCode !== 0) throw new Error(`Package smoke command failed: ${path.basename(cmd[0])}\n${logs}`)
    return output
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}

beforeAll(async () => {
  if (privilegedNamespace) {
    expect(process.getuid!()).not.toBe(0)
    expect(process.geteuid!()).not.toBe(0)
  }
  await mkdir(artifactDir, { recursive: true })
  fixture = await mkdtemp(path.join(tmpdir(), "memosync-package-smoke-"))
  consumer = path.join(fixture, "consumer")
  const home = path.join(fixture, "home")
  const privateBin = path.join(fixture, "bin")
  for (const dir of [consumer, home, privateBin, "tmp", "config", "cache", "data"].map((dir) => path.isAbsolute(dir) ? dir : path.join(fixture, dir))) {
    await mkdir(dir, { recursive: true })
  }
  const bun = await realpath(process.execPath)
  await symlink(bun, path.join(privateBin, "bun"))
  const node = Bun.which("node")
  if (node) await symlink(await realpath(node), path.join(privateBin, "node"))
  runtimeEnv = {
    PATH: `${path.join(consumer, "node_modules", ".bin")}:${privateBin}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(fixture, "config"),
    XDG_CACHE_HOME: path.join(fixture, "cache"),
    XDG_DATA_HOME: path.join(fixture, "data"),
    TMPDIR: path.join(fixture, "tmp"),
    LANG: "C.UTF-8",
    MEMOSYNC_DISABLE_SELF_UPDATE: "1",
  }
  // Install may use the registry; only the runtime below is network-contained.
  const installEnv = { ...runtimeEnv, PATH: `${privateBin}:/usr/bin:/bin` }
  const tarball = path.join(fixture, "memosync.tgz")
  await command([bun, "pm", "pack", "--filename", tarball], repo, installEnv, 30_000)
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({
    name: "memosync-package-smoke-consumer",
    private: true,
    dependencies: { memosync: `file:${tarball}` },
  }))
  await command([bun, "install", "--production"], consumer, installEnv, 120_000)
  const installed = await realpath(path.join(consumer, "node_modules", "memosync"))
  expect(installed.startsWith(`${consumer}${path.sep}`)).toBe(true)
  const binary = Bun.which("memosync", { PATH: runtimeEnv.PATH })
  expect(binary).not.toBeNull()
  expect((await realpath(binary!)).startsWith(`${installed}${path.sep}`)).toBe(true)
  expect(Bun.which("codex", { PATH: runtimeEnv.PATH })).toBeNull()
  await copyFile(path.join(import.meta.dir, "package-smoke-runtime.ts"), path.join(consumer, "runtime.ts"))
}, 180_000)

afterAll(async () => {
  try {
    await writeFile(path.join(artifactDir, "package-smoke.log"), logs || "Package setup did not complete.\n")
  } finally {
    if (fixture) await rm(fixture, { recursive: true, force: true })
  }
})

test("installed package serves built assets across restart and rejects missing client assets", async () => {
  expect(process.platform).toBe("linux")
  const unshare = Bun.which("unshare")
  const ip = Bun.which("ip")
  expect(unshare).not.toBeNull()
  expect(ip).not.toBeNull()
  const version = (JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as { version: string }).version
  const parentNetwork = await readlink("/proc/self/ns/net")
  const uid = privilegedNamespace ? process.getuid!() : 0
  const gid = privilegedNamespace ? process.getgid!() : 0
  const runtime = [
    path.join(fixture, "bin", "bun"), path.join(consumer, "runtime.ts"), version, parentNetwork,
    String(uid), String(gid), privilegedNamespace ? "privileged" : "user",
  ]
  const namespace = ["--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL"]
  const loopback = ["/bin/sh", "-c", '"$1" link set lo up && shift && exec "$@"', "package-smoke", ip!]
  let cmd: string[]
  if (privilegedNamespace) {
    const sudo = Bun.which("sudo")
    const timeout = Bun.which("timeout")
    const setpriv = Bun.which("setpriv")
    for (const executable of [sudo, timeout, unshare, ip, setpriv]) {
      expect(executable).not.toBeNull()
      expect(path.isAbsolute(executable!)).toBe(true)
    }
    // The root-side watchdog can reap the namespace even if the test loses permission to signal it.
    cmd = [
      sudo!, "-n", timeout!, "--signal=TERM", "--kill-after=5s", "75s", unshare!, ...namespace,
      ...loopback, setpriv!, "--reuid", String(uid), "--regid", String(gid), "--clear-groups", "--no-new-privs",
      "/usr/bin/env", "-i", ...Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`), ...runtime,
    ]
  } else {
    cmd = [unshare!, "--user", "--map-root-user", ...namespace, ...loopback, ...runtime]
  }
  const output = await command(cmd, consumer, runtimeEnv, privilegedNamespace ? 90_000 : 75_000)
  expect(output).toContain("PASS missing-dist negative control")
  expect(output).toContain("PASS installed start/assets/restart")
}, 110_000)
