import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpencodeAgentManager } from './opencode-agent'
import { AgentCoordinator, ClaudeOutboundOriginTracker, createClaudeHarnessStream } from './agent'
import { CodexAppServerManager } from './codex-app-server'
import { rememberRuntime, type EngineRuntime } from './model-access/runtime'
import { discovery, type NativeCommandRuntime } from './command-registry'
import { createWsRouter } from './ws-router'
import { createEmptyState } from './events'

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const source = { api: 'local-protocol-fixture', version: 'fixture-1', evidence: 'native-response' as const }

test('Claude input replay preserves UUID authority without reviving a cancelled human reservation', async () => {
  for (const revoked of [false, true]) {
    const tracker = new ClaudeOutboundOriginTracker(true)
    tracker.beginHumanTurn(1, 'human-id')
    if (revoked) tracker.revokeHumanTurn(1)
    const query = { async *[Symbol.asyncIterator]() {
      yield { type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'human-id', isReplay: true, parent_tool_use_id: null }
      yield { type: 'assistant', uuid: 'reply', message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'fixture' }] }, parent_tool_use_id: null }
    } }
    const events = []
    for await (const event of createClaudeHarnessStream(query as never, undefined, undefined, tracker)) events.push(event)
    expect(events.find(event => event.entry?.kind === 'assistant_text')?.origin).toBe(revoked ? 'unknown' : 'human')
  }
})

describe('runtime command lifecycle wiring', () => {
  test('slash compact and WS catalog/control routes bypass ordinary turn, transcript and capture pipelines', async () => {
    let nativeDone = deferred()
    let compacts = 0, restores = 0, ordinary = 0
    const native: NativeCommandRuntime = { instance: 'native-fixture', session: 'native-session', version: 'fixture-1', alive: () => true,
      discover: async () => ({ commands: discovery('ready', [], source), skills: discovery('ready', [], source), connectors: discovery('ready', [], source) }),
      compact: async () => { compacts++; await nativeDone.promise },
      restore: async text => { restores++; expect(text).toContain('memoryViewRevision'); return { delivery: 'native-accepted' } },
      cancel: async () => { nativeDone.resolve() } }
    const chat = { id: 'chat', provider: 'pi', projectId: 'project', planMode: false, sessionToken: 'native-session' }
    const store = { state: createEmptyState(), requireChat: () => chat, getChat: () => chat, getProject: () => ({ id: 'project', localPath: '/temp/fixture-project' }),
      getQueuedMessages: () => [], appendMessage: async () => { ordinary++ }, recordTurnStarted: async () => { ordinary++ } }
    const agent = new AgentCoordinator({ store: store as never, onStateChange() {},
      piManager: { getCommandRuntime: () => native, dispose() {}, startTurn: async () => { ordinary++; throw new Error('Must not start ordinary turn') } } as never,
      capture: { capture: async () => { ordinary++ } } as never })
    const router = createWsRouter({ store: store as never, agent, terminals: { onEvent: () => () => {} } as never,
      keybindings: { onChange: () => () => {} } as never, refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: 'Fixture', updateManager: null })
    const sent: any[] = []
    const socket = { data: { subscriptions: new Map(), protectedDraftChatIds: new Set() }, send(text: string) { sent.push(JSON.parse(text)); return text.length } }
    try {
      router.handleOpen(socket as never)
      await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'command', id: 'read', command: { type: 'chat.readCommandCatalog', chatId: 'chat', refresh: true } }))
      expect(sent.at(-1)).toMatchObject({ type: 'ack', id: 'read', result: { runtime: { nativeInstance: 'native-fixture' }, compact: { status: 'available' } } })
      await agent.send({ type: 'chat.send', chatId: 'chat', content: '/compact' })
      expect(compacts).toBe(1)
      expect(agent.getCommandCatalog('chat').operation).toMatchObject({ status: 'running', contextRestored: false })
      await expect(agent.send({ type: 'chat.send', chatId: 'chat', content: 'normal turn' })).rejects.toThrow('control is running')
      nativeDone.resolve()
      await flush()
      expect(agent.getCommandCatalog('chat').operation).toMatchObject({ status: 'completed', contextRestored: true })
      expect(restores).toBe(1)
      expect(ordinary).toBe(0)
      await expect(agent.enqueue({ type: 'message.enqueue', chatId: 'chat', content: '/compact' })).rejects.toThrow('command catalog')
      const catalog = agent.getCommandCatalog('chat')
      nativeDone = deferred()
      await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'command', id: 'execute', command: { type: 'chat.executeCommand', chatId: 'chat', runtimeKey: catalog.runtimeKey, expectedRevision: catalog.revision, commandId: 'native:compact' } }))
      expect(sent.at(-1)).toMatchObject({ type: 'ack', id: 'execute', result: { chatId: 'chat' } })
      const operationId = sent.at(-1).result.operationId
      await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'command', id: 'cancel', command: { type: 'chat.cancelCommand', chatId: 'chat', operationId } }))
      expect(sent.at(-1)).toMatchObject({ type: 'ack', id: 'cancel' })
      await flush()
      expect(agent.getCommandCatalog('chat').operation).toMatchObject({ status: 'cancelled', contextRestored: false })
      await expect(agent.send({ type: 'chat.send', chatId: 'chat', content: '/unknown' })).rejects.toThrow('unavailable')
      expect(ordinary).toBe(0)
    } finally { router.dispose(); await agent.shutdownRuntime() }
  })
})

