import { spawn, type ChildProcess } from "node:child_process"
import { realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { TranscriptEntry } from "../shared/types"
import type { RuntimeCommand, RuntimeSourceProof } from "../shared/runtime-commands"
import { normalizeToolCall } from "../shared/tools"
import { discovery, type NativeCommandRuntime } from "./command-registry"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import { resolveEngineRuntime, type EngineRuntime } from "./model-access/runtime"
import { executableLauncher } from "./model-access/launcher"
import { killProcessTree } from "./process-utils"
import type { NativeExecutionPolicy } from "../shared/harness-capabilities"
import type { AntigravityParentLaunch } from "./memory/parent-launch"

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

export interface AntigravityAcpToolHints {
  kind?: string
  title?: string
  locations?: JsonObject[]
  content?: JsonObject[]
}

/** Map Antigravity's snake_case tool wire names and ACP metadata into MemoSync's normalized Claude-shaped catalog. */
export function translateAntigravityTool(
  rawName: string,
  args: JsonObject,
  acp?: AntigravityAcpToolHints,
): { toolName: string; input: JsonObject } {
  const first = (...values: unknown[]) => values.find(value => typeof value === "string" && value) as string | undefined
  const locations = acp?.locations?.length ? acp.locations : array(args.locations)
  const contentBlocks = acp?.content?.length ? acp.content : array(args.content)
  const firstLocation = locations[0]
  const locationPath = firstLocation ? first(firstLocation.path, firstLocation.filePath, firstLocation.uri) : undefined
  const locationLine = firstLocation && typeof firstLocation.line === "number" ? firstLocation.line : undefined
  const diffBlock = contentBlocks.find(block => text(block.type) === "diff") ?? (text(record(args.diff).path) ? record(args.diff) : undefined)
  const diffPath = diffBlock ? first(diffBlock.path, diffBlock.filePath) : undefined
  const diffOld = diffBlock && typeof diffBlock.oldText === "string" ? diffBlock.oldText : diffBlock ? first(diffBlock.old_text) : undefined
  const diffNew = diffBlock && typeof diffBlock.newText === "string" ? diffBlock.newText : diffBlock ? first(diffBlock.new_text) : undefined
  const firstChunk = array(args.ReplacementChunks)[0] ?? array(args.replacement_chunks)[0]
  const kind = acp?.kind || text(args.kind)

  switch (rawName) {
    case "run_command":
      return { toolName: "Bash", input: { ...args, command: first(args.CommandLine, args.command_line, args.commandLine, args.command, acp?.title) ?? "" } }
    case "read_file":
    case "view_file":
      return {
        toolName: "Read",
        input: {
          file_path: first(args.Path, args.absolute_path, args.path, args.file_path, locationPath) ?? "",
          offset: args.StartLine ?? args.offset ?? locationLine,
          limit: args.EndLine ?? args.limit,
        },
      }
    case "write_file":
      return {
        toolName: "Write",
        input: {
          file_path: first(args.Path, args.TargetFile, args.target_file, args.path, args.file_path, diffPath, locationPath) ?? "",
          content: (typeof args.Content === "string" ? args.Content : typeof args.content === "string" ? args.content : diffNew) ?? "",
        },
      }
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return {
        toolName: "Edit",
        input: {
          file_path: first(args.Path, args.TargetFile, args.target_file, args.path, args.file_path, diffPath, locationPath) ?? "",
          old_string: (
            typeof args.Target === "string" ? args.Target
            : typeof args.TargetContent === "string" ? args.TargetContent
            : typeof args.target_content === "string" ? args.target_content
            : first(args.OldString, args.old_string, args.oldString, args.target, firstChunk?.TargetContent, firstChunk?.target_content) ?? diffOld
          ) ?? "",
          new_string: (
            typeof args.Replacement === "string" ? args.Replacement
            : typeof args.ReplacementContent === "string" ? args.ReplacementContent
            : typeof args.replacement_content === "string" ? args.replacement_content
            : first(args.NewString, args.new_string, args.newString, args.replacement, firstChunk?.ReplacementContent, firstChunk?.replacement_content) ?? diffNew
          ) ?? "",
        },
      }
    case "grep_search":
      return { toolName: "Grep", input: { ...args, pattern: first(args.Pattern, args.pattern, args.Query, args.query) ?? "" } }
    case "find_by_name":
      return { toolName: "Glob", input: { ...args, pattern: first(args.Pattern, args.pattern, args.Name, args.name) ?? "" } }
    case "list_dir":
      return { toolName: "Glob", input: { pattern: `${String(first(args.Path, args.path, locationPath) || ".").replace(/[\\/]+$/, "")}/*` } }
    case "search_web":
      return { toolName: "WebSearch", input: { query: first(args.Query, args.query) ?? "" } }
    case "ask_question":
      return {
        toolName: "AskUserQuestion",
        input: {
          questions: Array.isArray(args.questions)
            ? args.questions.map(item => {
                const q = record(item)
                const rawOptions = Array.isArray(q.options) ? q.options : []
                return {
                  ...(text(q.id) ? { id: text(q.id) } : {}),
                  question: text(q.question),
                  ...(text(q.header) ? { header: text(q.header) } : {}),
                  multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : q.is_multi_select === true,
                  options: rawOptions.map(opt => typeof opt === "string"
                    ? { label: opt }
                    : {
                        label: text(record(opt).label) || text(record(opt).name) || text(record(opt).optionId),
                        ...(text(record(opt).description) ? { description: text(record(opt).description) } : {}),
                      }).filter(opt => opt.label),
                }
              })
            : [],
        },
      }
    case "invoke_subagent":
      return { toolName: "Task", input: { ...args, subagent_type: first(args.TypeName, args.type_name, args.subagent_type, args.Role, args.role) ?? "general" } }
    default: {
      if (!rawName || rawName === "unknown") {
        if (diffBlock) {
          if (diffBlock.oldText === null) {
            return { toolName: "Write", input: { file_path: diffPath ?? locationPath ?? "", content: diffNew ?? "" } }
          }
          return { toolName: "Edit", input: { file_path: diffPath ?? locationPath ?? "", old_string: diffOld ?? "", new_string: diffNew ?? "" } }
        }
        if (kind === "read") {
          return { toolName: "Read", input: { file_path: first(args.Path, args.absolute_path, args.path, args.file_path, locationPath) ?? "", offset: args.StartLine ?? args.offset ?? locationLine, limit: args.EndLine ?? args.limit } }
        }
        if (kind === "edit") {
          return { toolName: "Edit", input: { file_path: first(args.Path, args.TargetFile, args.path, args.file_path, locationPath) ?? "", old_string: first(args.Target, args.OldString, args.old_string, args.oldString, args.target) ?? "", new_string: first(args.Replacement, args.NewString, args.new_string, args.newString, args.replacement) ?? "" } }
        }
        if (kind === "execute") {
          return { toolName: "Bash", input: { ...args, command: first(args.CommandLine, args.command_line, args.commandLine, args.command, acp?.title) ?? "" } }
        }
        if (kind === "search") {
          return { toolName: "Grep", input: { ...args, pattern: first(args.Pattern, args.pattern, args.Query, args.query, acp?.title) ?? "" } }
        }
        if (kind === "fetch") {
          return { toolName: "WebSearch", input: { query: first(args.Query, args.query, args.url, acp?.title) ?? "" } }
        }
      }
      return { toolName: rawName || "unknown", input: args }
    }
  }
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const CANCEL_GRACE_MS = 300
const CLOSE_REQUEST_TIMEOUT_MS = 300
const EXIT_GRACE_MS = 200

function isRecoverableAntigravityResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes("different project directory")) return false
  return ["not found", "no rollout", "missing session", "no such session", "unknown session", "does not exist", "enoent"].some(
    snippet => message.includes(snippet),
  )
}

