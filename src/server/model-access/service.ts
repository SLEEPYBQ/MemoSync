import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { getDataDir, getLlmProviderFilePath } from "../../shared/branding"
import { endpointForEngine, ENGINE_PROTOCOLS, type ApiConnection, type ApiConnectionInput, type EngineId, type EngineSetup, type EngineStatus, type ModelAccessSnapshot } from "../../shared/model-access"
import type { LlmProviderSnapshot } from "../../shared/types"
import { normalizeLlmProviderSnapshot } from "../llm-provider"
import { resolveEngineExecutable } from "./executables"
import { executableEnvironment, legacyConnections, legacyEngineSetup, LEGACY_PI_ID, type RuntimeEnv } from "./legacy"
import { CONNECTION_PRESETS } from "./presets"
import { atomicJson, FileCredentialStore, readJson, type CredentialStore, type ModelAccessData } from "./storage"
import { testEndpoint } from "./test-connection"

export function connectionNeedsKey(connection: Pick<ApiConnection, "presetId" | "endpoints">) {
  return !CONNECTION_PRESETS.find(p => p.id === connection.presetId)?.noKey && !connection.endpoints.every(e => {
    try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(e.baseUrl).hostname) } catch { return false }
  })
}

function accountSignedIn(engine: EngineId, env: RuntimeEnv) {
  const home = env.HOME || homedir()
  if (engine === "pi") return false
  // Read only the CLI's sign-in metadata. Never probe Keychain or prompt for access.
  const paths = engine === "codex" ? [join(env.CODEX_HOME || join(home, ".codex"), "auth.json")]
    : [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json"), join(home, ".claude.json")]
  return paths.some(path => {
    if (!existsSync(path)) return false
    try {
      const value = readJson<Record<string, unknown>>(path, {})
      return engine === "codex" ? Boolean(value.tokens || value.OPENAI_API_KEY) : Boolean(value.claudeAiOauth || value.oauthAccount)
    } catch { return false }
  })
}

const engines: EngineId[] = ["claude", "codex", "pi"]
export function validateConnection(input: ApiConnectionInput): Omit<ApiConnection, "id" | "keySource"> {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 200 || !Array.isArray(input.endpoints) || !input.endpoints.length || !Array.isArray(input.models)) throw new Error("connection-invalid")
  const endpoints = input.endpoints.map(e => {
    if (!e || !Object.values(ENGINE_PROTOCOLS).flat().includes(e.protocol) || typeof e.baseUrl !== "string") throw new Error("connection-invalid")
    let url: URL
    try { url = new URL(e.baseUrl) } catch { throw new Error("connection-invalid") }
    // URL auth and query keys would otherwise leak through snapshots and Codex argv.
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (e.authHeader !== undefined && !["bearer", "x-api-key"].includes(e.authHeader))) throw new Error("connection-invalid")
    return { protocol: e.protocol, baseUrl: e.baseUrl.replace(/\/+$/, ""), ...(e.authHeader ? { authHeader: e.authHeader } : {}) }
  })
  if (new Set(endpoints.map(e => e.protocol)).size !== endpoints.length) throw new Error("connection-invalid")
  const models = input.models.map(m => {
    if (!m || typeof m.id !== "string" || !m.id.trim() || /[\r\n\x00]/.test(m.id)) throw new Error("connection-invalid")
    for (const n of [m.contextWindow, m.maxOutputTokens]) if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0)) throw new Error("connection-invalid")
    return { id: m.id.trim(), ...(typeof m.label === "string" ? { label: m.label } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}), ...(typeof m.supportsReasoning === "boolean" ? { supportsReasoning: m.supportsReasoning } : {}), ...(typeof m.supportsImages === "boolean" ? { supportsImages: m.supportsImages } : {}) }
  })
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== "string") throw new Error("connection-invalid")
  return { name: input.name.trim(), ...(typeof input.presetId === "string" ? { presetId: input.presetId } : {}), endpoints, models }
}

