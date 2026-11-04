import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { OpencodeAgentManager, type StartOpencodeTurnArgs } from './opencode-agent'
import { createMemoryBranch } from './memory/branch-runtime'
import { ModelAccessService } from './model-access/service'
import { resolveEngineRuntime, type EngineRuntime } from './model-access/runtime'
import { createOpencodeFakeModel } from './fixtures/opencode-fake-model'
import type { HarnessEvent, HarnessTurn } from './harness-types'

const binary = process.env.MEMOSYNC_OPENCODE_TEST_BIN
const integration = binary ? describe : describe.skip
integration('OpenCode real-binary backend with scripted local model', () => {
  let root: string, project: string, runtime: EngineRuntime, manager: OpencodeAgentManager
  let fake: ReturnType<typeof createOpencodeFakeModel>
  const groups = new Set<number>()
  function processId(chatId: string) {
    const chats = (manager as unknown as { chats: Map<string, { server: { child: { pid: number }; client?: unknown }; client: any }> }).chats
    const chat = chats.get(chatId)!
    groups.add(chat.server.child.pid)
    return { pid: chat.server.child.pid, client: chat.client }
  }
  function alive(pid: number) { try { process.kill(-pid, 0); return true } catch { return false } }
  async function collect(turn: HarnessTurn) {
    const events: HarnessEvent[] = []
    const timer = setTimeout(() => { void turn.interrupt() }, 20_000)
    try { for await (const event of turn.stream) events.push(event) } finally { clearTimeout(timer) }
    return events
  }
  const token = (events: HarnessEvent[]) => events.find(e => e.type === 'session_token')!.sessionToken!
  const entries = (events: HarnessEvent[]) => events.flatMap(e => e.entry ? [e.entry] : [])
  function start(content: string, extra: Partial<StartOpencodeTurnArgs> = {}) {
    return manager.startTurn({ chatId: 'main', cwd: project, content, model: runtime.model, runtime, systemPrompt: 'STABLE_MEMOSYNC_CONTRACT', memoryContext: 'MEMORY_A', ...extra })
  }
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'memosync-opencode-test-')))
    project = join(root, 'project'); mkdirSync(project)
    // The selected project is below the Git worktree; native read patterns use
    // the worktree as their base, so the host must gate actual tool paths.
    expect(Bun.spawnSync(['git', 'init', '--quiet', root]).exitCode).toBe(0)
    writeFileSync(join(project, 'a.txt'), 'hello fixture')
    writeFileSync(join(project, 'b.txt'), 'second fixture')
    writeFileSync(join(root, 'outside.txt'), 'private outside')
    // A broken host config must not contaminate connection mode.
    const hostConfig = join(root, 'host-config', 'opencode'); mkdirSync(hostConfig, { recursive: true })
    writeFileSync(join(hostConfig, 'opencode.json'), '{ "invalid-option": true }')
    fake = createOpencodeFakeModel(project)
    const credentials = new Map<string, string>()
    const service = await new ModelAccessService({ dataDir: join(root, 'memosync'),
      env: { HOME: root, PATH: process.env.PATH, XDG_CONFIG_HOME: join(root, 'host-config'), MEMOSYNC_ISOLATE_CLI: '1' },
      readLegacyPi: async () => null,
      credentials: { get: async id => credentials.get(id), set: async (id, value) => { if (value) credentials.set(id, value); else credentials.delete(id) } },
      resolveExecutable: async engine => engine === 'opencode' ? { state: 'ready', path: binary!, version: '1.19.5' } : { state: 'missing' },
    }).initialize()
    const connection = await service.saveConnection({ name: 'Fake', endpoints: [{ protocol: 'openai-chat', baseUrl: fake.baseUrl }], models: [{ id: 'vendor/m', contextWindow: 100_000, maxOutputTokens: 4000 }], apiKey: 'fake-integration-key' })
    runtime = await resolveEngineRuntime({ engine: 'opencode', connectionId: connection.id, service })
    Object.assign(runtime.env, {
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    })
    manager = new OpencodeAgentManager()
    groups.clear()
  })
  afterEach(async () => {
    await manager?.dispose()
    fake?.close()
    for (const pid of groups) expect(alive(pid)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('streams text, memory and read calls; changing memory preserves the system and native history', async () => {
    const dispatched: string[] = []
    const specs = [{ name: 'search_memory', description: 'Search saved memory', schema: { query: z.string() }, handler: async () => ({ text: '[M-7] codeword pelican' }) }]
    const extra = { memorySpecs: specs, memoryDispatch: async (name: string) => { dispatched.push(name); return { text: '[M-7] codeword pelican' } } }
    const firstTurn = await start('TURN_MEMORY', extra)
    const original = processId('main')
    const first = await collect(firstTurn)
    const transcript = entries(first)
    expect(transcript.at(-1)).toMatchObject({ kind: 'result', subtype: 'success' })
    expect(first.filter(e => e.type === 'assistant_delta').map(e => e.delta).join('')).toBe('Codeword pelican and hello fixture [M-7].')
    expect(transcript.filter(e => e.kind === 'tool_call').map(e => e.tool)).toMatchObject([
      { toolId: 'call_memory', toolName: 'mcp__memory__search_memory', toolKind: 'mcp_generic' },
      { toolId: 'call_read', toolName: 'Read', toolKind: 'read_file' },
    ])
    expect(transcript.filter(e => e.kind === 'tool_result').map(e => e.toolId)).toEqual(['call_memory', 'call_read'])
    expect(dispatched).toEqual(['search_memory'])
    expect(transcript.filter(e => e.kind === 'context_window_updated').at(-1)).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7, usedTokens: 18, cachedInputTokens: 3 } })
    const before = fake.requests.length
    let secondDispatches = 0
    const second = await collect(await start('TURN_MEMORY', { ...extra, memoryContext: 'MEMORY_B', sessionToken: token(first), memoryDispatch: async () => { secondDispatches++; return { text: 'new turn context' } } }))
    expect(secondDispatches).toBe(1)
    expect(dispatched).toEqual(['search_memory'])
    expect(token(second)).toBe(token(first))
    expect(processId('main').pid).toBe(original.pid)
    const requests = fake.requests.slice(before).filter(r => r.body.tools?.length)
    expect(requests.length).toBeGreaterThan(0)
    const primary = fake.requests.filter(r => r.body.tools?.length)
    const systems = (body: any) => body.messages.filter((m: any) => ['system', 'developer'].includes(m.role))
    expect(JSON.stringify(systems(primary[0].body))).toContain('STABLE_MEMOSYNC_CONTRACT')
    expect(primary.every(r => JSON.stringify(systems(r.body)) === JSON.stringify(systems(primary[0].body)))).toBe(true)
    expect(primary.every(r => !JSON.stringify(systems(r.body)).includes('MEMORY_A') && !JSON.stringify(systems(r.body)).includes('MEMORY_B'))).toBe(true)
    expect(JSON.stringify(requests[0].body.messages.filter((m: any) => m.role === 'user'))).toContain('MEMORY_B')
    // The completed first turn remains an exact prefix, including memory A and
    // native tool results; memory B is appended with the next user message.
    const completedFirstInput = primary.filter(r => fake.requests.indexOf(r) < before).at(-1)!.body.messages
    expect(requests[0].body.messages.slice(0, completedFirstInput.length)).toEqual(completedFirstInput)
    expect(requests[0].body.tools).toEqual(primary[0].body.tools)
    expect(fake.requests.every(r => r.authorization === 'Bearer fake-integration-key')).toBe(true)
  }, 40_000)

  test('question calls use onToolRequest and resume after the supplied answer', async () => {
    const calls: string[] = []
    const events = await collect(await start('TURN_QUESTION', { onToolRequest: async ({ tool }) => { calls.push(tool.toolId); expect(tool.toolKind).toBe('ask_user_question'); return { answers: { 'Pick a color?': 'blue' } } } }))
    processId('main')
    expect(calls).toEqual(['call_question'])
    expect(entries(events).filter(e => e.kind === 'tool_call')).toHaveLength(1)
    expect(entries(events).filter(e => e.kind === 'assistant_text').at(-1)).toMatchObject({ text: expect.stringContaining('blue') })
    expect(entries(events).at(-1)).toMatchObject({ subtype: 'success' })
  }, 30_000)

  test('interrupt ends the turn and kills the wrapper/server process group; stored session resumes', async () => {
    const turn = await start('CANCEL_STREAM')
    const { pid } = processId('main')
    const events: HarnessEvent[] = []
    for await (const event of turn.stream) {
      events.push(event)
      if (event.type === 'assistant_delta') { await turn.interrupt() }
    }
    expect(entries(events).at(-1)).toMatchObject({ subtype: 'cancelled' })
    expect(alive(pid)).toBe(false)
    const resumed = await collect(await start('TURN_SECOND', { sessionToken: token(events) }))
    processId('main')
    expect(token(resumed)).toBe(token(events))
    expect(entries(resumed).at(-1)).toMatchObject({ subtype: 'success' })
  }, 35_000)

  test('model errors reach the transcript without private response headers', async () => {
    const events = await collect(await start('MODEL_ERROR'))
    processId('main')
    expect(entries(events).at(-1)).toMatchObject({ kind: 'result', isError: true, result: expect.stringContaining('Scripted model failure') })
    expect(JSON.stringify(events)).not.toContain('never-export-this-header')
  }, 25_000)

  test('account model parsing splits only the first slash and preserves the model namespace', async () => {
    const accountRuntime: EngineRuntime = { ...runtime, connectionId: undefined, model: 'memosync/vendor/m' }
    const result = await collect(await start('TURN_SECOND', { runtime: accountRuntime }))
    processId('main')
    expect(entries(result).at(-1)).toMatchObject({ subtype: 'success' })
    expect(fake.requests.filter(r => r.body.tools?.length).every(r => r.body.model === 'vendor/m')).toBe(true)
  }, 20_000)

  test('changed launch credentials restart the process while resume preserves the session', async () => {
    const first = await collect(await start('TURN_SECOND'))
    const previous = processId('main').pid
    const changed: EngineRuntime = { ...runtime, env: { ...runtime.env, MEMOSYNC_MODEL_API_KEY: 'fake-rotated-key' } }
    const before = fake.requests.length
    const next = await collect(await start('TURN_SECOND', { runtime: changed, sessionToken: token(first) }))
    expect(token(next)).toBe(token(first))
    expect(processId('main').pid).not.toBe(previous)
    expect(alive(previous)).toBe(false)
    expect(fake.requests.slice(before).every(r => r.authorization === 'Bearer fake-rotated-key')).toBe(true)
  }, 30_000)

  test('disposing an interrupted analysis deletes its fork and closes its private server', async () => {
    const parent = await collect(await start('TURN_SECOND'))
    const { client } = processId('main')
    const parentToken = token(parent)
    const branch = createMemoryBranch({ provider: 'opencode', parentSessionToken: parentToken, localPath: project, model: runtime.model, runtime })
    const result = branch.ask('CANCEL_STREAM').then(() => null, error => error)
    const deadline = Date.now() + 10_000
    while (!branch.sessionToken && Date.now() < deadline) await Bun.sleep(10)
    const fork = branch.sessionToken
    expect(fork).toBeTruthy()
    await branch.dispose()
    expect(await result).toBeInstanceOf(Error)
    expect((await client.session.get({ sessionID: fork! })).error).toBeDefined()
    expect((await client.session.get({ sessionID: parentToken })).data.id).toBe(parentToken)
  }, 30_000)

  test('forks a live parent, gates branch reads and budget, preserves parent history and deletes fork', async () => {
    const parent = await collect(await start('TURN_SECOND', {
      memorySpecs: [{ name: 'search_memory', description: 'Search memory', schema: { query: z.string() }, handler: async () => ({ text: 'parent only' }) }],
      memoryDispatch: async () => ({ text: 'parent only' }),
    }))
    const { client } = processId('main')
    const parentToken = token(parent)
    const before = (await client.session.messages({ sessionID: parentToken })).data.length
    const branch = createMemoryBranch({ provider: 'opencode', parentSessionToken: parentToken, localPath: project, model: runtime.model, runtime, timeoutMs: 25_000 })
    try {
      const result = await branch.ask('BRANCH_ANALYSIS', { budget: { maxTurns: 8, maxToolCalls: 2 } })
      expect(result).toEqual({ inside: true, outsideDenied: true, bashDenied: true })
      expect(branch.sessionToken).not.toBe(parentToken)
      expect(existsSync(join(project, 'should-not-exist'))).toBe(false)
      expect((await client.session.messages({ sessionID: parentToken })).data.length).toBe(before)
      const offered = fake.requests.filter(r => JSON.stringify(r.body.messages).includes('BRANCH_ANALYSIS') && r.body.tools?.length)
      expect(offered.length).toBeGreaterThan(0)
      expect(offered.every(r => r.body.tools.every((t: any) => ['read', 'grep', 'glob'].includes(t.function.name)))).toBe(true)
      const sameFork = branch.sessionToken
      const budgetResult = await branch.ask('BRANCH_BUDGET', { budget: { maxTurns: 6, maxToolCalls: 1 } })
      expect(budgetResult).toEqual({ budgetDenied: true })
      expect(branch.sessionToken).toBe(sameFork)
      expect(await branch.ask('INVALID_JSON', { schema: { type: 'object', required: ['codeword'], properties: { codeword: { type: 'string' } } }, budget: { maxTurns: 2, maxToolCalls: 0 } })).toEqual({ codeword: 'pelican' })
      expect(branch.sessionToken).toBe(sameFork)
      const fork = branch.sessionToken!
      await branch.dispose()
      const response = await client.session.get({ sessionID: fork })
      expect(response.error).toBeDefined()
    } finally { await branch.dispose() }
  }, 60_000)
})
