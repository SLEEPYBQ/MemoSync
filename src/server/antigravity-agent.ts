import { spawn, type ChildProcess } from "node:child_process"
import { realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import { resolveEngineRuntime, type EngineRuntime } from "./model-access/runtime"
import { executableLauncher } from "./model-access/launcher"
import { killProcessTree } from "./process-utils"
import type { NativeExecutionPolicy } from "../shared/harness-capabilities"

type JsonObject = Record<string, unknown>
type AntigravityPolicy = Extract<NativeExecutionPolicy, { engine: "antigravity" }>
const record = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}
const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(record) : []
const text = (value: unknown) => typeof value === "string" ? value : ""
type EntryInput = TranscriptEntry extends infer T ? T extends TranscriptEntry ? Omit<T, "_id" | "createdAt"> : never : never
function entry(value: EntryInput): TranscriptEntry {
  return { ...value, _id: crypto.randomUUID(), createdAt: Date.now() } as TranscriptEntry
}
class Queue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiting: Array<(value: IteratorResult<T>) => void> = []
  private done = false
  push(value: T) { if (!this.done) { const next = this.waiting.shift(); if (next) next({ value, done: false }); else this.values.push(value) } }
  finish() { this.done = true; for (const next of this.waiting.splice(0)) next({ value: undefined as T, done: true }) }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.done ? Promise.resolve({ value: undefined as T, done: true }) : new Promise(resolve => this.waiting.push(resolve)) } }
}

/** Map Antigravity's snake_case tool wire names into MemoSync's normalized Claude-shaped catalog. */
export function translateAntigravityTool(rawName: string, args: JsonObject): { toolName: string; input: JsonObject } {
  const first = (...values: unknown[]) => values.find(value => typeof value === "string" && value) as string | undefined
  switch (rawName) {
    case "run_command": return { toolName: "Bash", input: { ...args, command: first(args.CommandLine, args.command_line, args.commandLine, args.command) ?? "" } }
    case "view_file": return { toolName: "Read", input: { file_path: first(args.Path, args.absolute_path, args.path, args.file_path) ?? "", offset: args.offset, limit: args.limit } }
    case "write_file": return { toolName: "Write", input: { file_path: first(args.Path, args.path, args.file_path) ?? "", content: first(args.Content, args.content) ?? "" } }
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file": return { toolName: "Edit", input: { file_path: first(args.Path, args.path, args.file_path) ?? "", old_string: first(args.OldString, args.old_string, args.oldString) ?? "", new_string: first(args.NewString, args.new_string, args.newString) ?? "" } }
    case "grep_search": return { toolName: "Grep", input: { ...args, pattern: first(args.Pattern, args.pattern, args.Query, args.query) ?? "" } }
    case "find_by_name": return { toolName: "Glob", input: { ...args, pattern: first(args.Pattern, args.pattern, args.Name, args.name) ?? "" } }
    case "list_dir": return { toolName: "Glob", input: { pattern: `${String(first(args.Path, args.path) || ".").replace(/\/$/, "")}/*` } }
    case "search_web": return { toolName: "WebSearch", input: { query: first(args.Query, args.query) ?? "" } }
    case "ask_question": return { toolName: "AskUserQuestion", input: { questions: Array.isArray(args.questions) ? args.questions : [] } }
    case "invoke_subagent": return { toolName: "Task", input: { ...args, subagent_type: first(args.type_name, args.subagent_type, args.role) ?? "general" } }
    default: return { toolName: rawName, input: args }
  }
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class AntigravityAcpConnection {
  private nextId = 1
  private buffered = ""
  private readonly pending = new Map<string, PendingRequest>()
  private failed: Error | undefined
  onNotification?: (method: string, params: JsonObject) => void
  onServerRequest?: (id: string | number, method: string, params: JsonObject) => void
  onClose?: (error: Error) => void
  constructor(readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.read(chunk))
    const close = (error: Error) => {
      if (this.failed) return
      this.failed = error
      for (const pending of Array.from(this.pending.values())) pending.reject(error)
      this.pending.clear()
      this.onClose?.(error)
    }
    child.once("error", error => close(error))
    child.once("exit", () => close(new Error("Antigravity ACP process exited")))
    child.stdin?.on("error", () => close(new Error("Antigravity ACP stdin closed")))
  }
  private read(chunk: string) {
    this.buffered += chunk
    if (this.buffered.length > 4 * 1024 * 1024) {
      this.fail(new Error("Antigravity ACP message buffer limit"))
      return
    }
    for (let end = this.buffered.indexOf("\n"); end >= 0; end = this.buffered.indexOf("\n")) {
      const line = this.buffered.slice(0, end).trim()
      this.buffered = this.buffered.slice(end + 1)
      if (!line) continue
      let message: JsonObject
      try { message = record(JSON.parse(line)) } catch { continue }
      const method = text(message.method)
      const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined
      if (method && id !== undefined) this.onServerRequest?.(id, method, record(message.params))
      else if (method) this.onNotification?.(method, record(message.params))
      else if (id !== undefined) {
        const pending = this.pending.get(String(id))
        if (!pending) continue
        this.pending.delete(String(id))
        if (message.error != null) {
          const error = record(message.error)
          pending.reject(new Error(text(error.message) || `Antigravity ${pending.method} failed`))
        } else pending.resolve(message.result)
      }
    }
  }
  write(message: JsonObject) {
    if (this.failed) throw this.failed
    if (!this.child.stdin || this.child.stdin.destroyed) throw new Error("Antigravity ACP stdin closed")
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  request(method: string, params: JsonObject, timeoutMs = 15_000): Promise<JsonObject> {
    if (this.failed) return Promise.reject(this.failed)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`Antigravity ${method} timed out`))
      }, timeoutMs)
      this.pending.set(String(id), {
        method,
        resolve: result => { clearTimeout(timer); resolve(record(result)) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try { this.write({ jsonrpc: "2.0", id, method, params }) }
      catch (error) { this.pending.delete(String(id)); clearTimeout(timer); reject(error) }
    })
  }
  respond(id: string | number, result: JsonObject) {
    this.write({ jsonrpc: "2.0", id, result })
  }
  notify(method: string, params: JsonObject) {
    this.write({ jsonrpc: "2.0", method, params })
  }
  fail(error: Error) {
    if (!this.failed) {
      this.failed = error
      for (const pending of Array.from(this.pending.values())) pending.reject(error)
      this.pending.clear()
      this.onClose?.(error)
    }
  }
}

