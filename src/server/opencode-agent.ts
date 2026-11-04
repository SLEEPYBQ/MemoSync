import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { OpencodeClient, Event, Part, PermissionRequest } from '@opencode-ai/sdk/v2/client'
import type { TranscriptEntry } from '../shared/types'
import { normalizeToolCall } from '../shared/tools'
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from './harness-types'
import { resolveEngineRuntime, type EngineRuntime } from './model-access/runtime'
import { startOpencodeServer, OPENCODE_BRANCH_AGENT, type OpencodeServer } from './opencode-server'
import { createOpencodeMemoryMcp, type OpencodeMemoryDispatch } from './memory/opencode-adapter'
import type { MemoryToolSpec } from './memory/tools'
import type { OpencodeParentLaunch } from './memory/parent-launch'

let sdk: Promise<typeof import('@opencode-ai/sdk/v2/client')> | undefined
const loadSdk = () => sdk ??= import('@opencode-ai/sdk/v2/client')
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
type EntryInput = TranscriptEntry extends infer T ? T extends TranscriptEntry ? Omit<T, '_id' | 'createdAt'> : never : never
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

/** Claude-style names/inputs preserve the engine's callID as the audit toolId. */
export function translateOpencodeTool(rawName: string, args: Record<string, unknown>): { toolName: string; input: Record<string, unknown> } {
  if (rawName.startsWith('memosync_')) return { toolName: `mcp__memory__${rawName.slice(9)}`, input: args }
  switch (rawName) {
    case 'read': return { toolName: 'Read', input: { file_path: args.filePath ?? '', offset: args.offset, limit: args.limit } }
    case 'bash': return { toolName: 'Bash', input: { ...args, command: args.command ?? '', timeout: args.timeout } }
    case 'edit': return { toolName: 'Edit', input: { file_path: args.filePath ?? '', old_string: args.oldString ?? '', new_string: args.newString ?? '', replace_all: args.replaceAll } }
    case 'write': return { toolName: 'Write', input: { file_path: args.filePath ?? '', content: args.content ?? '' } }
    case 'grep': return { toolName: 'Grep', input: { ...args, glob: args.include } }
    case 'glob': return { toolName: 'Glob', input: args }
    case 'list': return { toolName: 'Glob', input: { ...args, pattern: `${String(args.path || '.').replace(/\/$/, '')}/*` } }
    case 'webfetch': return { toolName: 'WebFetch', input: args }
    case 'websearch': return { toolName: 'WebSearch', input: args }
    case 'todowrite': return { toolName: 'TodoWrite', input: args }
    case 'task': return { toolName: 'Task', input: { ...args, subagent_type: args.subagent_type ?? 'general' } }
    case 'question': return { toolName: 'AskUserQuestion', input: { questions: Array.isArray(args.questions) ? args.questions.map(q => ({ ...record(q), multiSelect: record(q).multiple === true })) : [] } }
    default: return { toolName: rawName, input: args }
  }
}

/** Stable across turns; selected memories belong to the current prompt parts. */
export const OPENCODE_SYSTEM_PROMPT = "Use the memory context supplied with the current user message for that turn. Earlier memory blocks are historical snapshots and may have been updated."

export interface StartOpencodeTurnArgs {
  chatId: string
  cwd: string
  content: string
  model: string
  runtime?: EngineRuntime
  /** Stable host instructions, also retained by memory-analysis forks. */
  systemPrompt?: string
  /** Current memory selection/reminders; appended to native conversation history. */
  memoryContext?: string
  sessionToken?: string | null
  forkSession?: boolean
  signal?: AbortSignal
  memorySpecs?: MemoryToolSpec[]
  memoryDispatch?: OpencodeMemoryDispatch
  onToolRequest?: (request: HarnessToolRequest) => Promise<unknown>
  onPermissionRequest?: (request: PermissionRequest, tool?: { name: string; input: Record<string, unknown> }) => Promise<boolean>
  agent?: 'memosync-branch'
  onLaunch?: (launch: OpencodeParentLaunch) => void
}