test('OpenCode command discovery and execution use the live server and existing SSE turn lifecycle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memosync-command-fixture-'))
  const journal = join(directory, 'commands.jsonl')
  const runtime: EngineRuntime = { engine: 'opencode', executable: { state: 'ready', version: '1.19.5', path: join(import.meta.dir, 'fixtures/opencode-server-fixture.ts') },
    env: { HOME: directory, PATH: process.env.PATH, FAKE_OC_COMMAND_LOG: journal }, args: [], model: 'connected/fixture', isolated: true }
  const manager = new OpencodeAgentManager()
  try {
    const turn = await manager.startTurn({ chatId: 'fixture', cwd: directory, content: '/fixture expected-arguments', model: runtime.model, runtime })
    const entries = []
    for await (const event of turn.stream) if (event.entry) entries.push(event.entry)
    expect(entries.find(e => e.kind === 'assistant_text')).toMatchObject({ text: 'native-command:fixture:expected-arguments' })
    expect(entries.at(-1)).toMatchObject({ kind: 'result', isError: false })
    const native = manager.getCommandRuntime('fixture')!
    const found = await native.discover()
    expect(found.commands.items).toMatchObject([{ name: 'fixture', route: 'session-command' }])
    expect(found.skills.items).toMatchObject([{ name: 'fixture', discovered: true, loaded: null }])
    expect(found.connectors.items).toMatchObject([{ kind: 'mcp', state: 'disabled' }])
    await native.compact!(new AbortController().signal)
    await native.restore!('versioned-current-view', new AbortController().signal)
    const requests = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.find(r => r.path.endsWith('/command')).body).toMatchObject({ command: 'fixture', arguments: 'expected-arguments' })
    expect(requests.find(r => r.path.endsWith('/summarize')).body).toMatchObject({ providerID: 'connected', modelID: 'fixture', auto: false })
    expect(requests.find(r => r.path.endsWith('/message')).body).toMatchObject({ noReply: true, parts: [{ type: 'text', text: expect.stringContaining('versioned-current-view') }] })
    expect(requests.some(r => r.path.endsWith('/prompt_async'))).toBe(false)
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

class LocalCodexProtocol extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: any[] = []
  compactRequest?: string
  constructor() {
    super()
    let buffer = ''
    this.stdin.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        const request = JSON.parse(line); this.requests.push(request)
        if (request.method === 'initialize') this.write({ id: request.id, result: {} })
        if (request.method === 'thread/start') this.write({ id: request.id, result: { thread: { id: 'fixture-thread' } } })
        if (request.method === 'skills/list' || request.method === 'mcpServerStatus/list') this.write({ id: request.id, result: { data: [] } })
        if (request.method === 'thread/compact/start') {
          this.compactRequest = request.id
          this.write({ method: 'turn/started', params: { threadId: 'fixture-thread', turn: { id: 'compact-turn', status: 'inProgress', error: null } } })
        }
      }
    })
  }
  write(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`) }
  kill() { this.emit('close', 0); return true }
}

test.each(['legacy', 'item'] as const)('Codex compact waits for matching boundary, terminal turn and ACK (%s)', async kind => {
  const child = new LocalCodexProtocol()
  const runtime = rememberRuntime({ engine: 'codex', executable: { state: 'ready', version: '0.166.0-alpha.5.1' }, env: { CODEX_HOME: '/temp/fixture-codex-profile' }, args: [], model: 'fixture', isolated: true } satisfies EngineRuntime)
  const manager = new CodexAppServerManager({ spawnProcess: () => child as never })
  try {
    await manager.startSession({ chatId: 'fixture', cwd: '/temp/fixture-project', model: 'fixture', runtime, sessionToken: null })
    const native = manager.getCommandRuntime('fixture')!
    expect(native.restore).toBeUndefined()
    const appended: string[] = []
    manager.setCommandContextRestorer(async (_chat, text) => { appended.push(text) })
    expect((await native.discover()).commands.items).toEqual([])
    let completed = false
    const compact = native.compact!(new AbortController().signal).then(() => { completed = true })
    await flush()
    expect(child.requests.at(-1)).toMatchObject({ method: 'thread/compact/start', params: { threadId: 'fixture-thread' } })
    child.write({ method: 'thread/compacted', params: { threadId: 'other-thread', turnId: 'compact-turn' } })
    child.write({ method: 'thread/compacted', params: { threadId: 'fixture-thread', turnId: 'previous-turn' } })
    await flush()
    expect(completed).toBe(false)
    child.write(kind === 'legacy'
      ? { method: 'thread/compacted', params: { threadId: 'fixture-thread', turnId: 'compact-turn' } }
      : { method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } } })
    await flush()
    expect(completed).toBe(false)
    child.write({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'compact-turn', status: 'completed', error: null } } })
    await flush()
    expect(completed).toBe(false)
    child.write({ id: child.compactRequest, result: {} })
    await compact
    expect(await native.restore!('current-view', new AbortController().signal)).toEqual({ delivery: 'native-accepted' })
    expect(appended).toEqual(['current-view'])
    expect(child.requests.some(r => r.method === 'turn/start')).toBe(false)
  } finally { await manager.stopAll() }
})
