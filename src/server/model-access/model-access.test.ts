import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ModelAccessService, setModelAccessService } from "./service"
import { deployedProviders, normalizeServerModel } from "../provider-catalog"
import { fakeExecutableResolver } from "./test-fixtures"
import { resolveEngineRuntime } from "./runtime"
import { legacyConnections } from "./legacy"
import { testEndpoint } from "./test-connection"
import type { ExecutableStatus } from "../../shared/model-access"
import type { UpgradeRunner } from "./upgrade"
import { createExecutableResolver } from "./resolver"
import { readSdkInstallation } from "./sdk-installation"
import type { EngineModelReader, EngineModels } from "./engine-models"

const dirs: string[] = []
function fixture(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ma-test-")); dirs.push(dir)
  return new ModelAccessService({ resolveExecutable: fakeExecutableResolver, dataDir: dir, env: { ...env, MEMOSYNC_CLI_PROFILE_DIR: join(dir, "profiles") }, readLegacyPi: async () => null })
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const input = { name: "Private", endpoints: [{ protocol: "anthropic-messages" as const, baseUrl: "https://example.test" }], models: [{ id: "large", contextWindow: 1_000_000 }] }

test("Pi executable path can be saved before choosing a connection and survives restart", async () => {
  const service = await fixture({ MEMOSYNC_EXTERNAL_AGENTS: "1" }).initialize()
  await service.setExecutablePath("pi", "/test/local Pi/bin/pi")
  expect(service.setup("pi").executablePath).toBe("/test/local Pi/bin/pi")
  expect(service.getSnapshot().engines.pi.problem).toBe("connection-missing")
  await expect(service.setEngine("pi", { access: { mode: "account" } })).rejects.toThrow("engine-setup-invalid")
  const reopened = await new ModelAccessService({ dataDir: service.dataDir, env: service.env, readLegacyPi: async () => null, resolveExecutable: fakeExecutableResolver }).initialize()
  expect(reopened.setup("pi").executablePath).toBe("/test/local Pi/bin/pi")
  const connection = await reopened.saveConnection({ name: "Local", endpoints: [{ protocol: "openai-chat", baseUrl: "http://localhost:1234/v1" }], models: [{ id: "local" }] })
  await reopened.setEngine("pi", { ...reopened.setup("pi"), access: { mode: "connection", connectionId: connection.id, defaultModel: "local" } })
  await reopened.setExecutablePath("pi", null)
  expect(reopened.setup("pi")).toEqual({ executablePath: null, access: { mode: "connection", connectionId: connection.id, defaultModel: "local" } })
})

for (const engine of ["claude", "codex", "pi"] as const) {
  for (const models of [[{ id: "remaining" }], []]) {
    test(`${engine} runtime ignores a removed default model (${models.length} remaining)`, async () => {
      const original = await fixture().initialize()
      const endpoints = [
        { protocol: "anthropic-messages" as const, baseUrl: "http://localhost:1234" },
        { protocol: "openai-responses" as const, baseUrl: "http://localhost:1234/v1" },
      ]
      const c = await original.saveConnection({ name: "Local", endpoints, models: [{ id: "removed" }, ...models] })
      await original.setEngine(engine, { access: { mode: "connection", connectionId: c.id, defaultModel: "removed" } })
      // Simulate stale persisted settings independently of saveConnection reconciliation.
      const path = join(original.dataDir, "model-access.json")
      const data = JSON.parse(readFileSync(path, "utf8"))
      data.connections[0].models = models
      writeFileSync(path, JSON.stringify(data))
      const service = await new ModelAccessService({ dataDir: original.dataDir, env: original.env, readLegacyPi: async () => null, resolveExecutable: fakeExecutableResolver }).initialize()
      if (models.length) expect((await resolveEngineRuntime({ engine, service })).model).toBe("remaining")
      else await expect(resolveEngineRuntime({ engine, service })).rejects.toThrow("model-unavailable")
    })
  }
}

test("legacy read-only Pi registry still accepts a default outside its local model list", async () => {
  const parent = fixture()
  writeFileSync(join(parent.dataDir, "model-access.json"), JSON.stringify({ version: 1, connections: [], engines: { pi: { access: { mode: "connection", connectionId: "env-llm-provider", defaultModel: "cold-catalog-model" } } } }))
  const service = await new ModelAccessService({ dataDir: parent.dataDir, env: parent.env, resolveExecutable: fakeExecutableResolver, readLegacyPi: async () => ({ provider: "custom", apiKey: "file-secret", baseUrl: "https://pi.test", resolvedBaseUrl: "https://pi.test", model: "file-model", enabled: true, warning: null, filePathDisplay: "legacy.json" }) }).initialize()
  expect((await resolveEngineRuntime({ engine: "pi", service })).model).toBe("cold-catalog-model")
})

test("saving connection models drops removed defaults for all referencing engines and persists the reconciliation", async () => {
  const service = await fixture().initialize()
  const endpoints = [
    { protocol: "anthropic-messages" as const, baseUrl: "http://localhost:1234" },
    { protocol: "openai-responses" as const, baseUrl: "http://localhost:1234/v1" },
  ]
  const c = await service.saveConnection({ name: "Shared", endpoints, models: [{ id: "removed" }, { id: "kept" }] })
  const other = await service.saveConnection({ name: "Other", endpoints, models: [{ id: "removed" }] })
  await service.setEngine("claude", { executablePath: process.execPath, access: { mode: "connection", connectionId: c.id, defaultModel: "removed" } })
  await service.setEngine("codex", { access: { mode: "connection", connectionId: c.id, defaultModel: "kept" } })
  await service.setEngine("pi", { access: { mode: "connection", connectionId: other.id, defaultModel: "removed" } })
  await service.saveConnection({ ...c, models: [{ id: "kept" }] })
  const reopened = await new ModelAccessService({ dataDir: service.dataDir, env: service.env, readLegacyPi: async () => null, resolveExecutable: fakeExecutableResolver }).initialize()
  for (const current of [service, reopened]) {
    expect(current.setup("claude")).toEqual({ executablePath: process.execPath, access: { mode: "connection", connectionId: c.id } })
    expect(current.setup("codex").access).toEqual({ mode: "connection", connectionId: c.id, defaultModel: "kept" })
    expect(current.setup("pi").access).toEqual({ mode: "connection", connectionId: other.id, defaultModel: "removed" })
  }
  // Empty model lists clear all engines referencing this connection as well.
  for (const engine of ["claude", "codex", "pi"] as const) await service.setEngine(engine, { access: { mode: "connection", connectionId: c.id, defaultModel: "kept" } })
  await service.saveConnection({ ...c, models: [] })
  for (const engine of ["claude", "codex", "pi"] as const) expect(service.setup(engine).access).toEqual({ mode: "connection", connectionId: c.id })
})

for (const failureAt of [-1, 0, 1, 2]) {
  test(`multi-protocol connection tests every endpoint and returns the first failure or success (${failureAt})`, async () => {
    const service = await fixture().initialize()
    const paths: string[] = []
    const suffixes = ["/v1/messages", "/responses", "/chat/completions"]
    const server = Bun.serve({ port: 0, fetch: req => {
      const path = new URL(req.url).pathname
      paths.push(path)
      return new Response("", { status: failureAt >= 0 && suffixes.indexOf(path) >= failureAt ? 422 : 200 })
    } })
    try {
      const protocols = ["anthropic-messages", "openai-responses", "openai-chat"] as const
      const connection = { name: "Multi", endpoints: protocols.map(protocol => ({ protocol, baseUrl: `http://127.0.0.1:${server.port}` })), models: [{ id: "tiny" }] }
      const saved = await service.saveConnection(connection)
      for (const target of [connection, { connectionId: saved.id }]) {
        paths.length = 0
        const result = await service.testConnection(target)
        expect([...paths].sort()).toEqual([...suffixes].sort())
        expect(result).toMatchObject({ ok: failureAt === -1, protocol: protocols[Math.max(0, failureAt)] })
        expect(result.latencyMs).toBeNumber()
        if (failureAt !== -1) expect(result.errorCode).toBe("model-unavailable")
        paths.length = 0
        await service.testConnection(target, "codex")
        expect(paths).toEqual(["/responses"])
      }
    } finally { server.stop(true) }
  })
}

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
  // A Codex model set for GLM in the environment is kept, not swapped for the first listed one.
  const glmModel = fixture({ MEMOSYNC_CODEX_PROVIDER: "glm", GLM_API_KEY: "g", MEMOSYNC_CODEX_MODEL: "glm-5.2" }); await glmModel.initialize()
  expect((await resolveEngineRuntime({ engine: "codex", service: glmModel })).model).toBe("glm-5.2")
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

describe("upgrading an engine's CLI", () => {
  async function fixtureWithOldPi(run: UpgradeRunner) {
    const dir = mkdtempSync(join(tmpdir(), "ma-upgrade-")); dirs.push(dir)
    const prefix = join(dir, "prefix")
    mkdirSync(join(prefix, "bin"), { recursive: true })
    writeFileSync(join(prefix, "bin/npm"), "#!/bin/sh\n", { mode: 0o755 })
    writeFileSync(join(prefix, "bin/node"), "#!/bin/sh\n", { mode: 0o755 })
    const entry = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, "#!/bin/sh\n", { mode: 0o755 })
    let installed: ExecutableStatus = { state: "incompatible", belowMinimum: true, path: entry, version: "1.2.0", minimumVersion: "1.3.0" }
    const service = await new ModelAccessService({
      dataDir: join(dir, "data"), env: { HOME: dir, PATH: "/fixture/none" }, readLegacyPi: async () => null, runUpgrade: run,
      resolveExecutable: async engine => engine === "pi" ? installed : { state: "ready", path: "/fixture/cli" },
    }).initialize()
    return { service, entry: realpathSync(entry), setInstalled: (next: ExecutableStatus) => { installed = next } }
  }

  test("the snapshot offers what would run, shows it running, then re-detects", async () => {
    let finish!: (result: { ok: boolean; output: string }) => void
    const ran: string[][] = []
    const { service, entry, setInstalled } = await fixtureWithOldPi(step => {
      ran.push(step.args)
      return new Promise(resolve => { finish = resolve })
    })
    expect(service.getSnapshot().engines.pi.executable.upgradeCommand).toBe("pi update self")
    expect(service.getSnapshot().engines.claude.executable.upgradeCommand).toBeUndefined()

    await service.upgradeExecutable("pi")
    expect(service.getSnapshot().engines.pi.upgrade).toEqual({ state: "running" })
    // A second click while it runs starts nothing.
    await service.upgradeExecutable("pi")
    expect(ran).toEqual([[entry, "update", "self"]])

    setInstalled({ state: "ready", path: "/fixture/pi", version: "1.5.0" })
    const changed = new Promise<void>(resolve => { const off = service.onChange(() => { off(); resolve() }) })
    finish({ ok: true, output: "" })
    await changed
    const pi = service.getSnapshot().engines.pi
    expect(pi.upgrade).toBeUndefined()
    expect(pi.executable).toMatchObject({ state: "ready", version: "1.5.0" })
  })

  test("a failure is reported until the next detection", async () => {
    const { service } = await fixtureWithOldPi(async () => ({ ok: false, output: "EACCES" }))
    const failed = new Promise<void>(resolve => {
      const off = service.onChange(() => {
        if (service.getSnapshot().engines.pi.upgrade?.state !== "failed") return
        off(); resolve()
      })
    })
    await service.upgradeExecutable("pi")
    await failed
    expect(service.getSnapshot().engines.pi.upgrade).toEqual({ state: "failed", detail: "pi update self\nEACCES" })
    await service.refreshExecutables()
    expect(service.getSnapshot().engines.pi.upgrade).toBeUndefined()
  })

  test("two requests at once start one upgrade", async () => {
    let finish!: (result: { ok: boolean; output: string }) => void
    let runs = 0
    const { service } = await fixtureWithOldPi(() => {
      runs += 1
      return new Promise(resolve => { finish = resolve })
    })
    await Promise.all([service.upgradeExecutable("pi"), service.upgradeExecutable("pi")])
    expect(runs).toBe(1)
    finish({ ok: true, output: "" })
  })

  test("a refused request releases the engine", async () => {
    const { service } = await fixtureWithOldPi(async () => ({ ok: true, output: "" }))
    await expect(service.upgradeExecutable("claude")).rejects.toThrow("engine-upgrade-unavailable")
    expect(service.getSnapshot().engines.claude.upgrade).toBeUndefined()
    await expect(service.upgradeExecutable("claude")).rejects.toThrow("engine-upgrade-unavailable")
  })

  // The real resolver, and a launcher that doesn't change when its release does:
  // Claude's ~/.claude/local wrapper, or Pi's installer launcher once it has been probed.
  async function fixtureWithStableLauncher(run: UpgradeRunner) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ma-upgrade-"))); dirs.push(dir)
    const version = join(dir, "version")
    writeFileSync(version, "2.0.0 (Claude Code)\n")
    const sdkDir = join(dir, "node_modules/@anthropic-ai/claude-agent-sdk")
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(join(sdkDir, "sdk.mjs"), "")
    writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ claudeCodeVersion: "2.5.0" }))
    const launcher = join(dir, ".claude/local/claude")
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(launcher, `#!/bin/sh\ncat '${version}'\n`, { mode: 0o755 })
    const resolver = createExecutableResolver({ knownDirectories: async () => [], sdkInstallation: () => readSdkInstallation(join(sdkDir, "sdk.mjs")), probeTimeoutMs: 2000 })
    const service = await new ModelAccessService({
      dataDir: join(dir, "data"), env: { HOME: dir, PATH: "/usr/bin:/bin", CLAUDE_EXECUTABLE: launcher }, readLegacyPi: async () => null,
      runUpgrade: run, resolveExecutable: resolver.resolveEngineExecutable, invalidateExecutables: resolver.refreshExecutables,
    }).initialize()
    return { service, version }
  }

  test("an upgrade behind an unchanged launcher is seen when it finishes", async () => {
    let version = ""
    const { service, version: file } = await fixtureWithStableLauncher(async () => {
      writeFileSync(version, "2.6.0 (Claude Code)\n")
      return { ok: true, output: "" }
    })
    version = file
    expect(service.getSnapshot().engines.claude.executable).toMatchObject({ state: "incompatible", version: "2.0.0", upgradeCommand: "claude update" })
    const done = new Promise<void>(resolve => {
      const off = service.onChange(() => {
        const claude = service.getSnapshot().engines.claude
        if (claude.upgrade || claude.executable.version === "2.0.0") return
        off(); resolve()
      })
    })
    await service.upgradeExecutable("claude")
    await Promise.race([done, Bun.sleep(3000)])
    expect(service.getSnapshot().engines.claude.executable).toMatchObject({ state: "ready", version: "2.6.0" })
  })

  test("Detect again sees a command the user ran by hand, while routine refreshes keep their probes", async () => {
    const { service, version } = await fixtureWithStableLauncher(async () => ({ ok: true, output: "" }))
    writeFileSync(version, "2.6.0 (Claude Code)\n")
    await service.refreshExecutables()
    expect(service.getSnapshot().engines.claude.executable.version).toBe("2.0.0")
    await service.refreshExecutables({ reprobe: true })
    expect(service.getSnapshot().engines.claude.executable).toMatchObject({ state: "ready", version: "2.6.0" })
  })

  test("an installation that can't be upgraded is refused, whatever the client asks", async () => {
    const { service } = await fixtureWithOldPi(async () => ({ ok: true, output: "" }))
    await expect(service.upgradeExecutable("claude")).rejects.toThrow("engine-upgrade-unavailable")
    await expect(service.upgradeExecutable("nope" as never)).rejects.toThrow("engine-setup-invalid")
  })
})