function unwrapAcpContentBlocks(blocks: unknown[]): unknown[] {
  return blocks.map(raw => {
    const block = record(raw)
    if (text(block.type) === "content") {
      const inner = record(block.content)
      if (text(inner.type) === "text" || text(inner.type) === "image") return inner
    }
    return raw
  })
}

export class AntigravityAcpConnection {
  private nextId = 1
  private buffered = ""
  private readonly pending = new Map<string, PendingRequest>()
  private failed: Error | undefined
  exited = false
  readonly closedPromise: Promise<void>
  onNotification?: (method: string, params: JsonObject) => void
  onServerRequest?: (id: string | number, method: string, params: JsonObject) => void
  onProtocolError?: (error: Error) => void
  onClose?: (error: Error) => void
  constructor(readonly child: ChildProcess) {
    let resolveClosed!: () => void
    this.closedPromise = new Promise<void>(resolve => { resolveClosed = resolve })
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.read(chunk))
    child.stdout?.once("end", () => {
      if (!this.failed && this.buffered.trim()) this.read("\n")
    })
    const close = (error: Error) => {
      this.exited = true
      resolveClosed()
      if (this.failed) return
      this.failed = error
      this.buffered = ""
      for (const pending of Array.from(this.pending.values())) pending.reject(error)
      this.pending.clear()
      this.onClose?.(error)
    }
    child.once("exit", () => { this.exited = true })
    child.once("error", error => close(error))
    child.once("close", () => close(new Error("Antigravity ACP process exited")))
    child.stdin?.on("error", () => {
      if (!this.failed) {
        this.failed = new Error("Antigravity ACP stdin closed")
        this.buffered = ""
        for (const pending of Array.from(this.pending.values())) pending.reject(this.failed)
        this.pending.clear()
        this.onClose?.(this.failed)
      }
    })
  }
  get isClosed() { return Boolean(this.failed) || this.exited }
  private read(chunk: string) {
    if (this.failed) return
    this.buffered += chunk
    for (let end = this.buffered.indexOf("\n"); end >= 0; end = this.buffered.indexOf("\n")) {
      if (this.failed) return
      const line = this.buffered.slice(0, end).trim()
      this.buffered = this.buffered.slice(end + 1)
      if (!line) continue
      let message: JsonObject
      try { message = record(JSON.parse(line)) } catch { continue }
      const method = text(message.method)
      const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined
      if (method && id !== undefined) {
        if (this.onServerRequest) this.onServerRequest(id, method, record(message.params))
        else try { this.respondError(id, -32601, `Method not found: ${method}`) } catch {}
      } else if (method && message.id === null) {
        try { this.respondError(null, -32600, `Invalid Request: ${method}`) } catch {}
      } else if (method) {
        this.onNotification?.(method, record(message.params))
      } else if (id !== undefined) {
        const pending = this.pending.get(String(id))
        if (!pending) continue
        this.pending.delete(String(id))
        if (message.error != null) {
          const error = record(message.error)
          pending.reject(new Error(text(error.message) || `Antigravity ${pending.method} failed`))
        } else pending.resolve(message.result)
      } else if (message.error != null) {
        const error = record(message.error)
        const protocolError = new Error(text(error.message) || "Antigravity ACP protocol error")
        if (this.pending.size > 0) {
          for (const pending of Array.from(this.pending.values())) pending.reject(protocolError)
          this.pending.clear()
        } else {
          this.onProtocolError?.(protocolError)
        }
      }
    }
    if (this.buffered.length > 4 * 1024 * 1024) {
      this.fail(new Error("Antigravity ACP message buffer limit"))
    }
  }
  write(message: JsonObject) {
    if (this.failed) throw this.failed
    if (!this.child.stdin || this.child.stdin.destroyed) throw new Error("Antigravity ACP stdin closed")
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  request(method: string, params: JsonObject, timeoutMs = 15_000, signal?: AbortSignal): Promise<JsonObject> {
    if (this.failed) return Promise.reject(this.failed)
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Antigravity request aborted"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        this.pending.delete(String(id))
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error(`Antigravity ${method} cancelled`))
      }
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        cleanup()
        reject(new Error(`Antigravity ${method} timed out`))
      }, timeoutMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(String(id), {
        method,
        resolve: result => { cleanup(); resolve(record(result)) },
        reject: error => { cleanup(); reject(error) },
      })
      try { this.write({ jsonrpc: "2.0", id, method, params }) }
      catch (error) { this.pending.delete(String(id)); cleanup(); reject(error) }
    })
  }
  respond(id: string | number, result: JsonObject) {
    this.write({ jsonrpc: "2.0", id, result })
  }
  respondError(id: string | number | null, code: number, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } })
  }
  notify(method: string, params: JsonObject) {
    this.write({ jsonrpc: "2.0", method, params })
  }
  fail(error: Error) {
    if (!this.failed) {
      this.failed = error
      this.buffered = ""
      for (const pending of Array.from(this.pending.values())) pending.reject(error)
      this.pending.clear()
      this.onClose?.(error)
    }
  }
}