interface ChatAcp {
  key: string
  child: ChildProcess
  connection: AntigravityAcpConnection
  runtime: EngineRuntime
  sessionId?: string
  closed: boolean
  turn?: { sessionId: string; notification(method: string, params: JsonObject): void; serverRequest(id: string | number, method: string, params: JsonObject): void; fail(message: string): void; cancel(): void }
}

export interface StartAntigravityTurnArgs {
  chatId: string
  cwd: string
  content: string
  model: string
  runtime?: EngineRuntime
  systemPrompt?: string
  memoryContext?: string
  sessionToken?: string | null
  forkSession?: boolean
  planMode?: boolean
  signal?: AbortSignal
  executionPolicy?: AntigravityPolicy
  isPolicyCurrent?: () => boolean
  onExecutionPolicyApplied?: (nativeSessionId?: string) => Promise<void>
  onToolRequest?: (request: HarnessToolRequest) => Promise<unknown>
  onPermissionRequest?: (request: JsonObject, tool?: { name: string; input: JsonObject }) => Promise<boolean>
}

const DEFAULT_SYSTEM_PROMPT = "Use the memory context supplied with the current user message for that turn. Earlier memory blocks are historical snapshots and may have been updated."

export class AntigravityAgentManager {
  private readonly chats = new Map<string, ChatAcp>()
  private readonly generations = new Map<string, number>()
  private readonly stopping = new Map<string, Promise<void>>()
  private disposed = false
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  private async stop(chat: ChatAcp) {
    if (chat.closed) return
    chat.closed = true
    chat.turn?.cancel()
    try { chat.connection.notify("session/close", { sessionId: chat.sessionId ?? "" }) } catch {}
    chat.connection.fail(new Error("Antigravity session closed"))
    await killProcessTree(chat.child).catch(() => {})
  }
  hasSession(chatId: string) { return Boolean(this.chats.get(chatId) && !this.chats.get(chatId)!.closed) }
  /** ACP advertises slash commands but exposes no no-reply/control execution API; MemoSync does not wire them yet. */
  getCommandRuntime(_chatId: string) { return undefined }
  hasPendingWork(chatId: string) { return Boolean(this.chats.get(chatId)?.turn) }
  private retire(chatId: string, chat: ChatAcp) {
    if (this.chats.get(chatId) !== chat) return this.stopping.get(chatId)
    this.chats.delete(chatId)
    const stopping = this.stop(chat)
    this.stopping.set(chatId, stopping)
    void stopping.finally(() => { if (this.stopping.get(chatId) === stopping) this.stopping.delete(chatId) }).catch(() => {})
    return stopping
  }
  async closeChat(chatId: string): Promise<void> {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1)
    const chat = this.chats.get(chatId)
    if (chat) await this.retire(chatId, chat)
    else await this.stopping.get(chatId)
  }
  async dispose() {
    this.disposed = true
    await Promise.allSettled([...new Set([...this.chats.keys(), ...this.stopping.keys()])].map(id => this.closeChat(id)))
  }

  private async ensureConnection(args: StartAntigravityTurnArgs, runtime: EngineRuntime): Promise<ChatAcp> {
    const key = createHash("sha256").update(JSON.stringify([args.cwd, runtime.executable.path, runtime.env, runtime.args])).digest("hex")
    const previous = this.chats.get(args.chatId)
    if (previous?.key === key && !previous.closed) return previous
    const generation = this.generations.get(args.chatId) ?? 0
    if (previous) await this.retire(args.chatId, previous)
    const launcher = await executableLauncher(runtime.executable.path!, runtime.env)
    const child = this.spawnProcess(launcher.command, [...launcher.args, ...(runtime.args.length ? runtime.args : ["acp"])], {
      cwd: args.cwd, env: runtime.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    const connection = new AntigravityAcpConnection(child)
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    const chat: ChatAcp = { key, child, connection, runtime, closed: false }
    connection.onClose = error => { if (!chat.closed) { chat.turn?.fail(error.message); void this.retire(args.chatId, chat) } }
    connection.onNotification = (method, params) => chat.turn?.notification(method, params)
    connection.onServerRequest = (id, method, params) => chat.turn?.serverRequest(id, method, params)
    try {
      const result = await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          session: { configOptions: { boolean: {} }, notices: {} }, plan: {},
        },
        clientInfo: { name: "memosync", title: "MemoSync", version: "0" },
      }, 10_000)
      if (result.protocolVersion !== 1) throw new Error("Antigravity ACP protocol version unsupported")
      if (this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) throw new Error("Antigravity start cancelled")
      this.chats.set(args.chatId, chat)
      return chat
    } catch (error) {
      await killProcessTree(child).catch(() => {})
      const detail = stderr.trim()
      throw error instanceof Error && detail ? new Error(`${error.message}${error.message.includes(detail) ? "" : `: ${detail}`}`) : error
    }
  }

  async prepareSession(args: Omit<StartAntigravityTurnArgs, "content">): Promise<string> {
    const prepared = await this.initializeSession({ ...args, content: "" })
    return prepared.sessionId
  }

  private async initializeSession(args: StartAntigravityTurnArgs) {
    args = { ...args, cwd: await realpath(args.cwd) }
    args.signal?.throwIfAborted()
    if (this.disposed) throw new Error("Antigravity manager disposed")
    if (args.forkSession) throw new Error("Antigravity ACP does not support session fork")
    const runtime = args.runtime ?? await resolveEngineRuntime({ engine: "antigravity", model: args.model })
    if (runtime.engine !== "antigravity") throw new Error("engine-runtime-mismatch")
    await this.stopping.get(args.chatId)
    const chat = await this.ensureConnection(args, runtime)
    if (chat.turn) throw new Error("Antigravity chat is already running")
    let sessionId = args.sessionToken || chat.sessionId || ""
    if (sessionId) {
      await chat.connection.request("session/resume", { sessionId, cwd: args.cwd, mcpServers: [] }, 15_000)
    } else {
      const meta = args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
      const created = await chat.connection.request("session/new", {
        cwd: args.cwd, mcpServers: [],
        ...(meta ? { _meta: { antigravity: { systemPrompt: { append: meta } } } } : {}),
      }, 20_000)
      sessionId = text(created.sessionId)
    }
    if (!sessionId) throw new Error("Antigravity did not return a session identifier")
    const desiredMode = args.planMode ? "plan" : "default"
    if (args.model) await chat.connection.request("session/set_config_option", { sessionId, configId: "model", value: args.model }, 10_000)
    const modeResult = await chat.connection.request("session/set_config_option", { sessionId, configId: "mode", value: desiredMode }, 10_000)
    const options = array(modeResult.configOptions)
    const mode = options.find(option => option.id === "mode")
    if (!mode || mode.currentValue !== desiredMode) throw new Error("Antigravity did not confirm the requested session mode")
    if (args.executionPolicy) {
      if (args.isPolicyCurrent?.() === false) throw new Error("Stale execution policy acknowledgement")
      await args.onExecutionPolicyApplied?.(sessionId)
    }
    chat.sessionId = sessionId
    return { chat, runtime, sessionId }
  }

  async startTurn(args: StartAntigravityTurnArgs): Promise<HarnessTurn> {
    const { chat, runtime, sessionId } = await this.initializeSession(args)
    const queue = new Queue<HarnessEvent>()
    const started = Date.now()
    let finished = false, cancelRequested = false, assistant = ""
    const tools = new Map<string, { name: string; input: JsonObject; emitted: boolean; result: boolean }>()
    const commands = new Set<string>()
    const transcript = (value: Parameters<typeof entry>[0], itemId?: string) => queue.push({ type: "transcript", entry: entry(value), itemId })
    const finalize = (message = "", isError = false, cancelled = false) => {
      if (finished) return
      finished = true
      if (chat.turn?.sessionId === sessionId) chat.turn = undefined
      transcript({ kind: "result", subtype: cancelled ? "cancelled" : isError ? "error" : "success", isError, durationMs: Date.now() - started, result: message })
      queue.finish()
    }
    const toolPayload = (update: JsonObject): JsonObject => record(update.rawInput ?? update.args)
    const emitTool = (update: JsonObject) => {
      const id = text(update.toolCallId)
      if (!id) return
      const input = toolPayload(update)
      const name = text(update.name) || text(record(update.toolCall).name) || "unknown"
      const current = tools.get(id) ?? { name, input, emitted: false, result: false }
      current.name = name; current.input = Object.keys(input).length ? input : current.input
      tools.set(id, current)
      if (!current.emitted) {
        current.emitted = true
        const translated = translateAntigravityTool(name, current.input)
        transcript({ kind: "tool_call", tool: normalizeToolCall({ ...translated, toolId: id }) })
      }
      const status = text(update.status)
      if ((status === "completed" || status === "failed") && !current.result) {
        current.result = true
        const rawOutput = record(update.rawOutput)
        const content = Object.keys(rawOutput).length ? rawOutput : Array.isArray(update.content) ? update.content : text(update.error) || rawOutput
        transcript({ kind: "tool_result", toolId: id, content, isError: status === "failed" })
      }
    }
    const permissionOutcome = async (request: JsonObject) => {
      const permission = args.executionPolicy?.permission ?? "allow"
      if (permission === "allow") return true
      if (permission === "deny") return false
      const call = record(request.toolCall)
      const input = toolPayload(call)
      const name = text(call.name) || "permission"
      return args.onPermissionRequest ? await args.onPermissionRequest(request, { name, input }) : false
    }
    const answerPermission = async (id: string | number, request: JsonObject) => {
      const options = array(request.options)
      const toolId = text(record(request.toolCall).toolCallId)
      try {
        if (toolId.startsWith("interaction_")) {
          const question = text(record(request.toolCall).title) || "Choose an option."
          const tool = normalizeToolCall({ toolName: "AskUserQuestion", toolId, input: { questions: [{ id: toolId, question, header: "Question", multiSelect: false, options: options.map(option => ({ label: text(option.name) || text(option.optionId), description: text(option.name) || text(option.optionId) })) }] } }) as HarnessToolRequest["tool"]
          if (!tools.get(toolId)?.emitted) emitTool({ ...record(request.toolCall), toolCallId: toolId })
          const response = record(args.onToolRequest ? await args.onToolRequest({ tool }) : {})
          const raw = response.answers ?? response
          const answer = record(record(raw)[toolId]).answers ?? record(raw)[toolId] ?? record(raw)[question]
          const value = Array.isArray(answer) ? text(answer[0]) : text(answer)
          const option = options.find(candidate => text(candidate.optionId) === value || text(candidate.name) === value)
          if (!option || response.error || response.cancelled || args.isPolicyCurrent?.() === false) throw new Error("Antigravity question rejected")
          chat.connection.respond(id, { outcome: { outcome: "selected", optionId: text(option.optionId) } })
          return
        }
        const allowed = await permissionOutcome(request)
        if (finished) return
        const current = args.isPolicyCurrent?.() ?? true
        const kind = allowed && current ? "allow_once" : "reject_once"
        const option = options.find(candidate => candidate.kind === kind) ?? options.find(candidate => allowed && current ? candidate.kind === "allow_always" : candidate.kind === "reject_always")
        if (option) chat.connection.respond(id, { outcome: { outcome: "selected", optionId: text(option.optionId) } })
        else chat.connection.respond(id, { outcome: { outcome: "cancelled" } })
      } catch {
        try { chat.connection.respond(id, { outcome: { outcome: "cancelled" } }) } catch { finalize("Antigravity permission reply failed", true) }
      }
    }
    const notification = (method: string, params: JsonObject) => {
      if (finished || method !== "session/update" || text(params.sessionId) !== sessionId) return
      const update = record(params.update)
      switch (text(update.sessionUpdate)) {
        case "agent_message_chunk": {
          const delta = text(record(update.content).text)
          if (delta) {
            assistant += delta
            queue.push({ type: "assistant_delta", itemId: "agent-message", delta })
          }
          break
        }
        case "tool_call":
        case "tool_call_update": emitTool(update); break
        case "available_commands_update":
          for (const command of array(update.availableCommands)) if (text(command.name)) commands.add(text(command.name))
          break
        case "usage_update": {
          const used = typeof update.used === "number" ? update.used : 0
          const size = typeof update.size === "number" ? update.size : undefined
          if (used > 0) transcript({ kind: "context_window_updated", usage: { usedTokens: used, maxTokens: size, compactsAutomatically: true } })
          break
        }
      }
    }
    const abort = async () => {
      if (finished) return
      cancelRequested = true
      try { chat.connection.notify("session/cancel", { sessionId }) } catch {}
      finalize("", false, true)
      await this.retire(args.chatId, chat)
    }
    const onAbort = () => { void abort() }
    chat.turn = {
      sessionId,
      notification,
      serverRequest: (id, method, params) => { if (method === "session/request_permission") void answerPermission(id, params) },
      fail: message => finalize(message, true),
      cancel: () => finalize("", false, true),
    }
    queue.push({ type: "session_token", sessionToken: sessionId })
    transcript({ kind: "system_init", provider: "antigravity", model: runtime.model || args.model || "default", tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"], agents: [], slashCommands: [], mcpServers: [] })
    args.signal?.addEventListener("abort", onAbort, { once: true })
    const prompt = args.memoryContext ? `${args.memoryContext}\n\n${args.content}` : args.content
    void chat.connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, 24 * 60 * 60_000)
      .then(result => {
        if (finished) return
        if (assistant) transcript({ kind: "assistant_text", text: assistant }, "agent-message")
        const stop = text(result.stopReason)
        const usage = record(result.usage)
        const total = typeof usage.totalTokens === "number" ? usage.totalTokens : 0
        if (total > 0) transcript({ kind: "context_window_updated", usage: { usedTokens: total, inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined, outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined, cachedInputTokens: typeof usage.cachedReadTokens === "number" ? usage.cachedReadTokens : undefined, reasoningOutputTokens: typeof usage.thoughtTokens === "number" ? usage.thoughtTokens : undefined, lastUsedTokens: total, compactsAutomatically: true } })
        finalize(stop === "cancelled" || cancelRequested ? "" : "", false, stop === "cancelled" || cancelRequested)
      })
      .catch(error => finalize(error instanceof Error ? error.message : "Antigravity prompt failed", true))
    return { provider: "antigravity", stream: queue, interrupt: abort, close: () => { if (!finished) void abort() } }
  }
}
