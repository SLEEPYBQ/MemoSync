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
import { EventStore } from './event-store'
import type { AgentProvider } from '../shared/types'
import { isRuntimeCommandSelection, runtimeCommandSelectionKey, type RuntimeCommandSelection } from '../shared/runtime-commands'
import { getModelAccessService } from './model-access/service'
import { toCodexDynamicTools } from './memory/codex-adapter'
import { CODEX_INIT_PROMPT, discoverCodexCommands } from './native-command-drivers'

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
    const preparedToken = await manager.prepareSession({ chatId: 'fixture', cwd: directory, model: runtime.model, runtime })
    expect(preparedToken).toBe('ses_fixture')
    const preparedNative = manager.getCommandRuntime('fixture')!
    expect((await preparedNative.discover()).commands.items.map(c => c.name)).toEqual(['fixture'])
    const preparedRequests = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(preparedRequests.map(r => r.path)).toEqual(['/session'])
    const turn = await manager.startTurn({ chatId: 'fixture', cwd: directory, content: '/fixture expected-arguments', model: runtime.model, runtime })
    expect(manager.getCommandRuntime('fixture')!.instance).toBe(preparedNative.instance)
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
    expect(requests.filter(r => r.path === '/session')).toHaveLength(1)
    expect(requests.find(r => r.path.endsWith('/command')).body).toMatchObject({ command: 'fixture', arguments: 'expected-arguments' })
    expect(requests.find(r => r.path.endsWith('/summarize')).body).toMatchObject({ providerID: 'connected', modelID: 'fixture', auto: false })
    expect(requests.find(r => r.path.endsWith('/message')).body).toMatchObject({ noReply: true, parts: [{ type: 'text', text: expect.stringContaining('versioned-current-view') }] })
    expect(requests.some(r => r.path.endsWith('/prompt_async'))).toBe(false)
  } finally { await manager.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

async function preparationFixture(provider: AgentProvider, gate?: Promise<void>, draft = false) {
  const directory = mkdtempSync(join(tmpdir(), 'memosync-preparation-'))
  const store = new EventStore(join(directory, 'data'))
  await store.initialize()
  const ensured = draft ? await store.ensureDraft({ localPath: directory }) : undefined
  const project = ensured ? store.getProject(ensured.projectId)! : await store.openProject(directory)
  const chat = ensured ? store.requireChat(ensured.chatId) : await store.createChat(project.id)
  const calls = { preparations: [] as any[], starts: [] as any[], prompts: [] as string[], closed: 0, stateChanges: [] as (string | undefined)[] }
  const stopped = deferred(), entered = deferred()
  let native: NativeCommandRuntime | undefined
  let generation = 0
  const install = (args: any) => {
    if (!native) {
      const model = args.model
      const instance = `fixture-${++generation}`
      native = { instance, session: `session-${generation}`, version: provider === 'pi' ? '1.5.0' : 'fixture', alive: () => native?.instance === instance,
        discover: async () => ({ commands: discovery('ready', [{ id: 'native:fixture', name: 'fixture', description: model, namespace: 'native', owner: 'native-engine',
          arguments: { type: 'string' }, requiresIdle: true, sideEffect: 'model-turn', route: 'native-prompt', source, requiredRuntimeVersion: provider === 'pi' ? '1.5.0' : 'fixture' }], source),
          skills: discovery('ready', [], source), connectors: discovery('ready', [], source) }) }
    }
    return native.session
  }
  const close = () => { if (native) calls.closed++; native = undefined }
  const prepare = async (args: any) => { calls.preparations.push(args); entered.resolve(); await gate; args.signal?.throwIfAborted(); return install(args) }
  const turn = { provider, stream: { async *[Symbol.asyncIterator]() { await stopped.promise } }, interrupt: async () => { stopped.resolve() }, close: () => { stopped.resolve() } }
  const agent = new AgentCoordinator({ store, onStateChange(chatId) { calls.stateChanges.push(chatId) }, getMemorySettings: () => ({ enabled: false, learn: false }),
    claudeSessionFileExists: () => true,
    resolvePiConnection: async () => ({ provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic' }),
    startClaudeSession: async args => {
      calls.preparations.push(args); entered.resolve(); install(args)
      return { ...turn, provider: 'claude', commandRuntime: native,
        initialize: async () => { if (gate) await Promise.race([gate, stopped.promise.then(() => { throw new Error('Closed') })]) },
        sendPrompt: async text => { calls.prompts.push(text) }, setModel: async () => {}, setPermissionMode: async () => {},
        close: () => { close(); stopped.resolve() },
      }
    },
    piManager: { prepareSession: prepare, getCommandRuntime: () => provider === 'pi' ? native : undefined,
      startTurn: async (args: any) => { calls.starts.push(args); calls.prompts.push(args.content); install(args); return turn },
      closeChat: () => { if (provider === 'pi') close() }, dispose: () => { if (provider === 'pi') close(); stopped.resolve() } } as never,
    codexManager: { startSession: async (args: any) => { if (!native) return prepare(args); calls.starts.push(args); return native.session },
      getCommandRuntime: () => provider === 'codex' ? native : undefined, hasSession: () => provider === 'codex' && Boolean(native),
      startTurn: async (args: any) => { calls.prompts.push(args.content); return turn },
      stopSession: async () => { if (provider === 'codex') close() }, stopAll: async () => { if (provider === 'codex') close(); stopped.resolve() } } as never,
    opencodeManager: { prepareSession: prepare, getCommandRuntime: () => provider === 'opencode' ? native : undefined,
      hasSession: () => provider === 'opencode' && Boolean(native),
      startTurn: async (args: any) => { calls.starts.push(args); calls.prompts.push(args.content); install(args); return turn },
      closeChat: () => { if (provider === 'opencode') close() }, dispose: async () => { if (provider === 'opencode') close(); stopped.resolve() } } as never,
  })
  const selection: RuntimeCommandSelection = { provider, model: 'fixture-model', modelOptions: { connectionId: 'fixture-connection' }, planMode: false }
  const bindRuntime = (selected = selection) => {
    const settings = (agent as any).getProviderSettings(selected.provider, selected)
    const runtime: EngineRuntime = { engine: selected.provider, executable: { state: 'ready', version: 'fixture' }, env: { HOME: directory }, args: [], model: settings.model, connectionId: settings.connectionId, isolated: true }
    ;(agent as any).sessionRuntimes.set(chat.id, runtime)
    ;(agent as any).runtimeSelections.set(chat.id, JSON.stringify([selected.provider, settings.model, settings.connectionId, getModelAccessService()?.revision]))
  }
  bindRuntime()
  return { agent, store, chat, project, calls, selection, bindRuntime, entered: entered.promise,
    async settled() { await (agent as any).commandPreparations.get(chat.id)?.promise; return agent.readCommandCatalog(chat.id) },
    async cleanup() { stopped.resolve(); await agent.shutdownRuntime(); rmSync(directory, { recursive: true, force: true }) },
  }
}

test.each(['claude', 'codex', 'pi', 'opencode'] as const)('%s prepares a selected native catalog before the first message and reuses its session', async provider => {
  const f = await preparationFixture(provider)
  try {
    const pending = await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    expect(pending).toMatchObject({ preparation: { status: 'preparing' }, selectionKey: runtimeCommandSelectionKey(f.selection), runtime: null })
    const catalog = await f.settled()
    expect(catalog).toMatchObject({ preparation: { status: 'ready' }, runtime: { engine: provider }, commands: { status: 'ready' } })
    expect(catalog.commands.items.map(c => c.name)).toEqual(['fixture'])
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.calls.prompts).toEqual([])
    expect(f.store.getMessages(f.chat.id)).toEqual([])
    expect(f.store.requireChat(f.chat.id).provider).toBeNull()
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: 'first real message', ...f.selection })
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.agent.getCommandCatalog(f.chat.id).runtime?.nativeInstance).toBe(catalog.runtime?.nativeInstance)
    expect(f.calls.prompts).toEqual(['first real message'])
  } finally { await f.cleanup() }
})