interface ChatServer {
  key: string
  runtime: EngineRuntime
  server: OpencodeServer
  client: OpencodeClient
  mcp?: ReturnType<typeof createOpencodeMemoryMcp>
  controller: AbortController
  turn?: { sessionID: string; handle(event: Event): void; fail(message: string): void; cancel(): void }
  initializing?: { controller: AbortController; done: Promise<void> }
  retiredMessages: Set<string>
  closed: boolean
}

function errorMessage(error: unknown): string {
  const value = record(error), data = record(value.data)
  // Never stringify provider errors: responseHeaders/body may contain credentials.
  return [typeof value.name === 'string' ? value.name : 'OpenCodeError', typeof data.message === 'string' ? data.message : 'OpenCode turn failed'].join(': ')
}

export class OpencodeAgentManager {
  private chats = new Map<string, ChatServer>()
  private pending = new Map<string, Promise<ChatServer>>()
  private generations = new Map<string, number>()
  private interruptions = new Map<string, Promise<void>>()
  private stopping = new Set<Promise<unknown>>()
  private disposed = false

  private track(promise: Promise<unknown>) { this.stopping.add(promise); void promise.finally(() => this.stopping.delete(promise)).catch(() => {}); return promise }
  private async stop(chat: ChatServer) {
    if (chat.closed) return
    chat.closed = true
    chat.turn?.cancel(); chat.initializing?.controller.abort(); chat.controller.abort(); chat.mcp?.close()
    // An analysis session may already exist without having reached its caller.
    // Keep the server alive until initialization has deleted that orphan.
    await chat.initializing?.done
    await chat.server.close()
  }
  hasSession(chatId: string) { return Boolean(this.chats.get(chatId) && !this.chats.get(chatId)!.closed) }
  hasPendingWork(chatId: string) { const chat = this.chats.get(chatId); return this.pending.has(chatId) || Boolean(chat?.turn || chat?.initializing) }
  closeChat(chatId: string): void {
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1)
    const chat = this.chats.get(chatId)
    this.chats.delete(chatId)
    if (chat) this.track(this.stop(chat))
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of new Set([...this.chats.keys(), ...this.pending.keys()])) this.closeChat(id)
    await Promise.allSettled([...this.pending.values(), ...this.interruptions.values(), ...this.stopping])
    await Promise.allSettled([...this.stopping])
  }
  /** Analysis-only cleanup is awaited before its process group is closed. */
  async deleteSession(chatId: string, sessionToken: string, launch?: Pick<StartOpencodeTurnArgs, 'cwd' | 'runtime' | 'model' | 'agent'>): Promise<void> {
    await this.interruptions.get(chatId)
    let chat = this.chats.get(chatId)
    if ((!chat || chat.closed) && launch?.runtime) {
      chat = await this.ensureServer({ ...launch, chatId, content: '' }, launch.runtime)
    }
    if (!chat || chat.closed) throw new Error('OpenCode analysis session cleanup unavailable')
    if (chat && !chat.closed) {
      const result = await chat.client.session.delete({ sessionID: sessionToken }, { signal: AbortSignal.timeout(3000) })
      if (result.error) throw new Error('Unable to delete OpenCode analysis session')
    }
  }

  private async ensureServer(args: StartOpencodeTurnArgs, runtime: EngineRuntime): Promise<ChatServer> {
    const key = createHash('sha256').update(JSON.stringify([args.cwd, runtime.executable.path, runtime.env, runtime.opencodeConfig, args.agent, (args.memorySpecs ?? []).map(s => [s.name, s.description, s.schema])])).digest('hex')
    const previous = this.chats.get(args.chatId)
    if (previous?.key === key && !previous.closed) return previous
    if (previous) { this.chats.delete(args.chatId); await this.stop(previous) }
    const generation = this.generations.get(args.chatId) ?? 0
    const mcp = !args.agent && args.memorySpecs?.length ? createOpencodeMemoryMcp(args.memorySpecs, args.memoryDispatch) : undefined
    let server: OpencodeServer | undefined
    try {
      const { createOpencodeClient } = await loadSdk()
      server = await startOpencodeServer({ executable: runtime.executable.path!, cwd: args.cwd, env: runtime.env, signal: args.signal,
        config: { ...runtime.opencodeConfig, permission: { '*': 'allow' },
          agent: { 'memosync-branch': OPENCODE_BRANCH_AGENT }, ...(mcp ? { mcp: { memosync: mcp.config } } : {}),
        },
      })
      const controller = new AbortController()
      const client = createOpencodeClient({ baseUrl: server.url, directory: args.cwd, headers: { Authorization: server.authorization } })
      const chat: ChatServer = { key, runtime, server, client, mcp, controller, retiredMessages: new Set(), closed: false }
      if (this.disposed || generation !== (this.generations.get(args.chatId) ?? 0)) throw new Error('OpenCode start cancelled')
      this.chats.set(args.chatId, chat)
      server.child.once('exit', () => {
        if (!chat.closed) { chat.turn?.fail('OpenCode server exited during the turn'); this.closeChat(args.chatId) }
      })
      // SDK streams are lazy: wait for the server.connected event before prompting.
      let readyResolve!: () => void, readyReject!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
      const fail = () => {
        if (chat.closed) return
        readyReject(new Error('OpenCode event stream disconnected'))
        chat.turn?.fail('OpenCode event stream disconnected')
        this.closeChat(args.chatId)
      }
      const events = await client.event.subscribe({ directory: args.cwd }, { signal: controller.signal, sseMaxRetryAttempts: 0, onSseError: fail })
      void (async () => {
        try { for await (const event of events.stream) { if (event.type === 'server.connected') readyResolve(); chat.turn?.handle(event) } }
        catch { /* transport details cannot escape */ }
        finally { fail() }
      })()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OpenCode event stream unavailable')), 5000) })]) }
      finally { clearTimeout(timer) }
      return chat
    } catch (error) {
      mcp?.close(); await server?.close()
      this.chats.delete(args.chatId)
      throw error
    }
  }

  async startTurn(args: StartOpencodeTurnArgs): Promise<HarnessTurn> {
    args = { ...args, cwd: await realpath(args.cwd) }
    args.signal?.throwIfAborted()
    if (this.disposed) throw new Error('OpenCode manager disposed')
    const runtime = args.runtime ?? await resolveEngineRuntime({ engine: 'opencode', model: args.model })
    if (runtime.engine !== 'opencode') throw new Error('engine-runtime-mismatch')
    await this.interruptions.get(args.chatId)
    if (this.pending.has(args.chatId)) throw new Error('OpenCode chat is starting')
    const pending = this.ensureServer(args, runtime)
    this.pending.set(args.chatId, pending)
    let chat: ChatServer
    try { chat = await pending } finally { this.pending.delete(args.chatId) }
    args.signal?.throwIfAborted()
    if (this.disposed || chat.closed) throw new Error('OpenCode start cancelled')
    if (chat.turn || chat.initializing) throw new Error('OpenCode chat is already running')
    chat.mcp?.setDispatch(args.memoryDispatch)
    const systemPrompt = args.systemPrompt ?? OPENCODE_SYSTEM_PROMPT
    args.onLaunch?.({ provider: 'opencode', options: { model: runtime.model, runtime, systemPrompt, memorySpecs: args.memorySpecs } })
    let initialized!: () => void
    const initialization = { controller: new AbortController(), done: new Promise<void>(resolve => { initialized = resolve }) }
    chat.initializing = initialization
    const signal = AbortSignal.any([initialization.controller.signal, AbortSignal.timeout(10_000), ...(args.signal ? [args.signal] : [])])
    const options = { signal }
    let sessionID = args.sessionToken || '', unclaimedAnalysisSession = ''
    try {
      if (args.forkSession && sessionID) {
        const response = await chat.client.session.fork({ sessionID }, options)
        sessionID = response.data?.id || ''
        if (args.agent && sessionID !== args.sessionToken) unclaimedAnalysisSession = sessionID
      } else if (!sessionID) {
        const response = await chat.client.session.create({ title: args.agent ? 'MemoSync memory analysis' : 'MemoSync' }, options)
        sessionID = response.data?.id || ''
        if (args.agent) unclaimedAnalysisSession = sessionID
      }
      if (!sessionID) throw new Error('OpenCode did not return a session identifier')
      // Fork copies can emit old message events after the fork HTTP response.
      // Snapshot their IDs before prompting, so inherited text cannot become this
      // turn's answer when a denied read ends the prompt without new text.
      const history = await chat.client.session.messages({ sessionID }, options)
      if (history.error) throw new Error('Unable to read OpenCode session history')
      for (const message of history.data ?? []) chat.retiredMessages.add(message.info.id)
      signal.throwIfAborted()
      if (this.disposed || chat.closed) throw new Error('OpenCode start cancelled')
    } catch (error) {
      if (unclaimedAnalysisSession) {
        try {
          await chat.client.session.delete({ sessionID: unclaimedAnalysisSession }, { signal: AbortSignal.timeout(3000), throwOnError: true })
        } catch { throw new Error('Unable to delete uninitialized OpenCode analysis session', { cause: error }) }
      }
      throw error
    } finally {
      if (chat.initializing === initialization) chat.initializing = undefined
      initialized()
    }
    const queue = new Queue<HarnessEvent>()
    const started = Date.now()
    let finished = false, cancelled = false, output = false, lastError = '', cost = 0
    const messages = new Map<string, string>()
    const parts = new Map<string, Part>()
    const pendingDeltas = new Map<string, string[]>()
    const calls = new Set<string>(), results = new Set<string>(), completedParts = new Set<string>(), usages = new Set<string>()
    const questions = new Set<string>()
    let questionQueue = Promise.resolve()
    const transcript = (value: Parameters<typeof entry>[0]) => queue.push({ type: 'transcript', entry: entry(value) })
    const finalize = (message = '', isError = false, cancel = false) => {
      if (finished) return
      finished = true
      args.signal?.removeEventListener('abort', onAbort)
      for (const id of messages.keys()) chat.retiredMessages.add(id)
      if (chat.retiredMessages.size > 4096) chat.retiredMessages = new Set([...chat.retiredMessages].slice(-2048))
      if (chat.turn?.sessionID === sessionID) chat.turn = undefined
      transcript({ kind: 'result', subtype: cancel ? 'cancelled' : isError ? 'error' : 'success', isError, durationMs: Date.now() - started, result: message, ...(cost > 0 ? { costUsd: cost } : {}) })
      queue.finish()
    }
    let interrupting: Promise<void> | undefined
    const abort = (failure?: string): Promise<void> => {
      if (interrupting) return interrupting
      if (finished) return Promise.resolve()
      cancelled = true
      // Finish locally first; retire the transport before any resumed prompt.
      finalize(failure || '', Boolean(failure), !failure)
      interrupting = (async () => {
        try { await chat.client.session.abort({ sessionID }, { signal: AbortSignal.timeout(3000), throwOnError: true }) }
        catch { /* Process teardown is the fallback for a failed abort. */ }
        this.closeChat(args.chatId)
        await chat.server.close()
      })()
      this.interruptions.set(args.chatId, interrupting)
      void interrupting.finally(() => { if (this.interruptions.get(args.chatId) === interrupting) this.interruptions.delete(args.chatId) }).catch(() => {})
      return interrupting
    }
    const onAbort = () => { void abort() }
    const emitDelta = (partID: string, delta: string) => { output = true; queue.push({ type: 'assistant_delta', itemId: partID, delta }) }
    const flushDelta = (part: Part) => {
      if (part.type === 'text' && messages.get(part.messageID) === 'assistant') {
        for (const delta of pendingDeltas.get(part.id) ?? []) emitDelta(part.id, delta)
        pendingDeltas.delete(part.id)
      }
    }
    const call = (part: Extract<Part, { type: 'tool' }>) => {
      if (calls.has(part.callID)) return
      calls.add(part.callID); output = true
      const translated = translateOpencodeTool(part.tool, record(part.state.input))
      transcript({ kind: 'tool_call', tool: normalizeToolCall({ ...translated, toolId: part.callID }) })
    }
    const emitTool = (part: Part) => {
      if (part.type !== 'tool' || part.state.status === 'pending') return
      // A question becomes interactive when its queued question.asked handler
      // runs. Publishing another running question would disable that active UI.
      if (part.tool === 'question' && part.state.status === 'running') return
      call(part)
      if ((part.state.status === 'completed' || part.state.status === 'error') && !results.has(part.callID)) {
        results.add(part.callID)
        transcript({ kind: 'tool_result', toolId: part.callID, content: part.state.status === 'completed' ? part.state.output : part.state.error, isError: part.state.status === 'error' })
      }
    }
    const completeText = (part: Part) => {
      if (completedParts.has(part.id) || messages.get(part.messageID) !== 'assistant') return
      // Reasoning stays out of the transcript, as it does for Codex and Pi.
      if (part.type !== 'text' || !part.text) return
      completedParts.add(part.id); output = true
      transcript({ kind: 'assistant_text', text: part.text })
    }
    const handle = (event: Event) => {
      if (finished) return
      const p = record(event.properties)
      const sid = p.sessionID ?? record(p.info).sessionID ?? record(p.part).sessionID
      if (sid !== sessionID) return
      const eventMessageID = p.messageID ?? record(p.info).id ?? record(p.part).messageID ?? record(p.tool).messageID
      const messageID = typeof eventMessageID === 'string' ? eventMessageID : undefined
      if (messageID && chat.retiredMessages.has(messageID)) return
      switch (event.type) {
        case 'message.updated': {
          const info = event.properties.info
          messages.set(info.id, info.role)
          for (const part of parts.values()) if (part.messageID === info.id) { flushDelta(part); if (info.role === 'assistant') emitTool(part) }
          if (info.role === 'assistant' && info.time.completed) {
            if (info.error) lastError = errorMessage(info.error)
            if (!usages.has(info.id)) {
              usages.add(info.id); cost += info.cost || 0
              const tokens = info.tokens, inputTokens = tokens.input + tokens.cache.read + tokens.cache.write
              const outputTokens = tokens.output + tokens.reasoning
              const usedTokens = inputTokens + outputTokens
              if (usedTokens > 0) transcript({ kind: 'context_window_updated', usage: { usedTokens, inputTokens, outputTokens, cachedInputTokens: tokens.cache.read, reasoningOutputTokens: tokens.reasoning, lastUsedTokens: usedTokens, lastInputTokens: inputTokens, lastOutputTokens: outputTokens, compactsAutomatically: true } })
            }
            for (const part of parts.values()) if (part.messageID === info.id) completeText(part)
          }
          break
        }
        case 'message.part.delta': {
          const { partID, field, delta } = event.properties
          if (field !== 'text') break
          const part = parts.get(partID)
          if (part && messages.get(part.messageID) === 'assistant' && part.type === 'text') emitDelta(partID, delta)
          else if (!part || !messages.has(part.messageID)) pendingDeltas.set(partID, [...pendingDeltas.get(partID) ?? [], delta])
          break
        }
        case 'message.part.updated': {
          const part = event.properties.part
          parts.set(part.id, part); flushDelta(part)
          if (messages.get(part.messageID) !== 'assistant') break
          emitTool(part)
          if (part.type === 'text' && part.time?.end) completeText(part)
          break
        }
        case 'session.error': lastError = errorMessage(event.properties.error); void abort(lastError); break
        case 'session.idle':
          for (const part of parts.values()) completeText(part)
          finalize(lastError || (!output ? 'OpenCode ended without assistant output' : ''), Boolean(lastError) || !output)
          break
        case 'session.status': {
          const status = event.properties.status
          if (status.type === 'retry' && status.attempt >= 4) {
            void abort(`OpenCode retry limit reached (${status.attempt}): ${status.message}`)
          }
          break
        }
        case 'permission.asked': {
          void (async () => {
            const part = [...parts.values()].find(part => part.type === 'tool' && part.callID === event.properties.tool?.callID)
            const tool = part?.type === 'tool' ? { name: part.tool, input: record(part.state.input) } : undefined
            const allowed = args.agent && args.onPermissionRequest ? await args.onPermissionRequest(event.properties, tool) : false
            if (finished) return
            if (!allowed && !args.agent) {
              const toolId = event.properties.tool?.callID ?? event.properties.id
              if (!results.has(toolId)) {
                results.add(toolId)
                transcript({ kind: 'tool_result', toolId, isError: true, content: `OpenCode permission rejected: ${event.properties.permission}` })
              }
            }
            await chat.client.permission.reply({ requestID: event.properties.id, reply: allowed ? 'once' : 'reject' }, { throwOnError: true, signal: AbortSignal.timeout(3000) })
          })().catch(() => { void abort('OpenCode permission reply failed') })
          break
        }
        case 'question.asked': {
          const request = event.properties, toolId = request.tool?.callID ?? request.id
          if (questions.has(request.id)) break
          questions.add(request.id)
          const translated = translateOpencodeTool('question', { questions: request.questions })
          const tool = normalizeToolCall({ ...translated, toolId }) as HarnessToolRequest['tool']
          // The host has one pending user question. Serialize through the HTTP
          // reply/reject, without blocking SSE cancellation or error events.
          questionQueue = questionQueue.then(async () => {
            if (finished) return
            if (!calls.has(toolId)) { calls.add(toolId); output = true; transcript({ kind: 'tool_call', tool }) }
            try {
              const response = args.onToolRequest ? record(await args.onToolRequest({ tool })) : {}
              if (finished) return
              const raw = response.answers ?? response
              const answers = request.questions.map((q, index) => {
                const answer = Array.isArray(raw) ? raw[index] : record(raw)[q.question] ?? record(raw)[q.header] ?? record(raw)[String(index)]
                const value = record(answer).answers ?? answer
                return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
              })
              if (response.error || response.cancelled || !answers.some(a => a.length)) await chat.client.question.reject({ requestID: request.id }, { throwOnError: true, signal: AbortSignal.timeout(3000) })
              else await chat.client.question.reply({ requestID: request.id, answers }, { throwOnError: true, signal: AbortSignal.timeout(3000) })
            } catch {
              if (!finished) {
                try { await chat.client.question.reject({ requestID: request.id }, { throwOnError: true, signal: AbortSignal.timeout(3000) }) }
                catch { void abort('OpenCode question reply failed') }
              }
            }
          })
          break
        }
      }
    }
    chat.turn = { sessionID, handle, fail: message => finalize(message, true), cancel: () => finalize('', false, true) }
    queue.push({ type: 'session_token', sessionToken: sessionID })
    transcript({ kind: 'system_init', provider: 'opencode', model: runtime.model, tools: ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob', ...(args.memorySpecs ?? []).map(s => `mcp__memory__${s.name}`)], agents: [], slashCommands: [], mcpServers: chat.mcp ? [{ name: 'memory', status: 'connected' }] : [] })
    args.signal?.addEventListener('abort', onAbort, { once: true })
    if (args.signal?.aborted) void abort()
    const model = runtime.connectionId ? { providerID: 'memosync', modelID: runtime.model } : (() => {
      const slash = runtime.model.indexOf('/')
      return slash > 0 ? { providerID: runtime.model.slice(0, slash), modelID: runtime.model.slice(slash + 1) } : undefined
    })()
    const promptParts: Array<{ type: 'text'; text: string }> = []
    if (args.memoryContext) promptParts.push({ type: 'text', text: args.memoryContext })
    promptParts.push({ type: 'text', text: args.content })
    if (!cancelled) void chat.client.session.promptAsync({ sessionID, model, system: systemPrompt, agent: args.agent, parts: promptParts }, { signal: AbortSignal.timeout(10_000) })
      .then(response => { if (response.error) void abort('OpenCode prompt request failed') })
      .catch(() => { void abort('OpenCode prompt request failed') })
    return { provider: 'opencode', stream: queue, interrupt: abort, close: () => { if (!finished) void abort() } }
  }
}