test("a signed-in engine lists the models it reports, and keeps them for the next launch", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memosync-engine-models-")); dirs.push(dataDir)
  const home = mkdtempSync(join(tmpdir(), "memosync-engine-models-home-")); dirs.push(home)
  mkdirSync(join(home, ".codex"))
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: {} }))
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: {} }))
  const resolveExecutable = (async () => ({ state: "ready", path: "/bin/fake", version: "1.0.0" })) as never
  const reads: string[] = []
  const service = await new ModelAccessService({
    dataDir,
    env: { HOME: home },
    resolveExecutable,
    readEngineModels: async (engine) => {
      reads.push(engine)
      return engine === "codex"
        ? { models: [{ id: "gpt-live", label: "GPT Live", supportsEffort: true }], defaultModel: "gpt-live" }
        : null
    },
  }).initialize()
  for (let tries = 0; tries < 100 && !service.accountModels("codex"); tries++) await Bun.sleep(5)
  expect(reads.sort()).toEqual(["claude", "codex"])
  expect(service.accountModels("codex")?.models.map(model => model.id)).toEqual(["gpt-live"])
  // A failed read leaves the engine on its fallback list rather than an empty one.
  expect(service.accountModels("claude")).toBeUndefined()

  setModelAccessService(service)
  try {
    const codex = deployedProviders().find(provider => provider.id === "codex")!
    expect(codex.models.map(model => model.id)).toEqual(["gpt-live"])
    expect(codex.defaultModel).toBe("gpt-live")
    expect(normalizeServerModel("codex", "gpt-5.5")).toBe("gpt-live")
    expect(deployedProviders().find(provider => provider.id === "claude")!.models.map(model => model.id)).toContain("sonnet")
  } finally { setModelAccessService(undefined) }

  const nextLaunch = await new ModelAccessService({ dataDir, env: { HOME: home }, resolveExecutable }).initialize()
  expect(nextLaunch.accountModels("codex")?.defaultModel).toBe("gpt-live")
})

