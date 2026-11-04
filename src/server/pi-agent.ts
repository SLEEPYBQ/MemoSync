import type { PiParentLaunch } from './memory/parent-launch'
import { createPiCommandRuntime } from './native-command-drivers'
import type { NativeCommandRuntime } from './command-registry'
import { createHash } from 'node:crypto'
import { resolveEngineRuntime } from "./model-access/runtime"
import { getModelAccessService } from "./model-access/service"
import { resolveEngineExecutable } from "./model-access/executables"
import { executableEnvironment } from "./model-access/legacy"
import { readPiInstallation } from "./model-access/pi-installation"
import { pathToFileURL } from "node:url"
import { existsSync } from "node:fs"
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent"
import { homedir } from "node:os"
import path from "node:path"
import type {
  DefaultResourceLoader,
  ModelRuntime,
  AgentSession,
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { CredentialStore, Model, ThinkingLevelMap } from "@earendil-works/pi-ai"
import { resolvePiEffort, toPiThinkingLevel, type RegistryModelCard } from "../shared/model-capabilities"
import { loadRegistryModels, type RegistryModelLoader } from "./registry-models"
import type {
  ContextWindowUsageSnapshot,
  LlmProviderKind,
  PiReasoningEffort,
  TranscriptEntry,
} from "../shared/types"
import { getDataRootDir } from "../shared/branding"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { OPENROUTER_BASE_URL } from "./llm-provider"
import type { MemoryToolResult, MemoryToolSpec } from "./memory/tools"
import { toPiToolDefinitions } from "./memory/pi-adapter"

/**
 * Adapter for the pi coding agent (@earendil-works/pi-coding-agent 1.x), driven
 * in-process through its SDK. Desktop loads the SDK from a discovered local
 * Pi installation; the CLI/web distribution retains its package dependency.
 *
 * This is deliberately an opinionated setup:
 *   - Pi connects through MemoSync's Model Registry (the OpenAI-compatible
 *     connection in Settings): OpenRouter, OpenAI, or any custom base URL.
 *     OPENROUTER_API_KEY is the env fallback when no registry is configured.
 *   - Any model id works: ids known to pi's catalog (for OpenRouter/OpenAI
 *     connections) resolve with full metadata, unknown ids get a synthesized
 *     OpenAI-completions model definition against the registry base URL.
 *   - Reasoning uses pi's standardized thinking levels
 *     (off/minimal/low/medium/high/xhigh).
 *   - The user's local Pi configuration (~/.pi) is never read: state lives under
 *     MemoSync's data root and credentials stay in memory. Markdown resources
 *     are still discovered from MemoSync's agentDir and the project, but
 *     extension and theme discovery stays disabled (extensions are arbitrary
 *     in-process code).
 *   - MemoSync memory tools are registered as pi custom tools when the policy
 *     enables them; each turn re-binds the dispatch context (project/session/
 *     turn) through the session's mutable invoker.
 *
 * Pi's built-in tool set (read, bash, edit, write, grep, find, ls) is mapped
 * one-to-one onto MemoSync's normalized tools via Claude-style names
 * (Read, Bash, Edit, Write, Grep, Glob), so everything renders natively.
 */

/**
 * The pi SDK is loaded on first use, not at import time. Its module graph
 * pulls several vendor SDK clients and is expensive to evaluate — paid on
 * every boot by users who only ever pick Claude. Both call sites are async.
 */
let piSdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | null = null
let piSdkVersion = '1.5.0' // Exact bundled dependency; external SDK provenance is resolved below.
async function loadPiSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  if (process.env.MEMOSYNC_EXTERNAL_AGENTS !== "1") {
    piSdkVersion = '1.5.0'
    return (piSdkPromise ??= import("@earendil-works/pi-coding-agent"))
  }
  const service = getModelAccessService()
  const env = executableEnvironment(service?.env ?? process.env)
  const executable = await (service?.resolveExecutable ?? resolveEngineExecutable)("pi", service?.setup("pi"), env)
  if (executable.state !== "ready" || !executable.path) throw new Error(executable.detail ?? "Install Pi before using this engine")
  const installation = await readPiInstallation(executable.path, env)
  piSdkVersion = installation.version
  return import(pathToFileURL(installation.entry).href)
}

export const PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const

/** Claude-style tool names surfaced in system_init for the UI. */
const PI_DISPLAY_TOOL_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
}

