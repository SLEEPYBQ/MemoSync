import assert from "node:assert/strict"
import { readFile, readlink, realpath, rename } from "node:fs/promises"
import path from "node:path"

const [expectedVersion, parentNetwork, expectedUid, expectedGid, namespaceMode] = process.argv.slice(2)
assert.equal(process.geteuid!(), Number(expectedUid), "Runtime must use the expected effective UID")
assert.equal(process.getegid!(), Number(expectedGid), "Runtime must use the expected effective GID")
const status = await readFile("/proc/self/status", "utf8")
if (namespaceMode === "privileged") {
  assert.notEqual(process.geteuid!(), 0, "Privileged namespace must drop root before running the helper")
  assert.match(status, /^NoNewPrivs:\s+1$/m, "Runtime must not gain privileges")
  assert.match(status, /^CapEff:\s+0+$/m, "Runtime must have no effective capabilities")
} else {
  assert.equal(namespaceMode, "user")
}
console.log(`PASS runtime identity: uid=${process.geteuid!()} gid=${process.getegid!()} mode=${namespaceMode} ${status.match(/^NoNewPrivs:.*$/m)?.[0]} ${status.match(/^CapEff:.*$/m)?.[0]}`)
const consumer = process.cwd()
const installed = path.join(consumer, "node_modules", "memosync")
const binary = Bun.which("memosync")
assert(binary, "Installed memosync must resolve on the consumer PATH")
assert((await realpath(binary)).startsWith(`${consumer}${path.sep}`), "Executable escaped the consumer")
assert.equal(Bun.which("codex"), null, "Optional Codex must be absent")
assert.notEqual(await readlink("/proc/self/ns/net"), parentNetwork, "Runtime must have a private network namespace")
assert.equal((await readFile("/proc/net/route", "utf8")).trim().split("\n").length, 1, "Runtime must have no external IPv4 routes")
assert.deepEqual((await readFile("/proc/net/dev", "utf8")).trim().split("\n").slice(2).map((line) => line.split(":")[0].trim()), ["lo"], "Runtime must have only a loopback interface")
await assert.rejects(Bun.connect({ hostname: "192.0.2.1", port: 9, socket: { data() {} } }), (error: unknown) => {
  return error instanceof Error && "code" in error && ["ENETUNREACH", "ECONNREFUSED"].includes(String(error.code))
})
console.log("PASS private network namespace: external transport unavailable")

interface Running {
  child: ReturnType<typeof Bun.spawn>
  drained: Promise<unknown>
  output: () => string
  ready: Promise<string>
}

function launch(args: string[]): Running {
  const child = Bun.spawn([binary!, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
  let output = ""
  let resolveReady!: (url: string) => void
  const ready = new Promise<string>((resolve) => { resolveReady = resolve })
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output = `${output}${decoder.decode(value, { stream: true })}`.slice(-16 * 1024)
        const listening = output.match(/\[memosync\] listening on (http:\/\/127\.0\.0\.1:(\d+))/i)
        if (listening && Number(listening[2]) > 0) resolveReady(listening[1])
      }
    } finally {
      reader.releaseLock()
    }
  }
  return { child, ready, output: () => output, drained: Promise.all([drain(child.stdout), drain(child.stderr)]) }
}

async function bounded<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message())), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

async function stop(running: Running) {
  try {
    if (running.child.exitCode === null) running.child.kill("SIGTERM")
    await bounded(running.child.exited, 5_000, () => `Shutdown timed out\n${running.output()}`)
    await bounded(running.drained, 2_000, () => "Child output pipes remained open after supervisor exit")
  } finally {
    if (running.child.exitCode === null) running.child.kill("SIGKILL")
    await running.child.exited
    console.log(`child exit=${running.child.exitCode}\n${running.output()}`)
  }
}

async function start() {
  const running = launch(["--no-open", "--port", "0"])
  try {
    const url = await bounded(Promise.race([
      running.ready,
      running.child.exited.then((code) => { throw new Error(`Exited before readiness (${code})\n${running.output()}`) }),
    ]), 12_000, () => `Readiness timed out\n${running.output()}`)
    return { running, url }
  } catch (error) {
    await stop(running)
    throw error
  }
}

async function validateAssets(base: string) {
  const response = await fetch(base, { signal: AbortSignal.timeout(3_000) })
  assert.equal(response.status, 200, "App HTML must return 200")
  assert.match(response.headers.get("content-type") || "", /text\/html/i)
  const html = await response.text()
  assert.match(html, /id=["']root["']/)
  const js = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1])
  const css = [...html.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["']/gi)].map((match) => match[1])
  assert(js.length > 0, "Built JavaScript must be linked")
  assert(css.length > 0, "Built CSS must be linked")
  for (const [kind, urls] of [["js", js], ["css", css]] as const) {
    for (const value of urls) {
      const url = new URL(value, base)
      assert.equal(url.origin, base, "Built assets must be served by the installed app")
      const asset = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      assert.equal(asset.status, 200, `${kind} asset status`)
      assert.match(asset.headers.get("content-type") || "", kind === "js" ? /(?:javascript|ecmascript)/i : /text\/css/i)
      const body = await asset.text()
      assert(body.trim().length > 0, `${kind} asset must not be empty`)
      assert.doesNotMatch(body, /^\s*(?:<!doctype\s+html|<html)/i, `${kind} asset must not be an HTML fallback`)
    }
  }
}

const version = launch(["--version"])
try {
  assert.equal(await bounded(version.child.exited, 10_000, () => `Version timed out\n${version.output()}`), 0)
  await version.drained
  assert.equal(version.output().trim(), expectedVersion)
} finally {
  await stop(version)
}

const client = path.join(installed, "dist", "client")
const hiddenClient = `${client}.negative-control`
await rename(client, hiddenClient)
try {
  const { running, url } = await start()
  try {
    await assert.rejects(validateAssets(url), /App HTML must return 200/)
    console.log("PASS missing-dist negative control")
  } finally {
    await stop(running)
  }
} finally {
  await rename(hiddenClient, client)
}

for (let attempt = 0; attempt < 2; attempt++) {
  const { running, url } = await start()
  try {
    await validateAssets(url)
  } finally {
    await stop(running)
  }
  await assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) }), "Stopped server must not accept requests")
}
console.log("PASS installed start/assets/restart")