test.each(['claude', 'codex', 'pi', 'opencode'] as const)('%s draft promotion reuses the prepared native session and reveals its unopened project', async provider => {
  const f = await preparationFixture(provider, undefined, true)
  try {
    expect(f.store.listProjects()).toEqual([])
    expect(f.store.listChats()).toEqual([])
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    const prepared = await f.settled()
    expect(prepared.commands.items.map(command => command.name)).toEqual(['fixture'])
    expect(f.agent.getHarnessSnapshot(f.chat.id)?.capabilities.engine).toBe(provider)
    expect(f.store.requireChat(f.chat.id).provider).toBeNull()
    f.calls.stateChanges.length = 0
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: 'first draft message', ...f.selection })
    expect(f.calls.stateChanges).toContain(undefined)
    expect(f.store.requireChat(f.chat.id)).toMatchObject({ provider, hasMessages: true })
    expect(f.store.requireChat(f.chat.id).draft).toBeUndefined()
    expect(f.store.listChats().map(chat => chat.id)).toEqual([f.chat.id])
    expect(f.store.listProjects().map(project => project.id)).toEqual([f.project.id])
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.calls.closed).toBe(0)
    expect(f.agent.getCommandCatalog(f.chat.id).runtime?.nativeInstance).toBe(prepared.runtime?.nativeInstance)
    expect(f.calls.prompts).toEqual(['first draft message'])
    await f.agent.discardDraft(f.chat.id)
    expect(f.calls.closed).toBe(0)
    expect(f.agent.getCommandCatalog(f.chat.id).runtime?.nativeInstance).toBe(prepared.runtime?.nativeInstance)
    const reloaded = new EventStore(f.store.dataDir)
    await reloaded.initialize()
    expect(reloaded.listChats().map(chat => chat.id)).toEqual([f.chat.id])
  } finally { await f.cleanup() }
})