// Pi bash otherwise inherits the MemoSync server process.env: a model on an
// arbitrary registry endpoint could read provider keys with `env`. Scrub
// credential-looking variables while keeping ordinary shell usability. The
// AUTH keyword excludes AUTHOR so git identity vars (GIT_AUTHOR_NAME) and
// XAUTHORITY survive; this is best-effort — the shell shares the server's
// user account, so procfs and credential files stay readable regardless.
const PI_SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH(?!OR)|COOKIE|CERT|PEM|PRIVATE|SIGNING|APIKEY/i
const PI_SECRET_ENV_VALUE = /^(sk|pk|ghp|gho|ghu|ghs|ghr|glpat|xox[baprs]|AIza|ya29)[-_A-Za-z0-9.]{10,}$/

export function scrubPiShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (PI_SECRET_ENV_NAME.test(name) || PI_SECRET_ENV_VALUE.test(value)) continue
    clean[name] = value
  }
  return clean
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  push(value: T) {
    if (this.done) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
      return
    }
    this.values.push(value)
  }

  finish() {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Compare JSON definitions, never Zod internals or dispatch function identities. */
function definitionJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item)
}

/**
 * Translate a pi tool call into the Claude-style tool name + snake_case input
 * that `normalizeToolCall` understands. Every one of pi's seven built-in tools
 * maps onto an existing MemoSync tool kind:
 *
 *   read  → Read (read_file)      bash → Bash (bash)
 *   edit  → Edit (edit_file)      write → Write (write_file)
 *   grep  → Grep (grep)           find → Glob (glob)
 *   ls    → Glob (glob, `<path>/*` pattern)
 */
export function translatePiTool(
  rawName: string,
  args: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } {
  switch (rawName) {
    case "read":
      return {
        toolName: "Read",
        input: { file_path: args.path ?? "", offset: args.offset, limit: args.limit },
      }
    case "bash":
      return {
        toolName: "Bash",
        input: {
          command: args.command ?? "",
          // pi's bash timeout is in seconds; MemoSync's normalized input is ms.
          timeout: typeof args.timeout === "number" ? args.timeout * 1000 : undefined,
        },
      }
    case "edit": {
      // pi's edit applies a list of {oldText, newText} replacements in one call.
      // MemoSync's edit_file renders a single old/new pair, so multi-edit calls
      // are joined — each replacement still shows as its own hunk in the diff.
      const edits = Array.isArray(args.edits) ? args.edits.map(asRecord) : []
      return {
        toolName: "Edit",
        input: {
          file_path: args.path ?? "",
          old_string: edits.map((edit) => edit.oldText ?? "").join("\n"),
          new_string: edits.map((edit) => edit.newText ?? "").join("\n"),
        },
      }
    }
    case "write":
      return {
        toolName: "Write",
        input: { file_path: args.path ?? "", content: args.content ?? "" },
      }
    case "grep":
      return {
        toolName: "Grep",
        input: {
          pattern: args.pattern ?? "",
          path: args.path,
          glob: args.glob,
          "-i": args.ignoreCase,
          "-C": args.context,
          head_limit: args.limit,
        },
      }
    case "find":
      return {
        toolName: "Glob",
        input: { pattern: args.pattern ?? "", path: args.path },
      }
    case "ls": {
      const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : "."
      return {
        toolName: "Glob",
        input: { pattern: `${dirPath.replace(/\/$/, "")}/*`, path: args.path },
      }
    }
    default:
      // Unmapped tools (e.g. memory custom tools) still render via unknown_tool.
      return { toolName: rawName, input: args }
  }
}

/**
 * Extract renderable content from a pi AgentToolResult ({ content: blocks[] }).
 * Text-only results collapse to a plain string; results with images keep the
 * block structure that `hydrateToolResult` understands.
 */
export function extractPiToolResultContent(result: unknown): unknown {
  const record = asRecord(result)
  const blocks = Array.isArray(record.content) ? record.content : null
  if (!blocks) {
    return typeof result === "string" ? result : record.output ?? result ?? ""
  }

  const hasImage = blocks.some((block) => asRecord(block).type === "image")
  if (hasImage) {
    return { content: blocks }
  }

  return blocks
    .map((block) => {
      const blockRecord = asRecord(block)
      return blockRecord.type === "text" && typeof blockRecord.text === "string" ? blockRecord.text : ""
    })
    .join("")
}