interface AdvertisedCommand {
  name: string
  description: string
  hint?: string
}

interface ChatAcp {
  instance: string
  key: string
  cwd: string
  child: ChildProcess
  connection: AntigravityAcpConnection
  runtime: EngineRuntime
  agentCapabilities?: JsonObject
  sessionId?: string
  systemPrompt?: string
  commands: Map<string, AdvertisedCommand>
  commandListeners: Set<() => void>
  commandRuntime?: NativeCommandRuntime
  initializing?: { controller: AbortController; done: Promise<void> }
  closed: boolean
  turn?: {
    sessionId: string
    promptSettled: Promise<void>
    notification(method: string, params: JsonObject): void
    serverRequest(id: string | number, method: string, params: JsonObject): void
    fail(message: string): void
    cancel(): void
  }
}

export interface StartAntigravityTurnArgs {
  chatId: string
  cwd: string
  content: string
  model: string
  runtime?: EngineRuntime
  systemPrompt?: string
  memoryContext?: string
  nativeCommand?: boolean
  sessionToken?: string | null
  forkSession?: boolean
  allowResumeFallback?: boolean
  planMode?: boolean
  signal?: AbortSignal
  executionPolicy?: AntigravityPolicy
  isPolicyCurrent?: () => boolean
  onExecutionPolicyApplied?: (nativeSessionId?: string) => Promise<void>
  onToolRequest?: (request: HarnessToolRequest) => Promise<unknown>
  onPermissionRequest?: (request: JsonObject, tool?: { name: string; input: JsonObject }) => Promise<boolean>
  onLaunch?: (launch: AntigravityParentLaunch) => void
}

const DEFAULT_SYSTEM_PROMPT = "Use the memory context supplied with the current user message for that turn. Earlier memory blocks are historical snapshots and may have been updated."

function boundedWait(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => {}, () => {}),
    new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