test.each(['claude', 'codex', 'pi', 'opencode'] as const)('%s discard closes the prepared draft session and is idempotent', async provider => {
  const f = await preparationFixture(provider, undefined, true)
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.settled()
    await f.agent.discardDraft(f.chat.id)
    expect(f.calls.closed).toBe(1)
    expect(f.store.getChat(f.chat.id)).toBeNull()
    expect(f.store.getProject(f.project.id)).toBeNull()
    expect(f.agent.getHarnessSnapshot(f.chat.id)).toBeUndefined()
    expect((f.agent as any).commandPreparations.has(f.chat.id)).toBe(false)
    await f.agent.discardDraft(f.chat.id)
    expect(f.calls.closed).toBe(1)
  } finally { await f.cleanup() }
})

test.each(['claude', 'codex', 'pi', 'opencode'] as const)('%s discard aborts in-flight draft preparation before acknowledging', async provider => {
  const gate = deferred(), cancelled = deferred(), f = await preparationFixture(provider, gate.promise, true)
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.entered
    const signal = (f.agent as any).commandPreparations.get(f.chat.id).controller.signal as AbortSignal
    signal.addEventListener('abort', cancelled.resolve, { once: true })
    const discarding = f.agent.discardDraft(f.chat.id)
    await cancelled.promise
    expect(signal.aborted).toBe(true)
    gate.resolve()
    await discarding
    expect(f.calls.prompts).toEqual([])
    expect(f.store.getChat(f.chat.id)).toBeNull()
    const manager = provider === 'claude' ? undefined : (f.agent as any)[`${provider}Manager`]
    if (manager) expect(manager.getCommandRuntime(f.chat.id)).toBeUndefined()
    else expect((f.agent as any).claudeSessions.has(f.chat.id)).toBe(false)
    expect((f.agent as any).commandPreparations.has(f.chat.id)).toBe(false)
  } finally { gate.resolve(); await f.cleanup() }
})

