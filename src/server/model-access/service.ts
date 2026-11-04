import { existsSync, realpathSync, statSync } from "node:fs"
import { probeOpencodeAccount, type OpencodeAccountResult } from "./opencode-account"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { getDataDir, getLlmProviderFilePath } from "../../shared/branding"
import { connectionSupport, compatibleEndpointForEngine, ENGINE_PROTOCOLS, type ApiConnection, type ApiConnectionInput, type EngineId, type EngineSetup, type EngineStatus, type ModelAccessSnapshot } from "../../shared/model-access"
import type { LlmProviderSnapshot } from "../../shared/types"
import { normalizeLlmProviderSnapshot } from "../llm-provider"
import { refreshExecutables as invalidateExecutableProbes, resolveEngineExecutable } from "./executables"
import { cleanConnectionEnv, executableEnvironment, legacyConnections, legacyEngineSetup, LEGACY_PI_ID, type RuntimeEnv } from "./legacy"
import { CONNECTION_PRESETS } from "./presets"
import { atomicJson, FileCredentialStore, readJson, type CredentialStore, type ModelAccessData } from "./storage"
import { testEndpoint } from "./test-connection"
import type { EngineModelReader, EngineModels } from "./engine-models"
import { runUpgradePlan, upgradePlan, type UpgradePlan, type UpgradeRunner } from "./upgrade"

export function connectionNeedsKey(connection: Pick<ApiConnection, "presetId" | "endpoints">) {
  return !CONNECTION_PRESETS.find(p => p.id === connection.presetId)?.noKey && !connection.endpoints.every(e => {
    try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(e.baseUrl).hostname) } catch { return false }
  })
}

function accountSignedIn(engine: EngineId, env: RuntimeEnv) {
  const home = env.HOME || homedir()
  if (engine === "pi") return false
  // Read only the CLI's sign-in metadata. Never probe Keychain or prompt for access.
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude")
  // A custom CLAUDE_CONFIG_DIR moves .claude.json along with the credentials.
  const paths = engine === "codex" ? [join(env.CODEX_HOME || join(home, ".codex"), "auth.json")]
    : [join(claudeDir, ".credentials.json"), env.CLAUDE_CONFIG_DIR ? join(claudeDir, ".claude.json") : join(home, ".claude.json")]
  return paths.some(path => {
    if (!existsSync(path)) return false
    try {
      const value = readJson<Record<string, unknown>>(path, {})
      return engine === "codex" ? Boolean(value.tokens || value.OPENAI_API_KEY) : Boolean(value.claudeAiOauth || value.oauthAccount)
    } catch { return false }
  })
}