/** Map pi's per-message usage into MemoSync's context-window snapshot. */
export function normalizePiUsage(usage: unknown, contextWindow?: number): ContextWindowUsageSnapshot | null {
  const record = asRecord(usage)
  const input = typeof record.input === "number" ? record.input : 0
  const output = typeof record.output === "number" ? record.output : 0
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0

  const inputTokens = input + cacheRead + cacheWrite
  const usedTokens = inputTokens + output
  if (usedTokens <= 0) return null

  return {
    usedTokens,
    inputTokens,
    ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
    ...(output > 0 ? { outputTokens: output } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheRead > 0 ? { lastCachedInputTokens: cacheRead } : {}),
    ...(output > 0 ? { lastOutputTokens: output } : {}),
    ...(contextWindow && contextWindow > 0 ? { maxTokens: contextWindow } : {}),
    compactsAutomatically: true,
  }
}

/** The Model Registry connection pi runs against. */
export interface PiConnection {
  protocol?: "openai-chat" | "openai-responses"
  contextWindow?: number
  maxOutputTokens?: number
  provider: LlmProviderKind
  baseUrl: string
  apiKey: string
}

/**
 * Every model MemoSync builds itself runs under this provider. Pi's built-in
 * providers each serve one API whatever the model says (its "openai" sends
 * everything to /responses), so only a provider with no base of its own honours
 * the protocol chosen for the connection.
 */
const PI_REGISTRY_PROVIDER = "custom"

/** Keys are set per session and never persisted, so Pi's store stays empty. */
const emptyCredentialStore: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_providerId, fn) => fn(undefined),
  delete: async () => {},
}

/**
 * A session's model can be Pi's own or one of ours, so the key has to reach
 * both. Pi refuses to send a request with no key, but local servers don't need
 * one and ignore what they're given.
 */
async function setConnectionKey(runtime: ModelRuntime, connection: PiConnection) {
  const key = connection.apiKey || "no-key"
  await runtime.setRuntimeApiKey(PI_REGISTRY_PROVIDER, key)
  if (connection.provider !== PI_REGISTRY_PROVIDER) await runtime.setRuntimeApiKey(connection.provider, key)
}

/**
 * Pi carries its prompt in the transcript's system messages. Replace their text
 * so a branch reuses its parent's prompt byte for byte and its prompt cache,
 * while keeping the tool declarations those messages also hold.
 */
function withExactSystemPrompt<T extends { role: string }>(messages: T[], systemPrompt: string): T[] {
  const blank = { content: "", sections: undefined }
  const later = messages.slice(messages[0]?.role === "system" ? 1 : 0).flatMap(message => {
    if (message.role !== "system") return [message]
    const { toolsAdded, toolsRemoved } = message as { toolsAdded?: unknown[]; toolsRemoved?: unknown[] }
    return toolsAdded?.length || toolsRemoved?.length ? [{ ...message, ...blank }] : []
  })
  const head = messages[0]?.role === "system" ? messages[0] : { role: "system", timestamp: 0 } as unknown as T
  return [{ ...head, ...blank, content: systemPrompt }, ...later]
}

/**
 * Build a Model definition for an arbitrary model id against the registry's
 * base URL. The configured provider card controls reasoning, context and cost. Without
 * capability metadata, omit reasoning rather than inventing supported levels.
 */
export function buildRegistryModel(connection: PiConnection & { protocol: "openai-responses" }, modelId: string, card?: RegistryModelCard, effort?: PiReasoningEffort): Model<"openai-responses">
export function buildRegistryModel(connection: PiConnection & { protocol?: "openai-chat" }, modelId: string, card?: RegistryModelCard, effort?: PiReasoningEffort): Model<"openai-completions">
export function buildRegistryModel(connection: PiConnection, modelId: string, card?: RegistryModelCard, effort?: PiReasoningEffort): Model<"openai-completions" | "openai-responses">
export function buildRegistryModel(connection: PiConnection, modelId: string, card?: RegistryModelCard, effort?: PiReasoningEffort): Model<"openai-completions" | "openai-responses"> {
  const hostname = new URL(connection.baseUrl).hostname
  const isOpenRouter = hostname === "openrouter.ai"
  const isZhipu = hostname === "open.bigmodel.cn"
  return {
    id: modelId,
    name: modelId,
    api: connection.protocol === "openai-responses" ? "openai-responses" : "openai-completions",
    provider: PI_REGISTRY_PROVIDER,
    baseUrl: connection.baseUrl,
    reasoning: card?.reasoningEfforts.some(e => e !== "off") ?? true,
    thinkingLevelMap: registryThinkingMap(card, effort),
    input: card?.inputModalities !== undefined ? card.inputModalities.filter((m): m is "text" | "image" => m === "text" || m === "image") : ["text", "image"],
    cost: { input: card?.cost?.input ?? 0, output: card?.cost?.output ?? 0, cacheRead: card?.cost?.cacheRead ?? 0, cacheWrite: card?.cost?.cacheWrite ?? 0 },
    contextWindow: connection.contextWindow ?? card?.contextWindow ?? 200_000,
    // Pi treats zero as an unspecified output limit. A cold/partial catalog
    // must not send a guessed 32K limit to a model that only accepts 8K.
    maxTokens: connection.maxOutputTokens ?? (card?.maxTokens ? Math.min(card.maxTokens, 32_000) : 0),
    compat: isZhipu ? {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
      // BigModel uses the same thinking.type + reasoning_effort wire format.
      thinkingFormat: "deepseek",
    } : { thinkingFormat: isOpenRouter ? "openrouter" : "openai" },
  }
}