export class AntigravityAgentManager {
  private readonly chats = new Map<string, ChatAcp>()
  private readonly pending = new Map<string, { promise: Promise<ChatAcp>; controller: AbortController }>()
  private readonly generations = new Map<string, number>()
  private readonly interruptions = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly sessionCwds = new Map<string, string>()
  private disposed = false
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  private async terminateProcessTree(child: ChildProcess, connection: AntigravityAcpConnection) {
    const pid = child.pid
    const validPid = typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== process.pid
    if (process.platform === "win32") {
      // Kill the tree before closing stdin so a parent exiting on EOF cannot
      // bypass taskkill /T /F (process-utils skips already-exited children).
      if (!connection.exited && child.exitCode == null && child.signalCode == null) {
        await killProcessTree(child).catch(() => {})
      }
      try { child.stdin?.end() } catch {}
      await boundedWait(connection.closedPromise, EXIT_GRACE_MS)
      return
    }
    const signalGroup = (signal: NodeJS.Signals | 0) => {
      if (!validPid) return false
      try { process.kill(-pid, signal); return true } catch { return false }
    }
    try { child.stdin?.end() } catch {}
    // Signal the detached process group so descendants receive SIGTERM even if
    // the root CLI already exited during session/close or stdin EOF.
    const signalledGroup = signalGroup("SIGTERM")
    if (!signalledGroup && !connection.exited && child.exitCode == null && child.signalCode == null) {
      try { child.kill("SIGTERM") } catch {}
    }
    const graceDeadline = Date.now() + EXIT_GRACE_MS
    if (!connection.exited && child.exitCode == null && child.signalCode == null) {
      await boundedWait(connection.closedPromise, EXIT_GRACE_MS)
    }
    if (signalledGroup) {
      while (signalGroup(0) && Date.now() < graceDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    if (!connection.exited && child.exitCode == null && child.signalCode == null) {
      await killProcessTree(child).catch(() => {})
    }
    if (signalGroup(0)) {
      signalGroup("SIGKILL")
      const killDeadline = Date.now() + EXIT_GRACE_MS
      while (signalGroup(0) && Date.now() < killDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    await boundedWait(connection.closedPromise, EXIT_GRACE_MS)
  }

  private async stop(chat: ChatAcp) {
    if (chat.closed) return
    chat.closed = true
    chat.initializing?.controller.abort()
    const activeTurn = chat.turn
    if (activeTurn) {
      if (!chat.connection.isClosed) {
        try { chat.connection.notify("session/cancel", { sessionId: activeTurn.sessionId }) } catch {}
      }
      activeTurn.cancel()
      if (!chat.connection.exited) {
        await boundedWait(Promise.race([activeTurn.promptSettled, chat.connection.closedPromise]), CANCEL_GRACE_MS)
      }
    }
    await chat.initializing?.done.catch(() => {})
    if (!chat.connection.isClosed && chat.sessionId) {
      await chat.connection.request("session/close", { sessionId: chat.sessionId }, CLOSE_REQUEST_TIMEOUT_MS).catch(() => {})
    }
    chat.connection.fail(new Error("Antigravity session closed"))
    chat.commandListeners.clear()
    await this.terminateProcessTree(chat.child, chat.connection)
  }
  hasSession(chatId: string) { return Boolean(this.chats.get(chatId) && !this.chats.get(chatId)!.closed) }
  getCommandRuntime(chatId: string): NativeCommandRuntime | undefined {
    const chat = this.chats.get(chatId)
    if (!chat?.sessionId || chat.closed) return undefined
    const version = chat.runtime.executable.version ?? "unknown"
    const commandSource: RuntimeSourceProof = { api: "ACP session/update available_commands_update", version, evidence: "native-response" }
    const unsupportedSource: RuntimeSourceProof = { api: "ACP session/new", version, evidence: "public-api" }
    return chat.commandRuntime ??= {
      instance: chat.instance,
      get session() { return chat.sessionId! },
      version,
      alive: () => !chat.closed && this.chats.get(chatId) === chat,
      onChanged: listener => {
        chat.commandListeners.add(listener)
        return () => { chat.commandListeners.delete(listener) }
      },
      async discover() {
        const items: RuntimeCommand[] = [...chat.commands.values()].map(cmd => ({
          id: `native:${cmd.name}`,
          name: cmd.name,
          description: cmd.description,
          namespace: "native",
          owner: "native-engine",
          arguments: { type: "string", ...(cmd.hint ? { hint: cmd.hint } : {}) },
          requiresIdle: true,
          sideEffect: "model-turn",
          route: "native-prompt",
          source: commandSource,
          requiredRuntimeVersion: version,
        }))
        return {
          commands: discovery("ready", items, commandSource),
          skills: discovery("unsupported", [], unsupportedSource, "Antigravity ACP does not expose skill inventory"),
          connectors: discovery("unsupported", [], unsupportedSource, "Antigravity ACP does not expose MCP connector status"),
        }
      },
    }
  }
  hasPendingWork(chatId: string) {
    const chat = this.chats.get(chatId)
    return this.pending.has(chatId) || this.interruptions.has(chatId) || this.stopping.has(chatId) || Boolean(chat?.turn || chat?.initializing)
  }
  private retire(chatId: string, chat: ChatAcp) {
    if (this.chats.get(chatId) !== chat) return this.stopping.get(chatId)
    this.chats.delete(chatId)
    let tracked!: Promise<void>
    tracked = this.stop(chat).finally(() => {
      if (this.stopping.get(chatId) === tracked) this.stopping.delete(chatId)
    })
    this.stopping.set(chatId, tracked)
    void tracked.catch(() => {})
    return tracked
  }
  async closeChat(chatId: string): Promise<void> {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1)
    const pending = this.pending.get(chatId)
    pending?.controller.abort()
    const chat = this.chats.get(chatId)
    await Promise.all([
      pending?.promise.catch(() => {}),
      this.interruptions.get(chatId),
      chat ? this.retire(chatId, chat) : this.stopping.get(chatId),
    ])
  }
  async dispose() {
    this.disposed = true
    await Promise.allSettled([...new Set([...this.chats.keys(), ...this.pending.keys(), ...this.interruptions.keys(), ...this.stopping.keys()])].map(id => this.closeChat(id)))
  }

  private async verifySessionCwdOwnership(chat: ChatAcp, sessionId: string, cwd: string, signal: AbortSignal) {
    const known = this.sessionCwds.get(sessionId)
    if (known && known !== cwd) {
      throw new Error("Antigravity session belongs to a different project directory")
    }
    if (known === cwd) return
    const listCap = record(record(chat.agentCapabilities).sessionCapabilities).list
    if (listCap === undefined) return
    let listedInCwd = false
    let cursor: string | undefined
    try {
      for (let page = 0; page < 5; page++) {
        const listed = await chat.connection.request("session/list", { cwd, ...(cursor ? { cursor } : {}) }, 5_000, signal)
        for (const item of array(listed.sessions)) {
          const id = text(item.sessionId)
          const itemCwd = text(item.cwd)
          if (id && itemCwd) {
            const resolvedItemCwd = await realpath(itemCwd).catch(() => itemCwd)
            this.sessionCwds.set(id, resolvedItemCwd)
            if (id === sessionId && resolvedItemCwd !== cwd) {
              throw new Error("Antigravity session belongs to a different project directory")
            }
          }
          if (id === sessionId) listedInCwd = true
        }
        cursor = text(listed.nextCursor) || undefined
        if (listedInCwd || !cursor) break
      }
      if (!listedInCwd) {
        let allCursor: string | undefined
        for (let page = 0; page < 5; page++) {
          const allListed = await chat.connection.request("session/list", allCursor ? { cursor: allCursor } : {}, 5_000, signal)
          for (const item of array(allListed.sessions)) {
            const id = text(item.sessionId)
            const itemCwd = text(item.cwd)
            if (!id || !itemCwd) continue
            const resolvedItemCwd = await realpath(itemCwd).catch(() => itemCwd)
            this.sessionCwds.set(id, resolvedItemCwd)
            if (id === sessionId && resolvedItemCwd !== cwd) {
              throw new Error("Antigravity session belongs to a different project directory")
            }
          }
          allCursor = text(allListed.nextCursor) || undefined
          if (this.sessionCwds.has(sessionId) || !allCursor) break
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("different project directory")) throw error
      signal.throwIfAborted()
      // Ignore optional session/list errors (-32601 etc.) on servers that do not implement listing.
    }
  }

  private async ensureConnection(args: StartAntigravityTurnArgs, runtime: EngineRuntime): Promise<ChatAcp> {
    const key = createHash("sha256").update(JSON.stringify([args.cwd, runtime.executable.path, runtime.env, runtime.args])).digest("hex")
    const previous = this.chats.get(args.chatId)
    if (previous?.key === key && !previous.closed) return previous
    const generation = this.generations.get(args.chatId) ?? 0
    if (previous) await this.retire(args.chatId, previous)
    args.signal?.throwIfAborted()
    if (this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) throw new Error("Antigravity start cancelled")
    const launcher = runtime.launcher ?? await executableLauncher(runtime.executable.path!, runtime.env)
    args.signal?.throwIfAborted()
    if (this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) throw new Error("Antigravity start cancelled")
    const child = this.spawnProcess(launcher.command, [...launcher.args, ...(runtime.args.length ? runtime.args : ["acp"])], {
      cwd: args.cwd, env: runtime.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true,
    })
    const connection = new AntigravityAcpConnection(child)
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    const chat: ChatAcp = {
      instance: crypto.randomUUID(),
      key,
      cwd: args.cwd,
      child,
      connection,
      runtime,
      commands: new Map(),
      commandListeners: new Set(),
      closed: false,
    }
    connection.onClose = error => { if (!chat.closed) { chat.turn?.fail(error.message); void this.retire(args.chatId, chat) } }
    connection.onProtocolError = error => { if (!chat.closed) chat.turn?.fail(error.message) }
    connection.onNotification = (method, params) => {
      if (method === "session/update" && (!chat.sessionId || text(params.sessionId) === chat.sessionId)) {
        const update = record(params.update)
        if (text(update.sessionUpdate) === "available_commands_update") {
          chat.commands.clear()
          for (const item of array(update.availableCommands)) {
            const name = text(item.name).replace(/^\//, "").trim()
            if (!name) continue
            const hint = text(record(item.input).hint) || undefined
            chat.commands.set(name, { name, description: text(item.description), ...(hint ? { hint } : {}) })
          }
          for (const listener of chat.commandListeners) listener()
        }
      }
      chat.turn?.notification(method, params)
    }
    connection.onServerRequest = (id, method, params) => {
      if (chat.turn) chat.turn.serverRequest(id, method, params)
      else try { connection.respondError(id, -32601, `Method not found: ${method}`) } catch {}
    }
    try {
      const result = await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          session: { configOptions: { boolean: {} }, notices: {} }, plan: {},
        },
        clientInfo: { name: "memosync", title: "MemoSync", version: "0" },
      }, 10_000, args.signal)
      if (result.protocolVersion !== 1) throw new Error("Antigravity ACP protocol version unsupported")
      chat.agentCapabilities = record(result.agentCapabilities)
      args.signal?.throwIfAborted()
      if (this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) throw new Error("Antigravity start cancelled")
      this.chats.set(args.chatId, chat)
      return chat
    } catch (error) {
      await this.terminateProcessTree(child, connection).catch(() => {})
      const detail = stderr.trim()
      throw error instanceof Error && detail ? new Error(`${error.message}${error.message.includes(detail) ? "" : `: ${detail}`}`) : error
    }
  }

  async prepareSession(args: Omit<StartAntigravityTurnArgs, "content">): Promise<string> {
    const prepared = await this.initializeSession({ ...args, content: "" })
    return prepared.sessionId
  }

  private async initializeSession(args: StartAntigravityTurnArgs) {
    const generation = this.generations.get(args.chatId) ?? 0
    const assertCurrent = () => {
      args.signal?.throwIfAborted()
      if (this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) {
        throw new Error("Antigravity start cancelled")
      }
    }
    assertCurrent()
    if (args.forkSession) throw new Error("Antigravity ACP does not support session fork")
    args = { ...args, cwd: await realpath(args.cwd) }
    assertCurrent()
    const runtime = args.runtime ?? await resolveEngineRuntime({ engine: "antigravity", model: args.model })
    if (runtime.engine !== "antigravity") throw new Error("engine-runtime-mismatch")
    assertCurrent()
    await Promise.all([this.interruptions.get(args.chatId), this.stopping.get(args.chatId)])
    assertCurrent()
    if (this.pending.has(args.chatId)) throw new Error("Antigravity chat is starting")
    const startController = new AbortController()
    const signalForStart = args.signal ? AbortSignal.any([args.signal, startController.signal]) : startController.signal
    const pending = { controller: startController, promise: this.ensureConnection({ ...args, signal: signalForStart }, runtime) }
    this.pending.set(args.chatId, pending)
    let chat: ChatAcp
    try { chat = await pending.promise } finally { if (this.pending.get(args.chatId) === pending) this.pending.delete(args.chatId) }
    startController.signal.throwIfAborted()
    assertCurrent()
    if (chat.closed) throw new Error("Antigravity start cancelled")
    if (chat.turn || chat.initializing) throw new Error("Antigravity chat is already running")
    const systemPrompt = args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    args.onLaunch?.({ provider: "antigravity", options: { model: runtime.model || args.model, runtime, systemPrompt } })
    let initialized!: () => void
    const initialization = { controller: new AbortController(), done: new Promise<void>(resolve => { initialized = resolve }) }
    chat.initializing = initialization
    const initSignal = args.signal ? AbortSignal.any([args.signal, initialization.controller.signal]) : initialization.controller.signal
    let sessionId = ""
    try {
      try {
        sessionId = args.sessionToken === null ? "" : (args.sessionToken || chat.sessionId || "")
        if (args.sessionToken === null && chat.sessionId) {
          const previousSessionId = chat.sessionId
          chat.sessionId = undefined
          chat.systemPrompt = undefined
          chat.commandRuntime = undefined
          chat.commands.clear()
          for (const listener of chat.commandListeners) listener()
          await chat.connection.request("session/close", { sessionId: previousSessionId }, CLOSE_REQUEST_TIMEOUT_MS, initSignal).catch(() => {})
        }
        const createNewSession = async () => {
          const created = await chat.connection.request("session/new", {
            cwd: args.cwd,
            mcpServers: [],
            ...(systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}),
          }, 20_000, initSignal)
          return text(created.sessionId)
        }
        if (sessionId) {
          await this.verifySessionCwdOwnership(chat, sessionId, args.cwd, initSignal)
          if (sessionId !== chat.sessionId || chat.systemPrompt !== systemPrompt) {
            try {
              const resumed = await chat.connection.request("session/resume", {
                sessionId,
                cwd: args.cwd,
                mcpServers: [],
                ...(systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}),
              }, 15_000, initSignal)
              const resumedCwd = text(resumed.cwd) || text(record(resumed._meta).cwd)
              if (resumedCwd) {
                const resolvedResumedCwd = await realpath(resumedCwd).catch(() => resumedCwd)
                if (resolvedResumedCwd !== args.cwd) {
                  const foreignId = text(resumed.sessionId) || sessionId
                  this.sessionCwds.set(foreignId, resolvedResumedCwd)
                  await chat.connection.request("session/close", { sessionId: foreignId }, CLOSE_REQUEST_TIMEOUT_MS).catch(() => {})
                  throw new Error("Antigravity session belongs to a different project directory")
                }
              }
              sessionId = text(resumed.sessionId) || sessionId
            } catch (error) {
              initSignal.throwIfAborted()
              assertCurrent()
              if (args.allowResumeFallback === false || !isRecoverableAntigravityResumeError(error)) {
                throw error
              }
              sessionId = await createNewSession()
            }
          }
        } else {
          sessionId = await createNewSession()
        }
        initSignal.throwIfAborted()
        assertCurrent()
        if (!sessionId) throw new Error("Antigravity did not return a session identifier")
        this.sessionCwds.set(sessionId, args.cwd)
        const desiredMode = args.planMode ? "plan" : "default"
        if (args.model) {
          await chat.connection.request("session/set_config_option", { sessionId, configId: "model", value: args.model }, 10_000, initSignal)
          initSignal.throwIfAborted()
          assertCurrent()
        }
        const modeResult = await chat.connection.request("session/set_config_option", { sessionId, configId: "mode", value: desiredMode }, 10_000, initSignal)
        initSignal.throwIfAborted()
        assertCurrent()
        const options = array(modeResult.configOptions)
        const mode = options.find(option => option.id === "mode")
        if (!mode || mode.currentValue !== desiredMode) throw new Error("Antigravity did not confirm the requested session mode")
        if (args.executionPolicy) {
          if (args.isPolicyCurrent?.() === false) throw new Error("Stale execution policy acknowledgement")
          await args.onExecutionPolicyApplied?.(sessionId)
          initSignal.throwIfAborted()
          assertCurrent()
        }
        if (chat.sessionId !== sessionId) chat.commandRuntime = undefined
        chat.sessionId = sessionId
        chat.systemPrompt = systemPrompt
      } finally {
        if (chat.initializing === initialization) chat.initializing = undefined
        initialized()
      }
      return { chat, runtime, sessionId }
    } catch (error) {
      if (initSignal.aborted || this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) {
        await this.retire(args.chatId, chat)
      }
      throw error
    }
  }