test('a draft retains Mode and send selection across promotion and replay', async () => {
  const f = await preparationFixture('pi', undefined, true)
  try {
    const policy = { engine: 'pi', toolGate: 'read-only' } as const
    await f.agent.setExecutionPolicy({ type: 'chat.setExecutionPolicy', chatId: f.chat.id, expectedRevision: 1, policy })
    await f.store.setMemoryDisabled(f.chat.id, true)
    const selection: RuntimeCommandSelection = { ...f.selection, planMode: true,
      modelOptions: { ...f.selection.modelOptions, pi: { reasoningEffort: 'high' } } }
    await f.agent.readCommandCatalog(f.chat.id, false, selection)
    const prepared = await f.settled()
    expect(prepared.runtime?.desiredPolicyRevision).toBe(2)
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: 'use selected settings', memoryDisabled: true, ...selection })
    expect(f.store.requireChat(f.chat.id)).toMatchObject({ provider: 'pi', planMode: false, memoryDisabled: true,
      executionPolicies: { pi: { policy, revision: 2 } } })
    // Pi intentionally normalizes planMode to false, exactly as for an ordinary empty chat.
    expect(f.calls.starts[0]).toMatchObject({ model: 'fixture-model', effort: 'high' })
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.agent.getCommandCatalog(f.chat.id).runtime?.nativeInstance).toBe(prepared.runtime?.nativeInstance)
    const reloaded = new EventStore(f.store.dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(f.chat.id).executionPolicies?.pi).toEqual({ policy, revision: 2 })
  } finally { await f.cleanup() }
})

test('a Codex draft applies model options and planMode and reuses the prepared session', async () => {
  const f = await preparationFixture('codex', undefined, true)
  try {
    const selection: RuntimeCommandSelection = { ...f.selection, planMode: true,
      modelOptions: { ...f.selection.modelOptions, codex: { reasoningEffort: 'high', fastMode: true } } }
    f.bindRuntime(selection)
    await f.agent.readCommandCatalog(f.chat.id, false, selection)
    const prepared = await f.settled()
    const turns: any[] = [], manager = (f.agent as any).codexManager, start = manager.startTurn
    manager.startTurn = async (args: any) => { turns.push(args); return start(args) }
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: 'selected draft turn', ...selection })
    expect(f.store.requireChat(f.chat.id)).toMatchObject({ provider: 'codex', planMode: true })
    expect(turns[0]).toMatchObject({ model: 'fixture-model', effort: 'high', serviceTier: 'fast', planMode: true })
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.agent.getCommandCatalog(f.chat.id).runtime?.nativeInstance).toBe(prepared.runtime?.nativeInstance)
  } finally { await f.cleanup() }
})

test('a draft native slash prompt promotes through the existing command route', async () => {
  const f = await preparationFixture('pi', undefined, true)
  try {
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: '/fixture draft arguments', ...f.selection })
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.calls.prompts).toEqual(['/fixture draft arguments'])
    expect(f.store.listChats().map(chat => chat.id)).toEqual([f.chat.id])
    expect(f.store.listProjects().map(project => project.id)).toEqual([f.project.id])
  } finally { await f.cleanup() }
})

test.each(['review', 'init'] as const)('Codex /%s reaches the admitted turn with explicit native/host routing', async name => {
  const f = await preparationFixture('codex')
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.settled()
    const manager = (f.agent as any).codexManager
    const native: NativeCommandRuntime = manager.getCommandRuntime(f.chat.id)
    native.discover = () => discoverCodexCommands(async () => ({ data: [] }), f.project.localPath, native.version)
    await f.agent.readCommandCatalog(f.chat.id, true)
    const turns: any[] = []
    const startTurn = manager.startTurn
    manager.startTurn = async (args: any) => { turns.push(args); return startTurn(args) }
    const content = name === 'review' ? '/review base main' : '/init'
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content })
    expect(turns).toHaveLength(1)
    if (name === 'review') expect(turns[0].reviewTarget).toEqual({ type: 'baseBranch', branch: 'main' })
    else {
      expect(turns[0].reviewTarget).toBeUndefined()
      expect(turns[0].content).toBe(CODEX_INIT_PROMPT)
      expect(turns[0].content).not.toBe('/init')
    }
    expect(f.store.getMessages(f.chat.id).some((entry: any) => entry.kind === 'user_prompt' && entry.content === content)).toBe(true)
  } finally { await f.cleanup() }
})