/** Explicitly exclude unsupported SDK slots; max uses xhigh with a max wire value. */
export function registryThinkingMap(card?: RegistryModelCard, effort?: PiReasoningEffort): ThinkingLevelMap {
  const map: ThinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null }
  for (const effort of card?.reasoningEfforts ?? []) {
    if (effort === "default") continue
    map[toPiThinkingLevel(effort)] = effort === "off" ? "none" : effort
  }
  // Providers can expose BOTH xhigh and max; Pi has one native slot for them.
  if ((effort === "max" || effort === "xhigh") && card?.reasoningEfforts.includes(effort)) map.xhigh = effort
  return map
}

/**
 * Resolve pi's connection from the Model Registry settings; falls back to an
 * OpenRouter connection built from the OPENROUTER_API_KEY environment variable.
 */
export async function resolvePiConnection(options: { connectionId?: string; model?: string } = {}): Promise<PiConnection | null> {
  try {
    return (await resolveEngineRuntime({ engine: "pi", ...options })).piConnection ?? null
  } catch (error) {
    if (error instanceof Error && error.message === "connection-missing") return null
    throw error
  }
}

export const MISSING_PI_CONNECTION_MESSAGE =
  "Pi needs a Model Registry connection. Add an API key under Settings → Providers → Model Registry (OpenRouter, OpenAI, or a custom OpenAI-compatible URL), or export OPENROUTER_API_KEY."

export interface StartPiTurnArgs {
  chatId: string
  /** Cancels SDK initialization as well as the first prompt dispatch. */
  signal?: AbortSignal
  cwd: string
  content: string
  /** Model id on the registry endpoint — any non-empty registry id is valid. */
  model: string
  effort: PiReasoningEffort
  /** Effective parent metadata/prompt, pinned for cache-compatible memory forks. */
  modelCard?: RegistryModelCard
  systemPrompt?: string
  onLaunch?: (launch: PiParentLaunch) => void
  /** Previous pi session file path to resume, if any. */
  sessionToken: string | null
  forkSession: boolean
  /** Model Registry connection (or env fallback). Null surfaces an error turn. */
  connection: PiConnection | null
  /** Memory tools to register; the tool list is fixed at session creation. */
  memorySpecs?: MemoryToolSpec[]
  /**
   * Built-in tools to expose (defaults to all read/write pi tools). Memory
   * branches retain the parent list and gate execution via beforeToolCall.
   * The list is part of the session-reuse key.
   */
  beforeToolCall?: (name: string, args: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>
  outputSchema?: Record<string, unknown>
  toolNames?: readonly string[]
  /**
   * Dispatch for this turn's memory tool calls. Set to undefined to disable
   * dispatch for a turn (e.g. the user proceeded without memory) without
   * rebuilding the session.
   */
  memoryDispatch?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<MemoryToolResult>
}

interface PiChatSession {
  commandRuntime?: NativeCommandRuntime
  sdkVersion: string
  session: AgentSession
  modelRuntime: ModelRuntime
  resourceLoader: DefaultResourceLoader
  cwd: string
  model: string
  effort: PiReasoningEffort
  connectionProvider: LlmProviderKind
  connectionBaseUrl: string
  connectionProtocol?: PiConnection["protocol"]
  /** Stable system and complete native tool definitions fixed at creation. */
  definitionsKey: string
  modelCardKey: string
  outputSchema?: Record<string, unknown>
  supportsStructuredOutput?: boolean
  beforeToolCall?: StartPiTurnArgs["beforeToolCall"]
  /** Per-turn dispatch target; null when memory is disabled for the turn. */
  memoryInvoke: ((name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<MemoryToolResult>) | null
}

/** A turn that failed before the agent could start (missing key, bad session file). */
function failedPiTurn(message: string): HarnessTurn {
  const queue = new AsyncQueue<HarnessEvent>()
  queue.push({
    type: "transcript",
    entry: timestamped({
      kind: "result",
      subtype: "error",
      isError: true,
      durationMs: 0,
      result: message,
    }),
  })
  queue.finish()
  return {
    provider: "pi",
    stream: queue,
    interrupt: async () => {},
    close: () => {},
  }
}

export class PiAgentManager {
  private readonly sessions = new Map<string, PiChatSession>()
  private readonly pendingStarts = new Map<string, AbortController>()
  private disposed = false
  private readonly agentDir: string
  private readonly sessionsDir: string
  private readonly loadSdk: typeof loadPiSdk
  private readonly loadModels: RegistryModelLoader