type AccountEngine = "claude" | "codex"
type EngineModelCache = Partial<Record<AccountEngine, { scope: string; value: EngineModels }>>
const accountEngines = ["claude", "codex"] as const
const ENGINE_MODEL_CACHE_VERSION = 2

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function modelString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !/[\r\n\x00]/.test(value)
}
function modelStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(modelString)
}
/** Cache input is untrusted. Restore only the fields emitted by engine discovery. */
function validatedEngineModels(value: unknown): EngineModels | undefined {
  if (!record(value) || !Array.isArray(value.models) || !value.models.length || value.models.length > 5000) return
  const models: EngineModels["models"] = []
  for (const model of value.models) {
    if (!record(model) || !modelString(model.id) || !modelString(model.label) || typeof model.supportsEffort !== "boolean") return
    if (model.resolvedModel !== undefined && !modelString(model.resolvedModel)) return
    if (model.aliases !== undefined && !modelStrings(model.aliases)) return
    if (model.reasoningEfforts !== undefined && !modelStrings(model.reasoningEfforts)) return
    if (model.defaultReasoningEffort !== undefined && !modelString(model.defaultReasoningEffort)) return
    models.push({
      id: model.id, label: model.label, supportsEffort: model.supportsEffort,
      ...(model.resolvedModel !== undefined ? { resolvedModel: model.resolvedModel as string } : {}),
      ...(model.aliases !== undefined ? { aliases: [...model.aliases as string[]] } : {}),
      ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: [...model.reasoningEfforts as string[]] } : {}),
      ...(model.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: model.defaultReasoningEffort as string } : {}),
    })
  }
  if (new Set(models.map(model => model.id)).size !== models.length) return
  if (value.defaultModel !== undefined && (!modelString(value.defaultModel) || !models.some(model => model.id === value.defaultModel))) return
  return { models, ...(value.defaultModel !== undefined ? { defaultModel: value.defaultModel as string } : {}) }
}
function readEngineModelCache(file: string): EngineModelCache {
  try {
    const cache = readJson<unknown>(file, null)
    if (!record(cache) || cache.version !== ENGINE_MODEL_CACHE_VERSION || !record(cache.engines)) return {}
    const entries: EngineModelCache = {}
    for (const engine of accountEngines) {
      const entry = cache.engines[engine]
      if (entry === undefined) continue
      if (!record(entry) || typeof entry.scope !== "string" || entry.scope.length > 100_000) return {}
      const value = validatedEngineModels(entry.value)
      if (!value) return {}
      entries[engine] = { scope: entry.scope, value }
    }
    return entries
  } catch { return {} /* A corrupt optional cache must never block service startup. */ }
}
/** Only metadata is inspected: never read or hash login/config contents for cache identity. */
function fileSignature(file: string): unknown[] | undefined {
  const path = resolve(file)
  try {
    const stat = statSync(path, { bigint: true })
    return [path, realpathSync(path), ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [path, "missing"] : undefined
  }
}

const engines: EngineId[] = ["claude", "codex", "pi", "opencode"]
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
  private readonly upgrades = new Map<EngineId, NonNullable<EngineStatus["upgrade"]>>()
  private readonly runUpgrade?: UpgradeRunner
  private readonly invalidateExecutables: () => void
  private readonly readEngineModels?: EngineModelReader
  /** From the engines themselves; kept on disk so the first paint of a launch already has them. */
  private engineModels: EngineModelCache = {}
  private engineModelsRead = 0
  revision = 0
  private listeners = new Set<() => void>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(args: { readEngineModels?: EngineModelReader; dataDir?: string; env?: RuntimeEnv; credentials?: CredentialStore; readLegacyPi?: () => Promise<LlmProviderSnapshot | null>; runUpgrade?: UpgradeRunner; invalidateExecutables?: () => void; resolveExecutable?: typeof resolveEngineExecutable } = {}) {
    this.env = args.env ?? process.env
    this.resolveExecutable = args.resolveExecutable ?? resolveEngineExecutable
    this.runUpgrade = args.runUpgrade
    this.invalidateExecutables = args.invalidateExecutables ?? invalidateExecutableProbes
    this.readEngineModels = args.readEngineModels
    this.dataDir = args.dataDir ?? getDataDir(this.env.HOME || homedir(), this.env)
    this.credentials = args.credentials ?? new FileCredentialStore(this.dataDir)
    this.readLegacyPi = args.readLegacyPi ?? (async () => normalizeLlmProviderSnapshot(readJson(getLlmProviderFilePath(this.env.HOME || homedir(), this.env), null)))
  }
  async initialize() {
    this.data = readJson(join(this.dataDir, "model-access.json"), this.data)
    if (this.data.version !== 1 || !Array.isArray(this.data.connections) || !this.data.engines) throw new Error("model-access-storage-unreadable")
    this.data.connections = this.data.connections.map(c => ({ ...validateConnection(c), id: c.id, keySource: c.keySource === "stored" ? "stored" : "none" }))
    this.engineModels = readEngineModelCache(join(this.dataDir, "engine-models.json"))
    await this.refreshExecutables()
    return this
  }
  private accountModelScope(engine: AccountEngine): string | undefined {
    const status = this.statuses[engine]
    if (!status?.ready || status.setup.access.mode !== "account" || !status.executable.path) return
    const home = resolve(this.env.HOME || homedir())
    const directory = resolve(engine === "claude" ? this.env.CLAUDE_CONFIG_DIR || join(home, ".claude") : this.env.CODEX_HOME || join(home, ".codex"))
    const files = engine === "claude"
      ? [join(directory, ".credentials.json"), this.env.CLAUDE_CONFIG_DIR ? join(directory, ".claude.json") : join(home, ".claude.json"), join(directory, "settings.json")]
      : [join(directory, "auth.json"), join(directory, "config.toml")]
    const signatures = [status.executable.path, ...files].map(fileSignature)
    if (signatures.some(signature => signature === undefined)) return
    return JSON.stringify([engine, home, directory, status.executable.version, signatures])
  }
  /** A cached account list is valid only for the installation and sign-in that produced it. */
  accountModels(engine: EngineId): EngineModels | undefined {
    if (engine !== "claude" && engine !== "codex") return
    const cached = this.engineModels[engine]
    return cached && cached.scope === this.accountModelScope(engine) ? cached.value : undefined
  }
  private persistEngineModels() {
    try { atomicJson(join(this.dataDir, "engine-models.json"), { version: ENGINE_MODEL_CACHE_VERSION, engines: this.engineModels }) } catch { /* Optional cache: next launch reads the CLI again. */ }
  }
  /** Each engine publishes independently; failures keep only a matching account's old list. */
  private async refreshEngineModels(run: number) {
    if (!this.readEngineModels) return
    await Promise.all(accountEngines.map(async engine => {
      const scope = this.accountModelScope(engine)
      const path = this.statuses[engine]?.executable.path
      if (!scope || !path) return
      try {
        const env = cleanConnectionEnv(this.env)
        if (this.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = this.env.CLAUDE_CONFIG_DIR
        if (this.env.CODEX_HOME) env.CODEX_HOME = this.env.CODEX_HOME
        const value = validatedEngineModels(await this.readEngineModels!(engine, path, executableEnvironment(env)))
        if (!value || run !== this.engineModelsRead || scope !== this.accountModelScope(engine)) return
        const entry = { scope, value }
        if (JSON.stringify(entry) === JSON.stringify(this.engineModels[engine])) return
        this.engineModels[engine] = entry
        this.persistEngineModels()
        this.changed()
      } catch { /* Discovery is optional; readiness and existing conversations still work. */ }
    }))
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
    const reconciledEngines = { ...this.data.engines }
    for (const engine of engines) {
      const setup = reconciledEngines[engine]
      if (!setup) continue
      const access = setup.access
      if (access.mode === "connection" && access.connectionId === id && access.defaultModel && !connection.models.some(m => m.id === access.defaultModel)) {
        const { defaultModel: _, ...nextAccess } = access
        reconciledEngines[engine] = { ...setup, access: nextAccess }
      }
    }
    // Whitelist metadata above; unknown request fields and apiKey can never reach this file.
    await this.writeCredential(id, key ?? null)
    try { this.persist({ ...this.data, connections: [...this.data.connections.filter(c => c.id !== id), connection], engines: reconciledEngines }) }
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
  setExecutablePath(engine: EngineId, executablePath: string | null) { return this.serialize(async () => {
    if (!engines.includes(engine) || (executablePath !== null && typeof executablePath !== "string")) throw new Error("engine-setup-invalid")
    const setup = { ...this.setup(engine), executablePath }
    this.persist({ ...this.data, engines: { ...this.data.engines, [engine]: setup } })
    await this.refreshExecutables()
  }) }
  setEngine(engine: EngineId, setup: EngineSetup) { return this.serialize(async () => {
    if (!engines.includes(engine) || !setup?.access || !["account", "connection"].includes(setup.access.mode) || (engine === "pi" && setup.access.mode === "account")) throw new Error("engine-setup-invalid")
    if (setup.executablePath != null && typeof setup.executablePath !== "string") throw new Error("engine-setup-invalid")
    const access = setup.access.mode === "account" ? { mode: "account" as const } : { mode: "connection" as const, connectionId: setup.access.connectionId, ...(setup.access.defaultModel ? { defaultModel: setup.access.defaultModel } : {}) }
    if (access.mode === "connection") {
      const c = this.connection(access.connectionId)
      if (!c) throw new Error("connection-missing")
      if (!compatibleEndpointForEngine(engine, c)) throw new Error("connection-protocol-unsupported")
      if (access.defaultModel && !c.models.some(m => m.id === access.defaultModel)) throw new Error("model-unavailable")
    }
    this.persist({ ...this.data, engines: { ...this.data.engines, [engine]: { access, ...(setup.executablePath !== undefined ? { executablePath: setup.executablePath } : {}) } } })
    await this.refreshExecutables()
  }) }
  /**
   * Upgrades outlast a command's acknowledgement, so this only starts one and
   * the snapshot reports how it goes. The client only names the engine: what
   * runs is decided here, from the installation that was actually found.
   */
  async upgradeExecutable(engine: EngineId) {
    if (!engines.includes(engine)) throw new Error("engine-setup-invalid")
    if (this.upgrades.get(engine)?.state === "running") return
    // Claimed before the first await: two tabs can ask at once, and two package
    // managers working on one install can leave it missing.
    this.upgrades.set(engine, { state: "running" })
    const env = executableEnvironment(this.env)
    const upgrade = await upgradePlan(engine, this.statuses[engine].executable, env).catch(() => undefined)
    if (!upgrade) {
      this.clearUpgrade(engine)
      throw new Error("engine-upgrade-unavailable")
    }
    this.setUpgrade(engine, { state: "running" })
    void this.finishUpgrade(engine, upgrade, env)
  }
  private async finishUpgrade(engine: EngineId, upgrade: UpgradePlan, env: ReturnType<typeof executableEnvironment>) {
    const result = await runUpgradePlan(upgrade, env, this.runUpgrade)
      .catch(error => ({ ok: false as const, detail: error instanceof Error ? error.message : String(error) }))
    this.clearUpgrade(engine)
    // A launcher can stay byte-identical while the release behind it changes.
    await this.refreshExecutables({ reprobe: true }).catch(() => this.changed())
    if (!result.ok) this.setUpgrade(engine, { state: "failed", detail: result.detail })
  }
  private clearUpgrade(engine: EngineId) {
    this.upgrades.delete(engine)
    const { upgrade: _cleared, ...status } = this.statuses[engine]
    this.statuses = { ...this.statuses, [engine]: status }
  }
  private setUpgrade(engine: EngineId, upgrade: NonNullable<EngineStatus["upgrade"]>) {
    this.upgrades.set(engine, upgrade)
    this.statuses = { ...this.statuses, [engine]: { ...this.statuses[engine], upgrade } }
    this.changed()
  }
  /** `reprobe` is for when the installation may have changed: an upgrade, or the user asking to look again. */
  async refreshExecutables(options: { reprobe?: boolean } = {}) {
    const run = ++this.engineModelsRead
    if (options.reprobe) this.invalidateExecutables()
    this.legacyPi = await this.readLegacyPi().catch(() => null)
    // A failure stays on screen until the next look at the installation.
    for (const [engine, upgrade] of this.upgrades) if (upgrade.state === "failed") this.upgrades.delete(engine)
    const entries = await Promise.all(engines.map(async engine => {
      const setup = this.setup(engine)
      const env = executableEnvironment(this.env)
      const found = await this.resolveExecutable(engine, setup, env)
      const upgradeCommand = found.belowMinimum ? (await upgradePlan(engine, found, env).catch(() => undefined))?.display : undefined
      const executable = upgradeCommand ? { ...found, upgradeCommand } : found
      const upgrade = this.upgrades.get(engine)
      const connection = setup.access.mode === "connection" ? this.connection(setup.access.connectionId) : undefined
      const translated = connection && connectionSupport(engine, connection) === "translated"
      let problem: EngineStatus["problem"]
      if (["missing", "broken", "incompatible"].includes(executable.state)) problem = `executable-${executable.state}` as EngineStatus["problem"]
      else if (setup.access.mode === "connection") {
        const c = this.connection(setup.access.connectionId)
        if (!c) problem = "connection-missing"
        else if (!compatibleEndpointForEngine(engine, c)) problem = "connection-protocol-unsupported"
        else if (connectionNeedsKey(c) && !(await this.getKey(c.id))) problem = "connection-key-missing"
      } else if (engine === "pi") problem = "connection-missing"
      const accountIsolated = setup.access.mode === "account" && engine !== "pi" && Boolean(this.env.MEMOSYNC_ISOLATE_CLI === "1" || this.env.MEMOSYNC_CLI_PROFILE_DIR)
      let account: OpencodeAccountResult | undefined
      if (!problem && setup.access.mode === "account" && engine !== "pi") {
        if (accountIsolated) problem = "account-signed-out"
        else if (engine === "opencode") { account = await probeOpencodeAccount(executable.path!, this.env); problem = account.problem }
        else if (!accountSignedIn(engine, this.env)) problem = "account-signed-out"
      }
      return [engine, { engine, setup, executable, ready: !problem, ...account, ...(translated ? { translated: true } : {}), ...(problem ? { problem } : {}), ...(accountIsolated && problem === "account-signed-out" ? { accountIsolated: true } : {}), ...(upgrade ? { upgrade } : {}) }] as const
    }))
    if (run !== this.engineModelsRead) return this.getSnapshot()
    this.statuses = Object.fromEntries(entries) as Record<EngineId, EngineStatus>
    let invalidated = false
    for (const engine of accountEngines) {
      if (this.engineModels[engine] && this.engineModels[engine]!.scope !== this.accountModelScope(engine)) {
        delete this.engineModels[engine]
        invalidated = true
      }
    }
    if (invalidated) this.persistEngineModels()
    this.changed()
    void this.refreshEngineModels(run)
    return this.getSnapshot()
  }
  async testConnection(input: ApiConnectionInput | { connectionId: string }, engine?: EngineId, model?: string) {
    const c = "connectionId" in input ? this.connection(input.connectionId) : validateConnection(input)
    if (!c) throw new Error("connection-missing")
    const endpoint = engine ? compatibleEndpointForEngine(engine, c) : undefined
    const endpoints = engine ? (endpoint ? [endpoint] : []) : c.endpoints
    if (!endpoints.length) throw new Error("connection-protocol-unsupported")
    const key = "connectionId" in input ? await this.getKey(input.connectionId) : input.apiKey === undefined && input.id ? await this.getKey(input.id) : input.apiKey ?? undefined
    const results = await Promise.all(endpoints.map(endpoint => testEndpoint(endpoint, key, model || c.models[0]?.id || "")))
    return results.find(result => !result.ok) ?? results[0]!
  }
}

let active: ModelAccessService | undefined
export function setModelAccessService(service: ModelAccessService | undefined) { active = service }
export function getModelAccessService() { return active }
