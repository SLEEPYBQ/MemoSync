import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelAccessService } from "./service"
import { fakeExecutableResolver } from "./test-fixtures"
import { resolveEngineRuntime } from "./runtime"
import { legacyConnections } from "./legacy"
import { testEndpoint } from "./test-connection"
import type { ExecutableStatus } from "../../shared/model-access"

const dirs: string[] = []
function fixture(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ma-test-")); dirs.push(dir)
  return new ModelAccessService({ resolveExecutable: fakeExecutableResolver, dataDir: dir, env: { ...env, MEMOSYNC_CLI_PROFILE_DIR: join(dir, "profiles") }, readLegacyPi: async () => null })
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const input = { name: "Private", endpoints: [{ protocol: "anthropic-messages" as const, baseUrl: "https://example.test" }], models: [{ id: "large", contextWindow: 1_000_000 }] }

test("snapshots and runtime use the same injected resolver, including fresh failures", async () => {
  const parent = fixture()
  let status: ExecutableStatus = { state: "ready", path: "/test/selected-claude", source: "configured" }
  const calls: unknown[] = []
  const env = { HOME: parent.dataDir, PATH: "/test/login-shell", ANTHROPIC_API_KEY: "test-key" }
  const service = await new ModelAccessService({ dataDir: parent.dataDir, env, readLegacyPi: async () => null,
    resolveExecutable: async (engine, setup, base) => {
      if (engine !== "claude") return fakeExecutableResolver(engine, setup, base)
      calls.push([setup, base])
      return { ...status }
    },
  }).initialize()
  await service.setEngine("claude", { executablePath: "/test/selected-claude", access: { mode: "connection", connectionId: "env-anthropic" } })
  const snapshot = service.getSnapshot().engines.claude
  const runtime = await resolveEngineRuntime({ engine: "claude", service })
  expect(snapshot.ready).toBe(true)
  expect(runtime.executable).toEqual(snapshot.executable)
  expect(calls.at(-1)).toEqual(calls.at(-2))
  expect(calls.at(-1)).toEqual([service.setup("claude"), { HOME: env.HOME, PATH: env.PATH }])
  for (const state of ["broken", "missing", "incompatible"] as const) {
    status = { ...status, state }
    // Launches re-check discovery even before Settings is refreshed.
    await expect(resolveEngineRuntime({ engine: "claude", service })).rejects.toThrow(`executable-${state}`)
    await service.refreshExecutables()
    expect(service.getSnapshot().engines.claude).toMatchObject({ ready: false, problem: `executable-${state}`, executable: status })
  }
})

test("the default service resolver rejects a nonexistent explicitly configured CLI", async () => {
  const parent = fixture()
  const service = await new ModelAccessService({ dataDir: parent.dataDir, env: { HOME: parent.dataDir, PATH: parent.dataDir }, readLegacyPi: async () => null }).initialize()
  await service.setEngine("codex", { executablePath: join(parent.dataDir, "absent-codex"), access: { mode: "account" } })
  expect(service.getSnapshot().engines.codex).toMatchObject({ ready: false, problem: "executable-broken" })
  await expect(resolveEngineRuntime({ engine: "codex", service })).rejects.toThrow("executable-broken")
})

test("storage keeps secrets separate, atomic and private, preserving keys on metadata edits", async () => {
  const service = fixture(); await service.initialize()
  const saved = await service.saveConnection({ ...input, apiKey: "sentinel-secret" })
  expect(JSON.stringify(service.getSnapshot())).not.toContain("sentinel-secret")
  expect(readFileSync(join(service.dataDir, "model-access.json"), "utf8")).not.toContain("sentinel-secret")
  expect(statSync(join(service.dataDir, "credentials.json")).mode & 0o777).toBe(0o600)
  await service.saveConnection({ ...input, id: saved.id, name: "Renamed" })
  expect(await service.getKey(saved.id)).toBe("sentinel-secret")
  expect(readdirSync(service.dataDir).some(name => name.endsWith(".tmp"))).toBe(false)
  await service.saveConnection({ ...input, id: saved.id, apiKey: null })
  expect(await service.getKey(saved.id)).toBeUndefined()
})

test("connection runtime clears bypass auth, isolates, maps context and never puts a key in argv", async () => {
  const service = fixture({ CLAUDE_CODE_USE_BEDROCK: "1", OPENAI_API_KEY: "other-secret", ANTHROPIC_AUTH_TOKEN: "stale" }); await service.initialize()
  const c = await service.saveConnection({ ...input, apiKey: "chosen-secret" })
  const runtime = await resolveEngineRuntime({ engine: "claude", connectionId: c.id, model: "large", service })
  expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBe("chosen-secret")
  expect(runtime.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(runtime.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  expect(runtime.env.OPENAI_API_KEY).toBeUndefined()
  expect(runtime.model).toBe("large[1m]")
  expect(runtime.isolated).toBe(true)
  expect(JSON.stringify(runtime.args)).not.toContain("chosen-secret")
  await expect(resolveEngineRuntime({ engine: "codex", connectionId: c.id, service })).rejects.toThrow("connection-protocol-unsupported")
})

test("legacy env connections preserve per-vendor endpoints and are read only", () => {
  const connections = legacyConnections({ DEEPSEEK_API_KEY: "d", DEEPSEEK_BASE_URL: "https://d.test", GLM_API_KEY: "g", GLM_BASE_URL: "https://g.test", GLM_CODEX_BASE_URL: "https://r.test", OPENROUTER_API_KEY: "o" })
  expect(connections.find(c => c.id === "env-deepseek")?.endpoints[0]?.baseUrl).toBe("https://d.test/anthropic")
  expect(connections.find(c => c.id === "env-glm")?.endpoints.some(e => e.baseUrl === "https://r.test")).toBe(true)
  expect(connections.every(c => c.readOnly)).toBe(true)
  expect(JSON.stringify(connections)).not.toContain('"apiKey"')
})

for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat"] as const) {
  test(`probe ${protocol} uses a minimal request and sanitizes provider errors`, async () => {
    const paths: string[] = []
    const server = Bun.serve({ port: 0, fetch: async req => {
      paths.push(new URL(req.url).pathname)
      const body = await req.json() as { model: string }; expect(body.model).toBe("tiny")
      return Response.json({ error: { message: "echo secret-value" } }, { status: 401 })
    } })
    try {
      const result = await testEndpoint({ protocol, baseUrl: `http://127.0.0.1:${server.port}` }, "secret-value", "tiny")
      expect(result.errorCode).toBe("unauthorized")
      expect(JSON.stringify(result)).not.toContain("secret-value")
      expect(paths[0]).toBe(protocol === "anthropic-messages" ? "/v1/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions")
      expect(paths.length).toBe(protocol === "anthropic-messages" ? 2 : 1)
    } finally { server.stop(true) }
  })
}

test("credentials survive restart and concurrent saves without metadata leakage", async () => {
  const service = fixture(); await service.initialize()
  const saved = await Promise.all(["one", "two", "three"].map(name => service.saveConnection({ ...input, name, apiKey: `key-${name}` })))
  const reopened = await new ModelAccessService({ resolveExecutable: fakeExecutableResolver, dataDir: service.dataDir, env: service.env, readLegacyPi: async () => null }).initialize()
  expect(reopened.getSnapshot().connections).toHaveLength(3)
  for (const c of saved) expect(await reopened.getKey(c.id)).toBe(`key-${c.name}`)
  expect(JSON.stringify(reopened.getSnapshot())).not.toContain("key-one")
})

test("deleting a selected connection fails closed and removes its credential", async () => {
  const service = fixture(); await service.initialize()
  const c = await service.saveConnection({ ...input, apiKey: "erase-me" })
  await service.setEngine("claude", { access: { mode: "connection", connectionId: c.id, defaultModel: "large" } })
  expect(service.getSnapshot().engines.claude.ready).toBe(true)
  await service.deleteConnection(c.id)
  expect(service.getSnapshot().engines.claude.problem).toBe("connection-missing")
  expect(readFileSync(join(service.dataDir, "credentials.json"), "utf8")).not.toContain("erase-me")
  await expect(resolveEngineRuntime({ engine: "claude", service })).rejects.toThrow("connection-missing")
})

test("remote keys are required while local endpoints can run without a key", async () => {
  const service = fixture(); await service.initialize()
  const remote = await service.saveConnection(input)
  await service.setEngine("claude", { access: { mode: "connection", connectionId: remote.id } })
  expect(service.getSnapshot().engines.claude.problem).toBe("connection-key-missing")
  await expect(resolveEngineRuntime({ engine: "claude", service })).rejects.toThrow("connection-key-missing")
  const local = await service.saveConnection({ ...input, endpoints: [{ protocol: "openai-responses", baseUrl: "http://127.0.0.1:1234/v1" }] })
  const runtime = await resolveEngineRuntime({ engine: "codex", connectionId: local.id, service })
  expect(runtime.args.join(" ")).not.toContain("env_key")
  expect(runtime.isolated).toBe(true)
})

test("validation rejects credentials in URLs and never persists extra request fields", async () => {
  const service = fixture(); await service.initialize()
  for (const baseUrl of ["https://user:secret@example.test", "https://example.test?key=secret", "file:///tmp/secret"]) {
    await expect(service.saveConnection({ ...input, endpoints: [{ protocol: "anthropic-messages", baseUrl }] })).rejects.toThrow("connection-invalid")
  }
  const c = await service.saveConnection({ ...input, apiKey: "keep-private", extra: "keep-private" } as never)
  expect(JSON.stringify(c)).not.toContain("keep-private")
  expect(readFileSync(join(service.dataDir, "model-access.json"), "utf8")).not.toContain("keep-private")
})

test("account modes use own profiles without vendor injection and isolated account mode refuses", async () => {
  const isolated = fixture(); await isolated.initialize()
  for (const engine of ["claude", "codex"] as const) await expect(resolveEngineRuntime({ engine, service: isolated })).rejects.toThrow("account-signed-out")
  const service = await new ModelAccessService({ resolveExecutable: fakeExecutableResolver, dataDir: isolated.dataDir, env: { HOME: isolated.dataDir, CLAUDE_CONFIG_DIR: "/own/claude", CODEX_HOME: "/own/codex", ANTHROPIC_API_KEY: "ambient", DEEPSEEK_API_KEY: "ambient-d" }, readLegacyPi: async () => null }).initialize()
  for (const engine of ["claude", "codex"] as const) {
    await service.setEngine(engine, { access: { mode: "account" }, executablePath: process.execPath })
    const r = await resolveEngineRuntime({ engine, service })
    expect(r.isolated).toBe(false)
    expect(r.executable.path).toBe(process.execPath)
    expect(r.env.CLAUDE_CONFIG_DIR).toBe("/own/claude")
    expect(r.env.CODEX_HOME).toBe("/own/codex")
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(r.env.DEEPSEEK_API_KEY).toBeUndefined()
  }
  expect(service.getSnapshot().engines.claude.problem).toBe("account-signed-out")
  await expect(service.setEngine("pi", { access: { mode: "account" } })).rejects.toThrow("engine-setup-invalid")
})

for (const engine of ["claude", "codex", "pi"] as const) {
  test(`${engine} explicit chat connection overrides default and inherited runtime survives key changes`, async () => {
    const service = fixture(); await service.initialize()
    const endpoints = [{ protocol: "anthropic-messages" as const, baseUrl: "https://a.test", authHeader: "x-api-key" as const }, { protocol: "openai-responses" as const, baseUrl: "https://a.test/v1" }]
    const a = await service.saveConnection({ ...input, endpoints, apiKey: "key-a" })
    const b = await service.saveConnection({ ...input, name: "B", endpoints: endpoints.map(e => ({ ...e, baseUrl: e.baseUrl.replace("a.test", "b.test") })), apiKey: "key-b" })
    await service.setEngine(engine, { access: { mode: "connection", connectionId: a.id }, executablePath: process.execPath })
    const r = await resolveEngineRuntime({ engine, model: "large", connectionId: b.id, service })
    expect(r.connectionId).toBe(b.id)
    if (engine === "claude") { expect(r.env.ANTHROPIC_API_KEY).toBe("key-b"); expect(r.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined() }
    if (engine === "codex") { expect(r.env.MEMOSYNC_MODEL_API_KEY).toBe("key-b"); expect(r.args.join(" ")).toContain('wire_api="responses"'); expect(r.args.join(" ")).not.toContain("key-b") }
    if (engine === "pi") { expect(r.piConnection?.protocol).toBe("openai-responses"); expect(r.piConnection?.apiKey).toBe("key-b") }
    await service.saveConnection({ ...input, endpoints, id: b.id, apiKey: "changed-key" })
    expect(await resolveEngineRuntime({ engine, inherited: r, service })).toBe(r)
    const next = await resolveEngineRuntime({ engine, connectionId: b.id, service })
    expect(JSON.stringify(next)).toContain("changed-key")
  })
}

test("legacy own Anthropic, custom Codex, GLM and Pi defaults resolve independently", async () => {
  const service = fixture({ MEMOSYNC_USE_OWN_ANTHROPIC: "1", ANTHROPIC_BASE_URL: "https://own.test", ANTHROPIC_API_KEY: "own", ANTHROPIC_MODEL: "own-model", DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g", GLM_BASE_URL: "https://glm.test", GLM_CODEX_BASE_URL: "https://glm-responses.test", MEMOSYNC_CODEX_API_KEY: "c", MEMOSYNC_CODEX_BASE_URL: "https://codex.test", MEMOSYNC_CODEX_MODEL: "code-model", OPENROUTER_API_KEY: "p" })
  await service.initialize()
  expect((await resolveEngineRuntime({ engine: "claude", model: "deepseek-v4-flash", service })).env.ANTHROPIC_API_KEY).toBe("own")
  expect((await resolveEngineRuntime({ engine: "claude", model: "glm-5.3-flash", service })).env.ANTHROPIC_BASE_URL).toBe("https://glm.test")
  const codex = await resolveEngineRuntime({ engine: "codex", service }); expect(codex.model).toBe("code-model"); expect(codex.args.join(" ")).toContain("https://codex.test")
  expect((await resolveEngineRuntime({ engine: "pi", model: "custom/model", service })).model).toBe("custom/model")
  expect(service.getSnapshot().connections.every(c => c.readOnly)).toBe(true)
  await expect(service.deleteConnection("env-glm")).rejects.toThrow("connection-read-only")
  await expect(service.saveConnection({ ...input, id: "env-glm" })).rejects.toThrow("connection-read-only")
  const glm = fixture({ MEMOSYNC_CODEX_PROVIDER: "glm", GLM_API_KEY: "g", GLM_CODEX_BASE_URL: "https://glm-code.test", GLM_MODEL: "glm-5.3", MEMOSYNC_CODEX_API_KEY: "ignored" }); await glm.initialize()
  expect((await resolveEngineRuntime({ engine: "codex", service: glm })).args.join(" ")).toContain("https://glm-code.test")
  expect((await resolveEngineRuntime({ engine: "codex", service: glm })).model).toBe("glm-5.3")
  const own = fixture({ MEMOSYNC_USE_OWN_ANTHROPIC: "1", ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_MODEL: "own", ANTHROPIC_DEFAULT_HAIKU_MODEL: "cheap" }); await own.initialize()
  const ownRuntime = await resolveEngineRuntime({ engine: "claude", service: own })
  expect(ownRuntime.env.ANTHROPIC_AUTH_TOKEN).toBe("token")
  expect(ownRuntime.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("cheap")
  const missing = fixture({ DEEPSEEK_API_KEY: "only-deepseek" }); await missing.initialize()
  await expect(resolveEngineRuntime({ engine: "claude", model: "glm-5.3", service: missing })).rejects.toThrow("connection-missing")
})

test("legacy Pi file is read only, has no secret snapshot, and wins over the env fallback", async () => {
  const parent = fixture()
  const service = await new ModelAccessService({ resolveExecutable: fakeExecutableResolver, dataDir: parent.dataDir, env: { HOME: parent.dataDir, OPENROUTER_API_KEY: "fallback" }, readLegacyPi: async () => ({ provider: "custom", apiKey: "file-secret", baseUrl: "https://pi.test", resolvedBaseUrl: "https://pi.test", model: "file-model", enabled: true, warning: null, filePathDisplay: "legacy.json" }) }).initialize()
  expect(service.setup("pi").access).toMatchObject({ connectionId: "env-llm-provider" })
  expect(JSON.stringify(service.getSnapshot())).not.toContain("file-secret")
  expect((await resolveEngineRuntime({ engine: "pi", service })).piConnection?.apiKey).toBe("file-secret")
})

for (const status of [200, 404, 422, 500]) {
  test(`connection test maps HTTP ${status} without returning response details`, async () => {
    let requests = 0
    const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response("untrusted provider detail", { status }) } })
    try {
      const result = await testEndpoint({ protocol: "openai-responses", baseUrl: `http://127.0.0.1:${server.port}` }, "key", "small")
      expect(requests).toBe(1)
      expect(result.latencyMs).toBeNumber()
      expect(result.ok).toBe(status === 200)
      expect(result.errorCode).toBe(status === 200 ? undefined : status === 404 ? "not-found" : status === 422 ? "model-unavailable" : "unknown")
      expect(result.message).toBeUndefined()
    } finally { server.stop(true) }
  })
}

test("Anthropic auth fallback retries with x-api-key and succeeds", async () => {
  const seen: string[] = []
  const server = Bun.serve({ port: 0, fetch: req => { seen.push(req.headers.get("authorization") || req.headers.get("x-api-key") || "none"); return new Response("", { status: req.headers.has("x-api-key") ? 200 : 401 }) } })
  try { expect((await testEndpoint({ protocol: "anthropic-messages", baseUrl: `http://127.0.0.1:${server.port}` }, "probe-key", "small")).ok).toBe(true); expect(seen).toEqual(["Bearer probe-key", "probe-key"]) }
  finally { server.stop(true) }
})