  constructor(args: { dataDir?: string; loadSdk?: typeof loadPiSdk; loadModels?: RegistryModelLoader } = {}) {
    const dataDir = args.dataDir ?? path.join(getDataRootDir(homedir()), "pi")
    this.agentDir = path.join(dataDir, "agent")
    this.sessionsDir = path.join(dataDir, "sessions")
    this.loadSdk = args.loadSdk ?? loadPiSdk
    this.loadModels = args.loadModels ?? loadRegistryModels
  }

  getResourceCounts() {
    return { piSessions: this.sessions.size }
  }

  getCommandRuntime(chatId: string): NativeCommandRuntime | undefined {
    const chat = this.sessions.get(chatId)
    if (!chat) return undefined
    return chat.commandRuntime ??= createPiCommandRuntime(chat.session, this.agentDir, () => this.sessions.get(chatId) === chat && !this.disposed, chat.sdkVersion)
  }

  closeChat(chatId: string) {
    const pending = this.pendingStarts.get(chatId)
    this.pendingStarts.delete(chatId)
    pending?.abort()
    const existing = this.sessions.get(chatId)
    if (!existing) return
    this.sessions.delete(chatId)
    void existing.session.abort().catch(() => {})
    existing.session.dispose()
  }

  dispose() {
    this.disposed = true
    for (const chatId of new Set([...this.sessions.keys(), ...this.pendingStarts.keys()])) {
      this.closeChat(chatId)
    }
  }