  async startTurn(args: StartAntigravityTurnArgs): Promise<HarnessTurn> {
    const { chat, runtime, sessionId } = await this.initializeSession(args)
    const queue = new Queue<HarnessEvent>()
    const started = Date.now()
    let finished = false, cancelRequested = false, assistant = "", segment = 0
    let currentItemId = `agent-message-${++segment}`
    interface TrackedTool {
      name: string
      input: JsonObject
      acp: AntigravityAcpToolHints
      emitted: boolean
      result: boolean
    }
    const tools = new Map<string, TrackedTool>()
    const questions = new Set<string>()
    let questionQueue = Promise.resolve()
    let planSequence = 0
    let latestPlanText = ""
    const planMarkdown = new Map<string, string>()
    const renderPlan = (entries: JsonObject[]) => entries.map(item => {
      const status = text(item.status)
      return `- ${status === "completed" ? "[x]" : "[ ]"} ${text(item.content)}`
    }).filter(Boolean).join("\n")
    let resolvePromptSettled!: () => void
    const promptSettled = new Promise<void>(resolve => { resolvePromptSettled = resolve })
    const transcript = (value: Parameters<typeof entry>[0], itemId?: string) => queue.push({ type: "transcript", entry: entry(value), itemId })
    const flushAssistant = () => {
      if (!assistant) return
      const textSegment = assistant
      const itemId = currentItemId
      assistant = ""
      currentItemId = `agent-message-${++segment}`
      transcript({ kind: "assistant_text", text: textSegment }, itemId)
    }
    let aborting: Promise<void> | undefined
    const finalize = (message = "", isError = false, cancelled = false) => {
      if (finished) return
      finished = true
      args.signal?.removeEventListener("abort", onAbort)
      if (!cancelled) flushAssistant()
      for (const [toolId, tracked] of tools) {
        if (tracked.emitted && !tracked.result) {
          tracked.result = true
          transcript({
            kind: "tool_result",
            toolId,
            isError: true,
            content: cancelled ? "Tool call cancelled" : (message || "Tool call interrupted"),
          })
        }
      }
      if (chat.turn?.sessionId === sessionId) chat.turn = undefined
      transcript({ kind: "result", subtype: cancelled ? "cancelled" : isError ? "error" : "success", isError, durationMs: Date.now() - started, result: message })
      queue.finish()
    }
    const toolPayload = (update: JsonObject): JsonObject => record(update.rawInput ?? update.args ?? update.input)
    const extractAcpHints = (source: JsonObject, base?: AntigravityAcpToolHints): AntigravityAcpToolHints => {
      const kind = text(source.kind) || base?.kind
      const title = text(source.title) || base?.title
      const locations = Array.isArray(source.locations) ? array(source.locations) : base?.locations
      const content = Array.isArray(source.content) ? array(source.content) : base?.content
      return {
        ...(kind ? { kind } : {}),
        ...(title ? { title } : {}),
        ...(locations?.length ? { locations } : {}),
        ...(content?.length ? { content } : {}),
      }
    }
    const mergeTrackedTool = (id: string, source: JsonObject): TrackedTool => {
      const existing = tools.get(id)
      const input = toolPayload(source)
      const meta = record(source._meta)
      const candidateName = text(source.name) || text(record(source.toolCall).name) || text(meta.toolName) || text(meta.name)
      const reportedName = candidateName && candidateName !== "unknown" ? candidateName : ""
      const acp = extractAcpHints(source, existing?.acp)
      const current: TrackedTool = existing ?? {
        name: reportedName || "unknown",
        input,
        acp,
        emitted: false,
        result: false,
      }
      if (reportedName) current.name = reportedName
      if (Object.keys(input).length) current.input = { ...current.input, ...input }
      current.acp = acp
      tools.set(id, current)
      return current
    }
    const emitTrackedCall = (id: string, current: TrackedTool) => {
      if (current.emitted) return
      flushAssistant()
      current.emitted = true
      const translated = translateAntigravityTool(current.name, current.input, current.acp)
      transcript({ kind: "tool_call", tool: normalizeToolCall({ ...translated, toolId: id }) })
    }
    const emitTool = (update: JsonObject) => {
      const id = text(update.toolCallId)
      if (!id) return
      // Interactive questions publish through their permission request so options
      // and answer controls correlate with bindPolicyQuestion.
      if (id.startsWith("interaction_")) return
      const status = text(update.status)
      const isTerminal = status === "completed" || status === "failed" || status === "cancelled" || status === "error" || status === "rejected"
      const current = mergeTrackedTool(id, update)
      if (current.name === "ask_question" && !isTerminal) return
      // Flush preceding assistant prose as soon as a tool step begins, even if
      // the tool card itself waits for non-empty arguments to arrive.
      flushAssistant()
      const hasAcpDetails = Boolean(current.acp.locations?.length || current.acp.content?.some(b => text(b.type) === "diff"))
      if (!current.emitted && (status !== "pending" || Object.keys(current.input).length > 0 || hasAcpDetails)) {
        emitTrackedCall(id, current)
      }
      if (isTerminal && !current.result) {
        emitTrackedCall(id, current)
        current.result = true
        const isFailure = status === "failed" || status === "cancelled" || status === "error" || status === "rejected"
        const rawOut = update.rawOutput
        const errorText = text(update.error)
        const hasNonEmptyRawOut = rawOut !== undefined && rawOut !== null && (
          typeof rawOut === "string"
            ? (rawOut.length > 0 || (!isFailure && !Array.isArray(update.content)))
            : typeof rawOut !== "object" || Array.isArray(rawOut) || Object.keys(rawOut as JsonObject).length > 0
        )
        const content = hasNonEmptyRawOut
          ? rawOut
          : Array.isArray(update.content) && update.content.length > 0
            ? unwrapAcpContentBlocks(update.content)
            : errorText || (status === "cancelled" || status === "rejected" ? "Tool call cancelled" : isFailure ? "Tool call failed" : (rawOut === "" ? "" : record(rawOut)))
        transcript({ kind: "tool_result", toolId: id, content, isError: isFailure })
      }
    }
    const permissionOutcome = async (id: string | number, request: JsonObject) => {
      const permission = args.executionPolicy?.permission ?? "ask"
      if (permission === "allow") return true
      if (permission === "deny") return false
      const call = record(request.toolCall)
      const input = toolPayload(call)
      const name = text(call.name) || text(record(call._meta).toolName) || text(call.title) || "permission"
      return args.onPermissionRequest ? await args.onPermissionRequest({ ...request, id }, { name, input }) : false
    }
    const respondCancelled = (id: string | number) => {
      try { chat.connection.respond(id, { outcome: { outcome: "cancelled" } }) } catch {}
    }
    const answerPermission = async (id: string | number, request: JsonObject) => {
      const options = array(request.options)
      const call = record(request.toolCall)
      const toolId = text(call.toolCallId)
      try {
        if (toolId.startsWith("interaction_")) {
          const requestKey = `${String(id)}:${toolId}`
          if (questions.has(requestKey)) return
          questions.add(requestKey)
          const question = text(call.title) || "Choose an option."
          const selectable = options
            .map(option => {
              const optionId = text(option.optionId)
              const label = text(option.name) || optionId
              return optionId && label ? { optionId, label } : null
            })
            .filter((item): item is { optionId: string; label: string } => item !== null)
          const tool = normalizeToolCall({
            toolName: "AskUserQuestion",
            toolId,
            input: {
              questions: [{
                id: toolId,
                question,
                header: "Question",
                multiSelect: false,
                options: selectable.map(option => ({ label: option.label })),
              }],
            },
          }) as HarnessToolRequest["tool"]
          questionQueue = questionQueue.then(async () => {
            if (finished) {
              respondCancelled(id)
              return
            }
            if (!selectable.length || !args.onToolRequest) {
              if (!tools.get(toolId)?.emitted) {
                flushAssistant()
                tools.set(toolId, { name: "AskUserQuestion", input: tool.input as unknown as JsonObject, acp: {}, emitted: true, result: true })
                transcript({ kind: "tool_call", tool })
                transcript({
                  kind: "tool_result",
                  toolId,
                  isError: true,
                  content: !selectable.length
                    ? "Interactive question dismissed: Antigravity provided no selectable options."
                    : "Interactive question dismissed: user input is unavailable for this turn.",
                })
              }
              try { chat.connection.respond(id, { outcome: { outcome: "cancelled" } }) } catch { finalize("Antigravity permission reply failed", true) }
              return
            }
            if (!tools.get(toolId)?.emitted) {
              flushAssistant()
              tools.set(toolId, { name: "AskUserQuestion", input: tool.input as unknown as JsonObject, acp: {}, emitted: true, result: true })
              transcript({ kind: "tool_call", tool })
            }
            try {
              const response = record(await args.onToolRequest({ tool }))
              if (finished) {
                respondCancelled(id)
                return
              }
              const raw = record(response.answers ?? response)
              const firstEntry = Object.values(raw)[0]
              const candidateAnswer = record(raw[toolId]).answers ?? raw[toolId] ?? record(raw[question]).answers ?? raw[question] ?? record(firstEntry).answers ?? firstEntry
              const value = Array.isArray(candidateAnswer) ? text(candidateAnswer[0]) : text(candidateAnswer)
              const chosen = selectable.find(candidate => candidate.optionId === value || candidate.label === value)
              if (!chosen || response.error || response.cancelled || args.isPolicyCurrent?.() === false) {
                chat.connection.respond(id, { outcome: { outcome: "cancelled" } })
                return
              }
              chat.connection.respond(id, { outcome: { outcome: "selected", optionId: chosen.optionId } })
            } catch {
              if (!finished) {
                try { chat.connection.respond(id, { outcome: { outcome: "cancelled" } }) } catch { finalize("Antigravity permission reply failed", true) }
              } else {
                respondCancelled(id)
              }
            }
          })
          return
        }
        flushAssistant()
        if (toolId) {
          const trackedBefore = mergeTrackedTool(toolId, call)
          if (trackedBefore.name !== "ask_question" && (Object.keys(trackedBefore.input).length > 0 || trackedBefore.name !== "unknown")) {
            emitTrackedCall(toolId, trackedBefore)
          }
        }
        const allowed = await permissionOutcome(id, request)
        if (finished) {
          respondCancelled(id)
          return
        }
        const current = args.isPolicyCurrent?.() ?? true
        const approve = allowed && current
        // Never escalate a one-time approval to persistent allow_always scope.
        // When no allow_once option exists, deny/cancel the request instead.
        const option = approve
          ? options.find(candidate => candidate.kind === "allow_once" && text(candidate.optionId))
            ?? options.find(candidate => candidate.kind === "reject_once" && text(candidate.optionId))
          : options.find(candidate => candidate.kind === "reject_once" && text(candidate.optionId))
        if ((!approve || option?.kind !== "allow_once") && toolId) {
          const tracked = tools.get(toolId)
          if (tracked && !tracked.result) {
            emitTrackedCall(toolId, tracked)
            tracked.result = true
            transcript({ kind: "tool_result", toolId, isError: true, content: "Antigravity permission rejected" })
          }
        }
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
            queue.push({ type: "assistant_delta", itemId: currentItemId, delta })
          }
          break
        }
        case "tool_call":
        case "tool_call_update": emitTool(update); break
        case "plan":
        case "plan_update": {
          const payload = record(update.plan ?? update)
          const planId = text(payload.planId) || text(update.planId) || "plan"
          const entries = array(payload.entries ?? update.entries)
          let markdown = text(payload.content ?? update.content)
          if (entries.length) {
            markdown ||= renderPlan(entries)
            planMarkdown.set(planId, markdown)
            latestPlanText = markdown
            const todos = entries.map(item => ({
              content: text(item.content),
              status: text(item.status) === "completed" ? "completed" : text(item.status) === "in_progress" ? "in_progress" : "pending",
              activeForm: text(item.content),
            })).filter(item => item.content)
            if (todos.length) {
              flushAssistant()
              const toolId = `antigravity-plan-${planId}-${++planSequence}`
              transcript({ kind: "tool_call", tool: normalizeToolCall({ toolName: "TodoWrite", toolId, input: { todos } }) })
            }
          } else if (markdown) {
            planMarkdown.set(planId, markdown)
            latestPlanText = markdown
          }
          break
        }
        case "plan_removed": {
          const planId = text(update.planId) || "plan"
          planMarkdown.delete(planId)
          latestPlanText = [...planMarkdown.values()].at(-1) ?? ""
          break
        }
        case "usage_update": {
          const used = typeof update.used === "number" ? update.used : 0
          const size = typeof update.size === "number" ? update.size : undefined
          if (used > 0) transcript({ kind: "context_window_updated", usage: { usedTokens: used, maxTokens: size, compactsAutomatically: true } })
          break
        }
      }
    }
    const abort = (): Promise<void> => {
      if (aborting) return aborting
      if (finished) return this.interruptions.get(args.chatId) ?? this.stopping.get(args.chatId) ?? Promise.resolve()
      cancelRequested = true
      finalize("", false, true)
      let tracked!: Promise<void>
      tracked = (async () => {
        if (!chat.connection.isClosed) {
          try { chat.connection.notify("session/cancel", { sessionId }) } catch {}
          if (!chat.connection.exited) {
            await boundedWait(Promise.race([promptSettled, chat.connection.closedPromise]), CANCEL_GRACE_MS)
          }
        }
        await this.retire(args.chatId, chat)
      })().finally(() => {
        if (this.interruptions.get(args.chatId) === tracked) this.interruptions.delete(args.chatId)
      })
      aborting = tracked
      this.interruptions.set(args.chatId, tracked)
      void tracked.catch(() => {})
      return tracked
    }
    const onAbort = () => { void abort() }
    chat.turn = {
      sessionId,
      promptSettled,
      notification,
      serverRequest: (id, method, params) => {
        if (method === "session/request_permission") void answerPermission(id, params)
        else try { chat.connection.respondError(id, -32601, `Method not found: ${method}`) } catch {}
      },
      fail: message => finalize(message, true),
      cancel: () => finalize("", false, true),
    }
    args.signal?.addEventListener("abort", onAbort, { once: true })
    if (args.signal?.aborted || this.disposed || chat.closed || cancelRequested || finished) {
      resolvePromptSettled()
      await abort()
      args.signal?.throwIfAborted()
      throw new Error("Antigravity start cancelled")
    }
    if (args.isPolicyCurrent?.() === false) {
      resolvePromptSettled()
      await abort()
      throw new Error("Stale execution policy turn")
    }
    queue.push({ type: "session_token", sessionToken: sessionId })
    transcript({ kind: "system_init", provider: "antigravity", model: runtime.model || args.model || "default", tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"], agents: [], slashCommands: [...chat.commands.keys()], mcpServers: [] })
    const trimmedContent = args.content.trimStart()
    const isSlashCommand = Boolean(args.nativeCommand) || /^\/[A-Za-z][\w:.-]*(?:\s|$)/.test(trimmedContent)
    // ACP slash commands must lead the prompt; keep the command in its own
    // leading text block and deliver working memory after it instead of prefixing.
    const promptBlocks = args.memoryContext
      ? isSlashCommand
        ? [{ type: "text", text: trimmedContent }, { type: "text", text: args.memoryContext }]
        : [{ type: "text", text: `${args.memoryContext}\n\n${args.content}` }]
      : [{ type: "text", text: isSlashCommand ? trimmedContent : args.content }]
    if (!finished && !cancelRequested && !args.signal?.aborted) {
      void chat.connection.request("session/prompt", { sessionId, prompt: promptBlocks }, 24 * 60 * 60_000)
        .then(async result => {
          resolvePromptSettled()
          if (finished) return
          flushAssistant()
          const stop = text(result.stopReason)
          const cancelled = stop === "cancelled" || cancelRequested
          const usage = record(result.usage)
          const total = typeof usage.totalTokens === "number" ? usage.totalTokens : 0
          if (total > 0) transcript({ kind: "context_window_updated", usage: { usedTokens: total, inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined, outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined, cachedInputTokens: typeof usage.cachedReadTokens === "number" ? usage.cachedReadTokens : undefined, reasoningOutputTokens: typeof usage.thoughtTokens === "number" ? usage.thoughtTokens : undefined, lastUsedTokens: total, compactsAutomatically: true } })
          if (!cancelled && args.planMode && latestPlanText.trim() && args.onToolRequest) {
            const tool = normalizeToolCall({
              toolName: "ExitPlanMode",
              toolId: `${sessionId}:exit-plan`,
              input: { plan: latestPlanText },
            }) as HarnessToolRequest["tool"]
            transcript({ kind: "tool_call", tool })
            await args.onToolRequest({ tool }).catch(() => ({ cancelled: true }))
            if (finished) return
          }
          finalize("", false, cancelled)
        })
        .catch(error => {
          resolvePromptSettled()
          finalize(error instanceof Error ? error.message : "Antigravity prompt failed", true)
        })
    } else {
      resolvePromptSettled()
    }
    return { provider: "antigravity", stream: queue, interrupt: abort, close: () => { if (!finished) void abort() } }
  }
}