test('catalog preparation acknowledges promptly, deduplicates reads, and the first send waits for initialization', async () => {
  const gate = deferred(), f = await preparationFixture('pi', gate.promise)
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.entered
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    expect(f.calls.preparations).toHaveLength(1)
    let sent = false
    const sending = f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: 'real message', ...f.selection }).then(() => { sent = true })
    await flush()
    expect(sent).toBe(false)
    expect(f.calls.prompts).toEqual([])
    gate.resolve()
    await sending
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.calls.prompts).toEqual(['real message'])
  } finally { gate.resolve(); await f.cleanup() }
})

test('changing only native launch options retires the previous prepared catalog', async () => {
  const f = await preparationFixture('codex')
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    const previous = await f.settled()
    const changed: RuntimeCommandSelection = { ...f.selection, modelOptions: { ...f.selection.modelOptions, codex: { fastMode: true, reasoningEffort: 'high' } }, planMode: true }
    await f.agent.readCommandCatalog(f.chat.id, false, changed)
    const catalog = await f.settled()
    expect(f.calls.preparations).toHaveLength(2)
    expect(catalog.selectionKey).toBe(runtimeCommandSelectionKey(changed))
    expect(catalog.runtimeKey).not.toBe(previous.runtimeKey)
    expect(f.calls.preparations[1].serviceTier).toBe('fast')
    await expect(f.agent.executeCommand({ type: 'chat.executeCommand', chatId: f.chat.id, runtimeKey: previous.runtimeKey!, expectedRevision: previous.revision, commandId: 'native:fixture' })).rejects.toThrow('catalog changed')
    expect(f.calls.prompts).toEqual([])
  } finally { await f.cleanup() }
})

test('a model selection replacement waits for cancelled startup and never publishes the old catalog', async () => {
  const gate = deferred(), f = await preparationFixture('pi', gate.promise)
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.entered
    const changed = { ...f.selection, model: 'replacement-model' }
    f.bindRuntime(changed)
    const pending = await f.agent.readCommandCatalog(f.chat.id, false, changed)
    expect(pending).toMatchObject({ selection: { model: 'replacement-model' }, runtime: null, preparation: { status: 'preparing' } })
    gate.resolve()
    const catalog = await f.settled()
    expect(f.calls.preparations).toHaveLength(2)
    expect(f.calls.preparations[0].signal.aborted).toBe(true)
    expect(catalog.commands.items[0]?.description).toBe('replacement-model')
    expect(f.calls.prompts).toEqual([])
  } finally { gate.resolve(); await f.cleanup() }
})

test('closing a chat during preparation cannot publish or retain a late native session', async () => {
  const gate = deferred(), f = await preparationFixture('pi', gate.promise)
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.entered
    const closing = f.agent.closeChat(f.chat.id)
    expect(f.calls.preparations[0].signal.aborted).toBe(true)
    gate.resolve()
    await closing
    expect(f.agent.getCommandCatalog(f.chat.id).runtime).toBeNull()
    expect(f.calls.prompts).toEqual([])
    expect(f.store.getMessages(f.chat.id)).toEqual([])
  } finally { gate.resolve(); await f.cleanup() }
})

test.each(['pi', 'codex', 'opencode'] as const)('%s preparation and the first turn declare the same nonempty memory tool schemas', async provider => {
  const f = await preparationFixture(provider)
  try {
    // The native fixture never invokes handlers; memory is off for model context, but declarations remain stable across turns.
    ;(f.agent as any).memory = {}
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    const prepared = await f.settled()
    const settings = (f.agent as any).getProviderSettings(provider, f.selection)
    const turnId = crypto.randomUUID()
    const policy = (f.agent as any).executionPolicyFor(f.chat.id, provider)
    const policyScope = (f.agent as any).harnessPolicies.beginTurn(f.chat.id, policy.policy, policy.revision, turnId, 'fixture')
    await (f.agent as any).bootEngineTurn({ chatId: f.chat.id, provider, ...settings, content: 'real turn', attachments: [], turnId, policyScope,
      engineRuntime: (f.agent as any).sessionRuntimes.get(f.chat.id), memoryState: { control: 'auto', memoryActive: false, learnActive: false } },
      { chat: f.store.requireChat(f.chat.id), project: f.project, turnNumber: 1, memoryDisabledForTurn: true })
    const declarations = (args: any) => args.dynamicTools ?? toCodexDynamicTools(args.memorySpecs ?? [])
    const before = declarations(f.calls.preparations[0]), after = declarations(f.calls.starts[0])
    expect(before.map((s: any) => s.name)).toEqual(['load_memory_detail'])
    expect(after).toEqual(before)
    expect(f.agent.getCommandCatalog(f.chat.id).runtime?.nativeInstance).toBe(prepared.runtime?.nativeInstance)
  } finally { await f.cleanup() }
})