  private resolveModel(runtime: ModelRuntime, connection: PiConnection, modelId: string, card?: RegistryModelCard, effort?: PiReasoningEffort): Model<any> {
    const official = !connection.protocol && ((connection.provider === "openrouter" && connection.baseUrl.replace(/\/+$/, "") === OPENROUTER_BASE_URL)
      || (connection.provider === "openai" && connection.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"))
    const known = official ? runtime.getModel(connection.provider, modelId) : undefined
    if (known) {
      // A cold cache means provider defaults, even if the SDK knows the model.
      // Its usual off mapping must not turn this default into explicit "none".
      if (!card) return { ...known, thinkingLevelMap: registryThinkingMap() }
      const current = buildRegistryModel(connection, modelId, card, effort)
      // Keep the official SDK's API/compatibility adapter, while using current
      // provider fields for the model's capabilities and accounting.
      return { ...known, reasoning: current.reasoning, thinkingLevelMap: current.thinkingLevelMap,
        input: card.inputModalities !== undefined ? current.input : known.input,
        cost: { input: card.cost?.input ?? known.cost.input, output: card.cost?.output ?? known.cost.output,
          cacheRead: card.cost?.cacheRead ?? known.cost.cacheRead, cacheWrite: card.cost?.cacheWrite ?? known.cost.cacheWrite },
        contextWindow: card.contextWindow ?? known.contextWindow, maxTokens: card.maxTokens ?? known.maxTokens }
    }
    return buildRegistryModel(connection, modelId, card, effort)
  }

  private async openSession(args: StartPiTurnArgs & { connection: PiConnection; modelCard?: RegistryModelCard }): Promise<PiChatSession> {
    args.signal?.throwIfAborted()
    const builtinToolNames = args.toolNames ?? PI_TOOL_NAMES
    const memorySpecs = args.memorySpecs ?? []
    const chatSessionHolder: { session?: PiChatSession } = {}
    const memoryTools = toPiToolDefinitions(memorySpecs, async (name, toolArgs, signal) => {
      const invoke = chatSessionHolder.session?.memoryInvoke
      if (!invoke) return { text: "Memory tools are not available for this turn.", isError: true }
      return invoke(name, toolArgs, signal)
    })
    const definitionsKey = createHash("sha256").update(definitionJson({
      systemPrompt: args.systemPrompt,
      builtinTools: [...builtinToolNames].sort(),
      memoryTools: memoryTools.map(({ name, description, parameters }) => ({ name, description, parameters }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })).digest("hex")

    const modelCardKey = JSON.stringify({ card: args.modelCard, wireEffort: args.effort === "max" || args.effort === "xhigh" ? args.effort : undefined })
    const existing = this.sessions.get(args.chatId)
    const connectionUnchanged = existing
      && existing.connectionProvider === args.connection.provider
      && existing.connectionBaseUrl === args.connection.baseUrl
      && existing.connectionProtocol === args.connection.protocol
    if (existing && connectionUnchanged && existing.cwd === args.cwd
      && existing.definitionsKey === definitionsKey && !args.forkSession) {
      await setConnectionKey(existing.modelRuntime, args.connection)
      args.signal?.throwIfAborted()
      existing.memoryInvoke = args.memoryDispatch ?? null
      existing.beforeToolCall = args.beforeToolCall
      if (existing.model !== args.model || existing.modelCardKey !== modelCardKey) {
        await existing.session.setModel(this.resolveModel(existing.modelRuntime, args.connection, args.model, args.modelCard, args.effort))
        args.signal?.throwIfAborted()
        existing.model = args.model
        existing.modelCardKey = modelCardKey
        existing.supportsStructuredOutput = args.modelCard?.supportsStructuredOutput
      }
      if (existing.effort !== args.effort) {
        existing.session.setThinkingLevel(toPiThinkingLevel(args.effort))
        existing.effort = args.effort
      }
      return existing
    }

    if (existing) {
      this.sessions.delete(args.chatId)
      if (existing.session.isStreaming) await existing.session.abort()
      existing.session.dispose()
      // Rebind definitions around the native history, even if an in-process
      // caller omitted the token it already received on the previous turn.
      if (connectionUnchanged && existing.cwd === args.cwd && !args.forkSession) {
        args = { ...args, sessionToken: args.sessionToken ?? existing.session.sessionFile ?? null }
      }
      args.signal?.throwIfAborted()
    }

    // All state is MemoSync-owned: in-memory credentials/settings, sessions
    // under MemoSync's data root, and no discovery of the user's ~/.pi setup.
    const { ModelRuntime, SettingsManager, DefaultResourceLoader, SessionManager, createAgentSession, createBashToolDefinition } = await this.loadSdk()
    const sdkVersion = this.loadSdk === loadPiSdk ? piSdkVersion : 'unknown'
    args.signal?.throwIfAborted()
    const modelRuntime = await ModelRuntime.create({ credentials: emptyCredentialStore, modelsPath: null })
    modelRuntime.registerProvider(PI_REGISTRY_PROVIDER, { name: "MemoSync" })
    await setConnectionKey(modelRuntime, args.connection)
    args.signal?.throwIfAborted()
    const settingsManager = SettingsManager.inMemory()

    // Markdown resources (prompt templates + skills) are discovered from
    // MemoSync's agentDir plus the project; extensions stay disabled — they are
    // arbitrary TypeScript executed in-process.
    const resourceLoader = new DefaultResourceLoader({
      cwd: args.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
    })
    await resourceLoader.reload()
    args.signal?.throwIfAborted()

    // Fail closed when a persisted session file was expected but is gone:
    // silently starting fresh history would discard context (and for memory
    // branches would orphan the fork from its parent).
    if (args.sessionToken && !existsSync(args.sessionToken)) {
      throw new Error(args.forkSession
        ? `Pi session file for fork not found: ${args.sessionToken}`
        : `Pi session file not found: ${args.sessionToken}`)
    }

    const sessionManager = args.forkSession
      ? SessionManager.forkFrom(args.sessionToken as string, args.cwd, this.sessionsDir)
      : args.sessionToken
        ? SessionManager.open(args.sessionToken, this.sessionsDir, args.cwd)
        : SessionManager.create(args.cwd, this.sessionsDir)

    // Tool definitions close over the mutable invoker, so each reused turn
    // rebinds dispatch without changing the session identity.
    const customTools: ToolDefinition[] | undefined = (() => {
      const defs: ToolDefinition[] = []
      // Shell commands spawned by the bash tool run with a scrubbed
      // environment so registry endpoints cannot exfiltrate ambient
      // credentials. A custom "bash" definition shadows the built-in one in
      // pi's tool registry.
      if (builtinToolNames.includes("bash")) {
        defs.push(createBashToolDefinition(args.cwd, {
          spawnHook: (context: BashSpawnContext) => ({ ...context, env: scrubPiShellEnv(context.env) }),
        }) as unknown as ToolDefinition)
      }
      defs.push(...memoryTools)
      return defs.length > 0 ? defs : undefined
    })()

    const { session } = await createAgentSession({
      cwd: args.cwd,
      agentDir: this.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader,
      model: this.resolveModel(modelRuntime, args.connection, args.model, args.modelCard, args.effort),
      thinkingLevel: toPiThinkingLevel(args.effort),
      tools: [...builtinToolNames, ...memorySpecs.map((spec) => spec.name)],
      customTools,
    })
    if (args.signal?.aborted) {
      void session.abort().catch(() => {})
      session.dispose()
      args.signal.throwIfAborted()
    }

    const chatSession: PiChatSession = {
      session,
      sdkVersion,
      modelRuntime,
      resourceLoader,
      cwd: args.cwd,
      model: args.model,
      effort: args.effort,
      connectionProvider: args.connection.provider,
      connectionBaseUrl: args.connection.baseUrl,
      connectionProtocol: args.connection.protocol,
      definitionsKey,
      modelCardKey,
      supportsStructuredOutput: args.modelCard?.supportsStructuredOutput,
      memoryInvoke: args.memoryDispatch ?? null,
      beforeToolCall: args.beforeToolCall,
    }
    if (session.agent) {
      if (args.systemPrompt !== undefined) {
        const systemPrompt = args.systemPrompt
        const previousTransform = session.agent.transformContext
        session.agent.transformContext = async (messages, signal) =>
          withExactSystemPrompt(previousTransform ? await previousTransform(messages, signal) : messages, systemPrompt)
      }
      const previousToolHook = session.agent.beforeToolCall
      session.agent.beforeToolCall = async (context, signal) => {
        const denied = await chatSession.beforeToolCall?.(context.toolCall.name, context.args as Record<string, unknown>)
        if (denied?.block) return denied
        return previousToolHook?.(context, signal)
      }
      const previousPayloadHook = session.agent.onPayload
      session.agent.onPayload = async (payload, model) => {
        const prepared = await previousPayloadHook?.(payload, model) ?? payload
        const current = chatSessionHolder.session
        if (current?.outputSchema && current.supportsStructuredOutput) {
          const schema = { name: "memosync_branch", strict: true, schema: current.outputSchema }
          const body = asRecord(prepared)
          if (model.api === "openai-completions") {
            return { ...body, response_format: { type: "json_schema", json_schema: schema } }
          }
          if (model.api === "openai-responses") {
            return { ...body, text: { ...asRecord(body.text), format: { type: "json_schema", ...schema } } }
          }
        }
        return prepared
      }
    }
    chatSessionHolder.session = chatSession
    this.sessions.set(args.chatId, chatSession)
    return chatSession
  }

  async startTurn(args: StartPiTurnArgs): Promise<HarnessTurn> {
    args.signal?.throwIfAborted()
    if (this.disposed) throw new DOMException("Pi manager has been disposed", "AbortError")
    if (this.pendingStarts.has(args.chatId)) this.closeChat(args.chatId)
    const controller = new AbortController()
    this.pendingStarts.set(args.chatId, controller)
    const relayAbort = () => controller.abort(args.signal?.reason)
    const stopForAbort = () => {
      if (this.pendingStarts.get(args.chatId) === controller) this.closeChat(args.chatId)
    }
    controller.signal.addEventListener("abort", stopForAbort, { once: true })
    args.signal?.addEventListener("abort", relayAbort, { once: true })
    try {
      return await this.startTurnWithSignal({ ...args, signal: controller.signal })
    } finally {
      args.signal?.removeEventListener("abort", relayAbort)
      controller.signal.removeEventListener("abort", stopForAbort)
      if (this.pendingStarts.get(args.chatId) === controller) this.pendingStarts.delete(args.chatId)
    }
  }

  private async startTurnWithSignal(args: StartPiTurnArgs): Promise<HarnessTurn> {
    args.signal?.throwIfAborted()
    if (!args.connection) {
      return failedPiTurn(MISSING_PI_CONNECTION_MESSAGE)
    }

    let chatSession: PiChatSession
    try {
      // Load the SDK first to preserve the lazy/cancellable initialization boundary.
      await this.loadSdk()
      args.signal?.throwIfAborted()
      // The picker preloads metadata. Chat turns never wait on a registry or
      // models.dev request: use its last snapshot, refreshing for later turns.
      const recorded = Object.hasOwn(args, "modelCard")
      const modelCard = recorded ? args.modelCard : this.loadModels.peek?.(args.connection, args.model)
      if (!recorded) void Promise.resolve().then(() => this.loadModels(args.connection!, args.model)).catch(() => {})
      args = { ...args, effort: resolvePiEffort(modelCard, args.effort) }
      chatSession = await this.openSession({ ...args, connection: args.connection!, modelCard })
      args.onLaunch?.({ provider: "pi", options: {
        model: args.model, effort: args.effort, connection: args.connection,
        toolNames: args.toolNames ?? PI_TOOL_NAMES, memorySpecs: args.memorySpecs,
        modelCard, systemPrompt: args.systemPrompt ?? chatSession.session.systemPrompt,
      } })
    } catch (error) {
      args.signal?.throwIfAborted()
      return failedPiTurn(error instanceof Error ? error.message : String(error))
    }
    const session = chatSession.session
    // A previous turn on this reused session may still be streaming (its turn
    // was closed without an interrupt); pi throws on concurrent prompt() calls,
    // so stop the old run before starting the new one.
    if (session.isStreaming) {
      await session.abort()
    }
    args.signal?.throwIfAborted()
    chatSession.outputSchema = args.outputSchema
    const queue = new AsyncQueue<HarnessEvent>()
    const startedAt = Date.now()

    let finished = false
    let turnCostUsd = 0
    let lastError: string | null = null
    let aborted = false

    const pushSessionToken = () => {
      if (session.sessionFile) {
        queue.push({ type: "session_token", sessionToken: session.sessionFile })
      }
    }

    const finalize = (result: { isError: boolean; message: string; cancelled?: boolean }) => {
      if (finished) return
      finished = true
      unsubscribe()
      pushSessionToken()
      if (!result.cancelled) {
        queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: result.isError ? "error" : "success",
            isError: result.isError,
            durationMs: Date.now() - startedAt,
            result: result.message,
            ...(turnCostUsd > 0 ? { costUsd: turnCostUsd } : {}),
          }),
        })
      }
      queue.finish()
    }

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_end": {
          const message = asRecord(event.message)
          if (message.role !== "assistant") return

          const usageRecord = asRecord(message.usage)
          if (typeof usageRecord.cost === "object") {
            const total = asRecord(usageRecord.cost).total
            if (typeof total === "number") turnCostUsd += total
          }
          const usage = normalizePiUsage(message.usage, session.model?.contextWindow)
          if (usage) {
            queue.push({
              type: "transcript",
              entry: timestamped({ kind: "context_window_updated", usage }),
            })
          }

          if (message.stopReason === "error") {
            lastError = typeof message.errorMessage === "string" && message.errorMessage
              ? message.errorMessage
              : "Pi turn failed"
          }
          if (message.stopReason === "aborted") {
            aborted = true
          }

          const text = Array.isArray(message.content)
            ? message.content
              .map((block) => {
                const blockRecord = asRecord(block)
                return blockRecord.type === "text" && typeof blockRecord.text === "string" ? blockRecord.text : ""
              })
              .join("")
            : ""
          if (text.trim()) {
            queue.push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) })
          }
          return
        }

        case "tool_execution_start": {
          const { toolName, input } = translatePiTool(event.toolName, asRecord(event.args))
          queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_call",
              tool: normalizeToolCall({ toolName, toolId: event.toolCallId, input }),
            }),
          })
          return
        }

        case "tool_execution_end": {
          queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_result",
              toolId: event.toolCallId,
              content: extractPiToolResultContent(event.result),
              isError: event.isError,
            }),
          })
          return
        }

        default:
          return
      }
    })

    queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "system_init",
        provider: "pi",
        model: args.model,
        tools: [...new Set((args.toolNames ?? PI_TOOL_NAMES)
          .map((name) => PI_DISPLAY_TOOL_NAMES[name] ?? name))]
          .concat((args.memorySpecs ?? []).map((spec) => spec.name)),
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
    })
    pushSessionToken()

    void session.prompt(args.content)
      .then(() => {
        if (aborted) {
          finalize({ isError: false, message: "", cancelled: true })
        } else if (lastError) {
          finalize({ isError: true, message: lastError })
        } else {
          finalize({ isError: false, message: "" })
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        finalize({ isError: true, message })
      })

    return {
      provider: "pi",
      stream: queue,
      interrupt: async () => {
        await session.abort()
      },
      // The AgentSession stays alive across turns (it's reused by the next
      // startTurn and torn down in closeChat); close ends this turn's stream
      // and stops any still-running prompt so it can't keep executing tools
      // invisibly after the turn is discarded.
      close: () => {
        if (session.isStreaming) {
          void session.abort().catch(() => {})
        }
        finalize({ isError: false, message: "", cancelled: true })
      },
    }
  }
}
