// Optional live smoke: bundled Claude Code -> loopback gateway -> fake Chat upstream.
// Run with: bun scripts/smoke-protocol-gateway.ts (no real keys or user profiles).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelAccessService } from "../src/server/model-access/service"
import { resolveEngineRuntime } from "../src/server/model-access/runtime"
import { stopGateway } from "../src/server/model-access/gateway"
import { readSdkInstallation } from "../src/server/model-access/sdk-installation"

const scratch = mkdtempSync(join(tmpdir(), "memosync-gateway-cli-"))
let requests = 0
const executable = readSdkInstallation().bundledPaths[0]
if (!executable) throw new Error("Bundled CLI unavailable")
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.headers.get("authorization") !== "Bearer fake-upstream-only") return new Response(null, { status: 401 })
  const body = await req.json()
  if (!body.stream || !Array.isArray(body.messages)) return new Response(null, { status: 400 })
  requests++
  const chunks = [
    { id: "fake", choices: [{ index: 0, delta: { content: "GATEWAY_SMOKE_OK" } }] },
    { id: "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
try {
  const service = await new ModelAccessService({ dataDir: join(scratch, "data"), env: { HOME: scratch, PATH: process.env.PATH, MEMOSYNC_ISOLATE_CLI: "1" }, readLegacyPi: async () => null, resolveExecutable: async () => ({ state: "ready", path: executable, source: "bundled" }) }).initialize()
  const c = await service.saveConnection({ name: "Fake smoke upstream", apiKey: "fake-upstream-only", endpoints: [{ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1` }], models: [{ id: "gateway-smoke-model" }] })
  const runtime = await resolveEngineRuntime({ engine: "claude", connectionId: c.id, service })
  if (JSON.stringify(runtime.env).includes("fake-upstream-only")) throw new Error("Upstream key leaked")
  const child = Bun.spawn([executable, "--print", "--model", runtime.model, "--output-format", "json", "--tools", "", "--permission-mode", "dontAsk", "--setting-sources", "", "--disable-slash-commands", "Reply with GATEWAY_SMOKE_OK."], { cwd: scratch, env: runtime.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const passed = code === 0 && requests > 0 && stdout.includes('"result":"GATEWAY_SMOKE_OK"')
    console.log(JSON.stringify({ passed, exitCode: code, requests, isolated: runtime.isolated, executable, stdout, stderr }, null, 2))
    if (!passed) process.exitCode = 1
  } finally { clearTimeout(timer) }
} finally { stopGateway(); upstream.stop(true); rmSync(scratch, { recursive: true, force: true }) }