test('WS draft commands, harness subscription, promotion and discard use the ordinary chat topic', async () => {
  const f = await preparationFixture('pi', undefined, true)
  const router = createWsRouter({ store: f.store, agent: f.agent, terminals: { onEvent: () => () => {} } as never,
    keybindings: { onChange: () => () => {} } as never, refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: 'Fixture', updateManager: null })
  const sent: any[] = []
  const socket = { data: { subscriptions: new Map(), protectedDraftChatIds: new Set() }, send(text: string) { sent.push(JSON.parse(text)); return text.length } }
  let seq = 0
  const command = async (payload: any) => {
    const id = `command-${++seq}`
    await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'command', id, command: payload }))
    return sent.find(message => message.id === id)
  }
  const latest = (id: string) => sent.filter(message => message.id === id).at(-1)?.snapshot.data
  try {
    router.handleOpen(socket as never)
    const expected = { chatId: f.chat.id, projectId: f.project.id }
    expect(await command({ type: 'chat.ensureDraft', localPath: f.project.localPath })).toMatchObject({ type: 'ack', result: expected })
    expect(await command({ type: 'chat.ensureDraft', projectId: f.project.id })).toMatchObject({ type: 'ack', result: expected })
    expect(await command({ type: 'chat.ensureDraft', projectId: f.project.id, localPath: f.project.localPath })).toMatchObject({ type: 'error' })
    for (const [id, topic] of [['draft-sub', { type: 'chat', chatId: f.chat.id }], ['sidebar-sub', { type: 'sidebar' }], ['projects-sub', { type: 'local-projects' }]] as const) {
      await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'subscribe', id, topic }))
    }
    await router.broadcastSnapshots()
    expect(latest('draft-sub').runtime.harness.policy.desired).toMatchObject({ engine: 'claude' })
    expect(latest('sidebar-sub').projectGroups).toEqual([])
    expect(latest('projects-sub').projects).toEqual([])
    expect(await command({ type: 'chat.setExecutionPolicy', chatId: f.chat.id, expectedRevision: 1, policy: { engine: 'pi', toolGate: 'read-only' } }))
      .toMatchObject({ type: 'ack', result: { desiredRevision: 2 } })
    expect(await command({ type: 'chat.readCommandCatalog', chatId: f.chat.id, selection: f.selection })).toMatchObject({ type: 'ack' })
    await f.settled()
    await router.broadcastSnapshots()
    expect(latest('draft-sub').runtime).toMatchObject({ provider: null, harness: { capabilities: { engine: 'pi' }, policy: { desiredRevision: 2 } },
      commandCatalog: { preparation: { status: 'ready' }, commands: { status: 'ready' } } })
    expect(latest('sidebar-sub').projectGroups).toEqual([])
    expect(await command({ type: 'chat.readHarness', chatId: f.chat.id, engine: 'pi' })).toMatchObject({ type: 'ack', result: { policy: { desiredRevision: 2 } } })
    expect(await command({ type: 'chat.send', chatId: f.chat.id, content: 'promote via WS', ...f.selection })).toMatchObject({ type: 'ack', result: { chatId: f.chat.id } })
    await router.broadcastSnapshots()
    expect(latest('sidebar-sub').projectGroups[0].chats.map((chat: any) => chat.chatId)).toEqual([f.chat.id])
    expect(latest('projects-sub').projects[0]).toMatchObject({ source: 'saved', chatCount: 1 })
    expect(await command({ type: 'chat.discardDraft', chatId: f.chat.id })).toMatchObject({ type: 'ack' })
    expect(f.calls.closed).toBe(0)
    const next = await command({ type: 'chat.ensureDraft', projectId: f.project.id })
    const nextId = next.result.chatId
    expect(nextId).not.toBe(f.chat.id)
    expect(await command({ type: 'chat.discardDraft', chatId: nextId })).toMatchObject({ type: 'ack' })
    expect(await command({ type: 'chat.discardDraft', chatId: nextId })).toMatchObject({ type: 'ack' })
    expect(f.store.getChat(nextId)).toBeNull()
  } finally { router.dispose(); await f.cleanup() }
})