export class ModelAccessService {
  readonly dataDir: string
  readonly env: RuntimeEnv
  /** Shared by Settings snapshots and launches; production always uses real discovery. */
  readonly resolveExecutable: typeof resolveEngineExecutable
  private readonly credentials: CredentialStore
  private readonly readLegacyPi: () => Promise<LlmProviderSnapshot | null>
  private data: ModelAccessData = { version: 1, connections: [], engines: {} }
  private legacyPi: LlmProviderSnapshot | null = null
  private statuses = {} as Record<EngineId, EngineStatus>
  revision = 0
  private listeners = new Set<() => void>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(args: { dataDir?: string; env?: RuntimeEnv; credentials?: CredentialStore; readLegacyPi?: () => Promise<LlmProviderSnapshot | null>; resolveExecutable?: typeof resolveEngineExecutable } = {}) {
    this.env = args.env ?? process.env
    this.resolveExecutable = args.resolveExecutable ?? resolveEngineExecutable
    this.dataDir = args.dataDir ?? getDataDir(this.env.HOME || homedir(), this.env)
    this.credentials = args.credentials ?? new FileCredentialStore(this.dataDir)
    this.readLegacyPi = args.readLegacyPi ?? (async () => normalizeLlmProviderSnapshot(readJson(getLlmProviderFilePath(this.env.HOME || homedir(), this.env), null)))
  }
  async initialize() {
    this.data = readJson(join(this.dataDir, "model-access.json"), this.data)
    if (this.data.version !== 1 || !Array.isArray(this.data.connections) || !this.data.engines) throw new Error("model-access-storage-unreadable")
    this.data.connections = this.data.connections.map(c => ({ ...validateConnection(c), id: c.id, keySource: c.keySource === "stored" ? "stored" : "none" }))
    await this.refreshExecutables()
    return this
  }
  private async readCredential(id: string) {
    try { return await this.credentials.get(id) } catch { throw new Error("model-access-storage-unreadable") }
  }
  private async writeCredential(id: string, value: string | null) {
    try { await this.credentials.set(id, value) } catch { throw new Error("model-access-storage-write-failed") }
  }
  connections() { return [...this.data.connections, ...legacyConnections(this.env, this.legacyPi)] }
  setup(engine: EngineId) { return this.data.engines[engine] ?? legacyEngineSetup(engine, this.env, this.connections()) }
  hasExplicitSetup(engine: EngineId) { return Boolean(this.data.engines[engine]) }
  connection(id: string) { return this.connections().find(c => c.id === id) }
  async getKey(id: string) {
    const c = this.connection(id)
    if (id === LEGACY_PI_ID) return this.legacyPi?.apiKey || undefined
    return c?.keySource === "stored" ? this.readCredential(id) : c?.envKeyName ? this.env[c.envKeyName]?.trim() || undefined : undefined
  }
  getSnapshot(): ModelAccessSnapshot { return structuredClone({ connections: this.connections(), engines: this.statuses, presets: CONNECTION_PRESETS }) }
  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed() { this.revision += 1; for (const listener of this.listeners) listener() }
  private serialize<T>(fn: () => Promise<T>): Promise<T> { const next = this.pending.then(fn); this.pending = next.catch(() => {}); return next }
  private persist(data: ModelAccessData) { atomicJson(join(this.dataDir, "model-access.json"), data); this.data = data }
  saveConnection(input: ApiConnectionInput) { return this.serialize(async () => {
    const clean = validateConnection(input)
    const existing = input.id ? this.connection(input.id) : undefined
    if (existing?.readOnly || input.id?.startsWith("env-")) throw new Error("connection-read-only")
    if (input.id && !existing) throw new Error("connection-missing")
    const id = existing?.id ?? randomUUID()
    const previousKey = await this.readCredential(id)
    const key = input.apiKey === undefined ? previousKey : input.apiKey?.trim() || undefined
    const connection: ApiConnection = { ...clean, id, keySource: key ? "stored" : "none" }
    // Whitelist metadata above; unknown request fields and apiKey can never reach this file.
    await this.writeCredential(id, key ?? null)
    try { this.persist({ ...this.data, connections: [...this.data.connections.filter(c => c.id !== id), connection] }) }
    catch (error) { await this.writeCredential(id, previousKey ?? null); throw error }
    await this.refreshExecutables()
    return structuredClone(connection)
  }) }
  deleteConnection(id: string) { return this.serialize(async () => {
    if (this.connection(id)?.readOnly) throw new Error("connection-read-only")
    if (!this.connection(id)) throw new Error("connection-missing")
    // Keep engine references so deletion reports connection-missing rather than silently using an account.
    this.persist({ ...this.data, connections: this.data.connections.filter(c => c.id !== id) })
    await this.writeCredential(id, null)
    await this.refreshExecutables()
  }) }
  setEngine(engine: EngineId, setup: EngineSetup) { return this.serialize(async () => {
    if (!engines.includes(engine) || !setup?.access || !["account", "connection"].includes(setup.access.mode) || (engine === "pi" && setup.access.mode === "account")) throw new Error("engine-setup-invalid")
    if (setup.executablePath != null && typeof setup.executablePath !== "string") throw new Error("engine-setup-invalid")
    const access = setup.access.mode === "account" ? { mode: "account" as const } : { mode: "connection" as const, connectionId: setup.access.connectionId, ...(setup.access.defaultModel ? { defaultModel: setup.access.defaultModel } : {}) }
    if (access.mode === "connection") {
      const c = this.connection(access.connectionId)
      if (!c) throw new Error("connection-missing")
      if (!endpointForEngine(engine, c)) throw new Error("connection-protocol-unsupported")
      if (access.defaultModel && !c.models.some(m => m.id === access.defaultModel)) throw new Error("model-unavailable")
    }
    this.persist({ ...this.data, engines: { ...this.data.engines, [engine]: { access, ...(setup.executablePath !== undefined ? { executablePath: setup.executablePath } : {}) } } })
    await this.refreshExecutables()
  }) }
  async refreshExecutables() {
    this.legacyPi = await this.readLegacyPi().catch(() => null)
    const entries = await Promise.all(engines.map(async engine => {
      const setup = this.setup(engine)
      const executable = await this.resolveExecutable(engine, setup, executableEnvironment(this.env))
      let problem: EngineStatus["problem"]
      if (["missing", "broken", "incompatible"].includes(executable.state)) problem = `executable-${executable.state}` as EngineStatus["problem"]
      else if (setup.access.mode === "connection") {
        const c = this.connection(setup.access.connectionId)
        if (!c) problem = "connection-missing"
        else if (!endpointForEngine(engine, c)) problem = "connection-protocol-unsupported"
        else if (connectionNeedsKey(c) && !(await this.getKey(c.id))) problem = "connection-key-missing"
      } else if (engine === "pi") problem = "connection-missing"
      else if (this.env.MEMOSYNC_ISOLATE_CLI === "1" || this.env.MEMOSYNC_CLI_PROFILE_DIR || !accountSignedIn(engine, this.env)) problem = "account-signed-out"
      return [engine, { engine, setup, executable, ready: !problem, ...(problem ? { problem } : {}) }] as const
    }))
    this.statuses = Object.fromEntries(entries) as Record<EngineId, EngineStatus>
    this.changed()
    return this.getSnapshot()
  }
  async testConnection(input: ApiConnectionInput | { connectionId: string }, engine?: EngineId, model?: string) {
    const c = "connectionId" in input ? this.connection(input.connectionId) : validateConnection(input)
    if (!c) throw new Error("connection-missing")
    const endpoint = engine ? endpointForEngine(engine, c) : c.endpoints[0]
    if (!endpoint) throw new Error("connection-protocol-unsupported")
    const key = "connectionId" in input ? await this.getKey(input.connectionId) : input.apiKey === undefined && input.id ? await this.getKey(input.id) : input.apiKey ?? undefined
    return testEndpoint(endpoint, key, model || c.models[0]?.id || "")
  }
}

let active: ModelAccessService | undefined
export function setModelAccessService(service: ModelAccessService | undefined) { active = service }
export function getModelAccessService() { return active }