test("an engine that isn't signed in isn't asked for its models", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memosync-engine-models-")); dirs.push(dataDir)
  const reads: string[] = []
  const service = await new ModelAccessService({
    dataDir,
    env: { HOME: dataDir, MEMOSYNC_ISOLATE_CLI: "1" },
    resolveExecutable: (async () => ({ state: "ready", path: "/bin/fake", version: "1.0.0" })) as never,
    readEngineModels: async (engine) => { reads.push(engine); return null },
  }).initialize()
  await Bun.sleep(20)
  expect(service.getSnapshot().engines.codex.ready).toBe(false)
  expect(reads).toEqual([])
})

describe("scoped account-model cache", () => {
  const accountEngines = ["claude", "codex"] as const
  type AccountEngine = typeof accountEngines[number]
  type PersistedCache = { version: number; engines: Record<AccountEngine, { scope: string; value: EngineModels }> }

  function catalog(engine: AccountEngine): EngineModels {
    return {
      models: [
        { id: `${engine}-reasoning`, label: `${engine} Reasoning`, resolvedModel: `${engine}-resolved`, supportsEffort: true, aliases: [`${engine}-resolved`], reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
        { id: `${engine}-fast`, label: `${engine} Fast`, supportsEffort: false, aliases: [], reasoningEfforts: [] },
      ],
      defaultModel: `${engine}-fast`,
    }
  }

  function writeAccountConfig(engine: AccountEngine, directory: string) {
    mkdirSync(directory, { recursive: true })
    if (engine === "claude") {
      writeFileSync(join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }))
      writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: {} }))
      writeFileSync(join(directory, "settings.json"), "{}")
    } else {
      writeFileSync(join(directory, "auth.json"), JSON.stringify({ tokens: {} }))
      writeFileSync(join(directory, "config.toml"), 'model = "synthetic"\n')
    }
  }

  function accountFixture() {
    const root = mkdtempSync(join(tmpdir(), "ma-account-cache-")); dirs.push(root)
    const home = join(root, "home")
    const dataDir = join(root, "data")
    mkdirSync(dataDir)
    for (const engine of accountEngines) writeAccountConfig(engine, join(home, `.${engine}`))
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: {} }))
    const executable: Record<AccountEngine, ExecutableStatus> = {
      claude: { state: "ready", path: join(root, "claude"), version: "1.0.0" },
      codex: { state: "ready", path: join(root, "codex"), version: "1.0.0" },
    }
    for (const engine of accountEngines) writeFileSync(executable[engine].path!, "synthetic executable metadata; never run\n")
    const env: Record<string, string> = { HOME: home, PATH: root }
    const open = (readEngineModels: EngineModelReader = async () => null) => new ModelAccessService({
      dataDir, env, readEngineModels, readLegacyPi: async () => null,
      resolveExecutable: async engine => engine === "pi" ? { state: "not-needed" } : engine === "opencode" ? { state: "missing" } : { ...executable[engine] },
    }).initialize()
    return { root, home, dataDir, env, executable, open, cacheFile: join(dataDir, "engine-models.json") }
  }

  // Injected readers only await promises controlled by these tests. One event-loop
  // turn drains their continuations, including publications that should be ignored.
  const settleReads = () => new Promise<void>(resolve => setImmediate(resolve))
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }
  async function seedCache(f: ReturnType<typeof accountFixture>) {
    const service = await f.open(async engine => catalog(engine))
    await settleReads()
    for (const engine of accountEngines) expect(service.accountModels(engine)).toEqual(catalog(engine))
    return service
  }
  function touchMetadata(file: string) {
    const before = statSync(file)
    utimesSync(file, before.atime, new Date(before.mtimeMs + 60_000))
  }

  test("Claude Code rewriting .claude.json keeps the model list until the account changes", async () => {
    const f = accountFixture()
    const account = (accountUuid: string, numStartups: number) => writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ numStartups, oauthAccount: { accountUuid } }))
    account("account-a", 1)
    const service = await seedCache(f)
    account("account-a", 2)
    touchMetadata(join(f.home, ".claude.json"))
    expect(service.accountModels("claude")).toEqual(catalog("claude"))
    writeFileSync(join(f.home, ".claude.json"), '{"numStartups":3,"oauth')
    expect(service.accountModels("claude")).toEqual(catalog("claude"))
    account("account-b", 3)
    expect(service.accountModels("claude")).toBeUndefined()
  })

  test("a restart restores labels, aliases, effort metadata and a non-first default even when discovery fails", async () => {
    const f = accountFixture()
    await seedCache(f)
    const persisted = readFileSync(f.cacheFile, "utf8")
    const reads: AccountEngine[] = []
    const reopened = await f.open(async engine => { reads.push(engine); throw new Error("synthetic offline discovery") })
    for (const engine of accountEngines) expect(reopened.accountModels(engine)).toEqual(catalog(engine))
    await settleReads()
    expect(reads.sort()).toEqual([...accountEngines])
    for (const engine of accountEngines) expect(reopened.accountModels(engine)).toEqual(catalog(engine))
    expect(readFileSync(f.cacheFile, "utf8")).toBe(persisted)
  })

  const invalidCaches: [string, (cache: PersistedCache) => unknown][] = [
    ["null root", () => null],
    ["obsolete unscoped format", () => ({ codex: catalog("codex") })],
    ["unsupported version", cache => ({ ...cache, version: 1 })],
    ["non-object engines", cache => ({ ...cache, engines: [] })],
    ["null engine entry", cache => { (cache.engines as Record<string, unknown>).codex = null; return cache }],
    ["non-string scope", cache => { (cache.engines.codex as unknown as Record<string, unknown>).scope = 1; return cache }],
    ["empty model list", cache => { cache.engines.codex.value.models = []; return cache }],
    ["non-array model list", cache => { (cache.engines.codex.value as unknown as Record<string, unknown>).models = {}; return cache }],
    ["null model", cache => { cache.engines.codex.value.models[0] = null as never; return cache }],
    ["blank model id", cache => { cache.engines.codex.value.models[0]!.id = " "; return cache }],
    ["control character in model id", cache => { cache.engines.codex.value.models[0]!.id = "injected\nmodel"; return cache }],
    ["missing model label", cache => { delete (cache.engines.codex.value.models[0] as unknown as Record<string, unknown>).label; return cache }],
    ["non-boolean effort support", cache => { (cache.engines.codex.value.models[0] as unknown as Record<string, unknown>).supportsEffort = "yes"; return cache }],
    ["non-string alias", cache => { cache.engines.codex.value.models[0]!.aliases = [42] as never; return cache }],
    ["non-array reasoning efforts", cache => { cache.engines.codex.value.models[0]!.reasoningEfforts = "high" as never; return cache }],
    ["invalid default effort", cache => { cache.engines.codex.value.models[0]!.defaultReasoningEffort = ""; return cache }],
    ["duplicate model ids", cache => { cache.engines.codex.value.models[1]!.id = cache.engines.codex.value.models[0]!.id; return cache }],
    ["default model absent from list", cache => { cache.engines.codex.value.defaultModel = "removed"; return cache }],
  ]
  for (const [name, corrupt] of [["malformed JSON", undefined], ...invalidCaches] as const) {
    test(`${name} in the optional cache does not block startup or rediscovery`, async () => {
      const f = accountFixture()
      await seedCache(f)
      // Start with real matching scopes so a schema regression cannot be hidden
      // by rejecting an unrelated account's otherwise valid cache.
      const persisted = JSON.parse(readFileSync(f.cacheFile, "utf8")) as PersistedCache
      writeFileSync(f.cacheFile, corrupt ? JSON.stringify(corrupt(persisted)) : '{"version":2,')
      let recover = false
      const reads: AccountEngine[] = []
      const reopened = await f.open(async engine => { reads.push(engine); return recover ? catalog(engine) : null })
      await settleReads()
      expect(reopened.getSnapshot().engines.codex.ready).toBe(true)
      expect(reopened.accountModels("codex")).toBeUndefined()
      expect(reads.sort()).toEqual([...accountEngines])
      recover = true
      await reopened.refreshExecutables()
      await settleReads()
      for (const engine of accountEngines) expect(reopened.accountModels(engine)).toEqual(catalog(engine))
      expect(JSON.parse(readFileSync(f.cacheFile, "utf8")).engines.codex.value).toEqual(catalog("codex"))
    })
  }

  for (const engine of accountEngines) {
    const configKey = engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"
    const authName = engine === "claude" ? ".credentials.json" : "auth.json"
    const changes: [string, (f: ReturnType<typeof accountFixture>) => void][] = [
      ["HOME changes while the explicit config directory stays the same", f => { f.env.HOME = join(f.root, "other-home"); mkdirSync(f.env.HOME) }],
      ["the config directory changes", f => { f.env[configKey] = join(f.root, "other-config"); writeAccountConfig(engine, f.env[configKey]!) }],
      ["auth file metadata changes with identical contents", f => { touchMetadata(join(f.home, `.${engine}`, authName)) }],
      ["the auth file is replaced with identical contents and mtime", f => {
        const file = join(f.home, `.${engine}`, authName)
        const before = statSync(file)
        const replacement = join(f.root, "replacement-auth")
        writeFileSync(replacement, readFileSync(file))
        utimesSync(replacement, before.atime, before.mtime)
        renameSync(replacement, file)
      }],
      ["the executable path changes", f => { const path = join(f.root, "replacement-cli"); writeFileSync(path, "synthetic replacement executable\n"); f.executable[engine].path = path }],
      ["the executable version changes behind a stable path", f => { f.executable[engine].version = "2.0.0" }],
      ["the executable file metadata changes", f => { touchMetadata(f.executable[engine].path!) }],
      ...(engine === "claude"
        ? [
          ["the OAuth account changes", (f: ReturnType<typeof accountFixture>) => { writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "another-account" } })) }],
          ["settings metadata changes", (f: ReturnType<typeof accountFixture>) => { touchMetadata(join(f.home, ".claude", "settings.json")) }],
        ] as [string, (f: ReturnType<typeof accountFixture>) => void][]
        : [["config metadata changes", (f: ReturnType<typeof accountFixture>) => { touchMetadata(join(f.home, ".codex", "config.toml")) }]] as [string, (f: ReturnType<typeof accountFixture>) => void][]),
    ]
    for (const [name, change] of changes) {
      test(`${engine} does not reuse the cached account catalog when ${name}`, async () => {
        const f = accountFixture()
        // Pin the config directory for the HOME case, otherwise both scope
        // components would change and a missing HOME check could go unnoticed.
        if (name.startsWith("HOME")) f.env[configKey] = join(f.home, `.${engine}`)
        await seedCache(f)
        change(f)
        const reopened = await f.open()
        await settleReads()
        expect(reopened.getSnapshot().engines[engine].ready).toBe(true)
        expect(reopened.accountModels(engine)).toBeUndefined()
        expect(JSON.parse(readFileSync(f.cacheFile, "utf8")).engines[engine]).toBeUndefined()
        if (!name.startsWith("HOME")) {
          const other = engine === "claude" ? "codex" : "claude"
          expect(reopened.accountModels(other)).toEqual(catalog(other))
        }
      })
    }

    test(`${engine} discards a discovery result if auth changes before it resolves without another refresh`, async () => {
      const f = accountFixture()
      const pending = deferred<EngineModels | null>()
      const service = await f.open(async current => current === engine ? pending.promise : null)
      const revision = service.revision
      touchMetadata(join(f.home, `.${engine}`, authName))
      pending.resolve(catalog(engine))
      await settleReads()
      expect(service.accountModels(engine)).toBeUndefined()
      expect(service.revision).toBe(revision)
      expect(existsSync(f.cacheFile)).toBe(false)
    })

    for (const staleFirst of [true, false]) {
      test(`${engine} ignores an older discovery generation resolving ${staleFirst ? "before" : "after"} its replacement`, async () => {
        const f = accountFixture()
        const older = deferred<EngineModels | null>()
        const newer = deferred<EngineModels | null>()
        let reads = 0
        const service = await f.open(async current => current !== engine ? null : ++reads === 1 ? older.promise : newer.promise)
        await service.refreshExecutables()
        expect(reads).toBe(2)
        const revision = service.revision
        const obsolete = { models: [{ id: "obsolete", label: "Obsolete", supportsEffort: false }], defaultModel: "obsolete" }
        if (staleFirst) {
          older.resolve(obsolete)
          await settleReads()
          expect(service.accountModels(engine)).toBeUndefined()
          expect(service.revision).toBe(revision)
          expect(existsSync(f.cacheFile)).toBe(false)
        }
        newer.resolve(catalog(engine))
        await settleReads()
        expect(service.accountModels(engine)).toEqual(catalog(engine))
        const persisted = readFileSync(f.cacheFile, "utf8")
        if (!staleFirst) {
          older.resolve(obsolete)
          await settleReads()
        }
        expect(service.accountModels(engine)).toEqual(catalog(engine))
        expect(service.revision).toBe(revision + 1)
        expect(readFileSync(f.cacheFile, "utf8")).toBe(persisted)
        expect(persisted).not.toContain("obsolete")
      })
    }
  }

  for (const fast of accountEngines) {
    test(`${fast} publishes, notifies and persists while the other engine is still pending`, async () => {
      const f = accountFixture()
      const slow = fast === "claude" ? "codex" : "claude"
      const pending = { claude: deferred<EngineModels | null>(), codex: deferred<EngineModels | null>() }
      const service = await f.open(engine => pending[engine].promise)
      const publications: string[][] = []
      const off = service.onChange(() => { publications.push(accountEngines.filter(engine => Boolean(service.accountModels(engine)))) })
      try {
        pending[fast].resolve(catalog(fast))
        await settleReads()
        expect(service.accountModels(fast)).toEqual(catalog(fast))
        expect(service.accountModels(slow)).toBeUndefined()
        expect(publications).toEqual([[fast]])
        const intermediate = JSON.parse(readFileSync(f.cacheFile, "utf8"))
        expect(intermediate.engines[fast].value).toEqual(catalog(fast))
        expect(intermediate.engines[slow]).toBeUndefined()
        const reopened = await f.open()
        expect(reopened.accountModels(fast)).toEqual(catalog(fast))
        expect(reopened.accountModels(slow)).toBeUndefined()
        pending[slow].resolve(catalog(slow))
        await settleReads()
        for (const engine of accountEngines) {
          expect(service.accountModels(engine)).toEqual(catalog(engine))
          expect(JSON.parse(readFileSync(f.cacheFile, "utf8")).engines[engine].value).toEqual(catalog(engine))
        }
        expect(publications).toEqual([[fast], [...accountEngines]])
      } finally { off() }
    })
  }
})