test('sending a draft while preparation is pending waits and reuses that exact session', async () => {
  const gate = deferred(), f = await preparationFixture('pi', gate.promise, true)
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.entered
    const pending = f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: 'wait for preparation', ...f.selection })
    await flush()
    expect(f.calls.prompts).toEqual([])
    gate.resolve()
    expect(await pending).toEqual({ chatId: f.chat.id })
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.calls.closed).toBe(0)
    expect(f.calls.prompts).toEqual(['wait for preparation'])
    expect(f.store.listChats().map(chat => chat.id)).toEqual([f.chat.id])
  } finally { gate.resolve(); await f.cleanup() }
})

test('WS forwards the full preparation selection, acknowledges before native readiness, and rejects invalid payloads', async () => {
  const gate = deferred(), f = await preparationFixture('pi', gate.promise)
  const router = createWsRouter({ store: f.store, agent: f.agent, terminals: { onEvent: () => () => {} } as never,
    keybindings: { onChange: () => () => {} } as never, refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: 'Fixture', updateManager: null })
  const sent: any[] = []
  const socket = { data: { subscriptions: new Map(), protectedDraftChatIds: new Set() }, send(text: string) { sent.push(JSON.parse(text)); return text.length } }
  try {
    await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'command', id: 'prepare', command: { type: 'chat.readCommandCatalog', chatId: f.chat.id, selection: f.selection } }))
    expect(sent.at(-1)).toMatchObject({ type: 'ack', id: 'prepare', result: { selection: f.selection, preparation: { status: 'preparing' } } })
    await router.handleMessage(socket as never, JSON.stringify({ v: 1, type: 'command', id: 'bad', command: { type: 'chat.readCommandCatalog', chatId: f.chat.id, selection: { provider: 'pi', modelOptions: { pi: { reasoningEffort: {} } } } } }))
    expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'bad', message: expect.stringContaining('Invalid command runtime selection') })
    expect(f.calls.prompts).toEqual([])
  } finally { gate.resolve(); router.dispose(); await f.cleanup() }
})

test('failed preparation is explicit, hides private diagnostics, and an explicit refresh retries', async () => {
  const f = await preparationFixture('pi')
  const manager = (f.agent as any).piManager, prepare = manager.prepareSession
  manager.prepareSession = async () => { throw new Error('private-token-do-not-expose') }
  try {
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    const failed = await f.settled()
    expect(failed).toMatchObject({ runtime: null, preparation: { status: 'error' } })
    expect(JSON.stringify(failed)).not.toContain('private-token-do-not-expose')
    manager.prepareSession = prepare
    await f.agent.readCommandCatalog(f.chat.id, true, f.selection)
    expect(await f.settled()).toMatchObject({ preparation: { status: 'ready' }, commands: { status: 'ready' } })
  } finally { await f.cleanup() }
})

test('a policy change cancels preparation and its replacement uses the new revision', async () => {
  const gate = deferred(), f = await preparationFixture('pi', gate.promise)
  try {
    await f.store.setChatProvider(f.chat.id, 'pi')
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    await f.entered
    await f.agent.setExecutionPolicy({ type: 'chat.setExecutionPolicy', chatId: f.chat.id, expectedRevision: 1, policy: { engine: 'pi', toolGate: 'read-only' } })
    expect(f.calls.preparations[0].signal.aborted).toBe(true)
    await f.agent.readCommandCatalog(f.chat.id, false, f.selection)
    gate.resolve()
    const catalog = await f.settled()
    expect(f.calls.preparations).toHaveLength(2)
    expect(catalog.runtime?.desiredPolicyRevision).toBe(2)
    expect(catalog.preparation?.status).toBe('ready')
    expect(f.calls.prompts).toEqual([])
  } finally { gate.resolve(); await f.cleanup() }
})

test('a native slash entry can prepare its session and execute before an ordinary first message', async () => {
  const f = await preparationFixture('pi')
  try {
    await f.agent.send({ type: 'chat.send', chatId: f.chat.id, content: '/fixture exact args', ...f.selection })
    expect(f.calls.preparations).toHaveLength(1)
    expect(f.calls.prompts).toEqual(['/fixture exact args'])
    expect(f.store.getMessages(f.chat.id).filter(entry => entry.kind === 'user_prompt')).toHaveLength(1)
  } finally { await f.cleanup() }
})

test('command selection validation rejects malformed nested options and identities are order independent', () => {
  expect(isRuntimeCommandSelection({ provider: 'unknown' })).toBe(false)
  expect(isRuntimeCommandSelection({ provider: 'pi', modelOptions: [] })).toBe(false)
  expect(isRuntimeCommandSelection({ provider: 'codex', modelOptions: { codex: { fastMode: 'true' } } })).toBe(false)
  expect(isRuntimeCommandSelection({ provider: 'claude', modelOptions: { claude: { contextWindow: {} } } })).toBe(false)
  expect(runtimeCommandSelectionKey({ provider: 'codex', modelOptions: { codex: { fastMode: true, reasoningEffort: 'high' } } }))
    .toBe(runtimeCommandSelectionKey({ modelOptions: { codex: { reasoningEffort: 'high', fastMode: true } }, provider: 'codex', planMode: false }))
})

class LocalCodexProtocol extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: any[] = []
  compactRequest?: string
  injectRequests: string[] = []
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
        if (request.method === 'thread/inject_items') this.injectRequests.push(request.id)
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
    expect((await native.discover()).commands.items.map(c => c.name)).toEqual(['review', 'init'])
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

test('production coordinator binds serialized Codex developer restoration and waits for native ACK', async () => {
  const child = new LocalCodexProtocol()
  const runtime: EngineRuntime = { engine: 'codex', executable: { state: 'ready', version: '0.166.0-alpha.6' },
    env: { HOME: '/temp/isolated-fixture', CODEX_HOME: '/temp/isolated-fixture/codex' }, args: [], model: 'fixture', isolated: true }
  const manager = new CodexAppServerManager({ spawnProcess: () => child as never })
  // No manual setCommandContextRestorer: exercise the actual production constructor seam.
  new AgentCoordinator({ store: {} as never, onStateChange() {}, codexManager: manager })
  try {
    await manager.startSession({ chatId: 'fixture', cwd: '/temp/fixture-project', model: 'fixture', runtime, sessionToken: null })
    const native = manager.getCommandRuntime('fixture')!
    expect(native.restore).toBeFunction()
    let accepted = false
    const first = native.restore!('first-context', new AbortController().signal).then(() => { accepted = true })
    const second = manager.appendDeveloperContext('fixture', 'second-context', new AbortController().signal)
    await flush()
    expect(accepted).toBe(false)
    expect(child.injectRequests).toHaveLength(1)
    await expect(manager.startTurn({ chatId: 'fixture', model: 'fixture', content: 'user', planMode: false, onToolRequest: async () => ({}) })).rejects.toThrow('already running')
    child.write({ id: child.injectRequests[0], result: {} })
    await first
    await flush()
    expect(accepted).toBe(true)
    expect(child.injectRequests).toHaveLength(2)
    child.write({ id: child.injectRequests[1], result: {} })
    await second
    expect(child.requests.filter(r => r.method === 'thread/inject_items').map(r => r.params.items[0])).toMatchObject([
      { role: 'developer', content: [{ text: 'first-context' }] }, { role: 'developer', content: [{ text: 'second-context' }] },
    ])
    expect(child.requests.some(r => r.method === 'turn/start')).toBe(false)
  } finally { await manager.stopAll() }
})
