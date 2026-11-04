import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeToolCall } from '../shared/tools'
import { OPENCODE_SYSTEM_PROMPT, OpencodeAgentManager, translateOpencodeTool } from './opencode-agent'
import type { HarnessEvent, HarnessTurn } from './harness-types'
import { createMemoryBranch } from './memory/branch-runtime'
import { isOpencodeBranchRead } from './memory/branch-read-policy'
import type { EngineRuntime } from './model-access/runtime'

const managers: OpencodeAgentManager[] = []
const roots: string[] = []
const observers: Array<{ stop(closeActiveConnections?: boolean): void }> = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.dispose()))
  for (const observer of observers.splice(0)) observer.stop(true)
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

for (const [name, input, expectedName, kind, expectedInput] of [
  ['read', { filePath: 'a', offset: 2, limit: 3 }, 'Read', 'read_file', { filePath: 'a' }],
  ['bash', { command: 'pwd', timeout: 123 }, 'Bash', 'bash', { command: 'pwd', timeoutMs: 123 }],
  ['edit', { filePath: 'a', oldString: 'x', newString: 'y' }, 'Edit', 'edit_file', { filePath: 'a', oldString: 'x', newString: 'y' }],
  ['write', { filePath: 'a', content: 'y' }, 'Write', 'write_file', { filePath: 'a', content: 'y' }],
  ['grep', { pattern: 'x', path: 'a', include: '*.ts' }, 'Grep', 'grep', { pattern: 'x' }],
  ['glob', { pattern: '*.ts' }, 'Glob', 'glob', { pattern: '*.ts' }],
  ['list', { path: 'src/' }, 'Glob', 'glob', { pattern: 'src/*' }],
  ['webfetch', { url: 'https://example.test' }, 'WebFetch', 'unknown_tool', { payload: { url: 'https://example.test' } }],
  ['websearch', { query: 'q' }, 'WebSearch', 'web_search', { query: 'q' }],
  ['todowrite', { todos: [] }, 'TodoWrite', 'todo_write', { todos: [] }],
  ['task', { subagent_type: 'explore' }, 'Task', 'subagent_task', { subagentType: 'explore' }],
  ['question', { questions: [{ question: 'q', multiple: true }] }, 'AskUserQuestion', 'ask_user_question', { questions: [{ question: 'q', multiSelect: true }] }],
  ['memosync_search_memory', { query: 'q' }, 'mcp__memory__search_memory', 'mcp_generic', { server: 'memory', tool: 'search_memory', payload: { query: 'q' } }],
  ['unknown', { x: 1 }, 'unknown', 'unknown_tool', { payload: { x: 1 } }],
] as const) test(`OpenCode tool ${name} normalizes for the transcript`, () => {
  const translated = translateOpencodeTool(name, input)
  expect(translated.toolName).toBe(expectedName)
  expect(normalizeToolCall({ ...translated, toolId: 'stable-call-id' })).toMatchObject({ toolId: 'stable-call-id', toolKind: kind, input: expectedInput })
})

async function runFixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-transport-')); roots.push(root)
  const runtime: EngineRuntime = { engine: 'opencode', executable: { state: 'ready', path: join(import.meta.dir, 'fixtures/opencode-server-fixture.ts') }, env: { HOME: root, PATH: process.env.PATH }, args: [], model: 'connected/m', isolated: true }
  const manager = new OpencodeAgentManager(); managers.push(manager)
  const turn = await manager.startTurn({ chatId: 'fixture', cwd: root, content: mode, model: runtime.model, runtime })
  const events: HarnessEvent[] = []
  for await (const event of turn.stream) events.push(event)
  return events
}
for (const [mode, error] of [['empty', 'without assistant output'], ['disconnect', 'event stream disconnected'], ['exit', 'server exited'], ['retry', 'Scripted retry exhaustion']] as const) {
  test(`OpenCode ${mode} terminates rather than hanging`, async () => {
    const events = await runFixture(mode)
    expect(events.at(-1)?.entry).toMatchObject({ kind: 'result', isError: true, result: mode === 'exit' ? expect.stringMatching(/server exited|event stream disconnected/) : expect.stringContaining(error) })
  }, 10_000)
}
test('SSE admits assistant text only, buffers unknown part deltas, drops reasoning and deduplicates terminal tools', async () => {
  const events = await runFixture('mixed')
  expect(events.filter(e => e.type === 'assistant_delta')).toMatchObject([{ itemId: 'text', delta: 'visible' }])
  const entries = events.flatMap(e => e.entry ? [e.entry] : [])
  expect(entries.filter(e => e.kind === 'assistant_text')).toMatchObject([{ text: 'visible' }])
  expect(entries.filter(e => e.kind === 'status')).toEqual([])
  expect(entries.filter(e => e.kind === 'tool_call')).toMatchObject([{ tool: { toolId: 'terminal-call' } }])
  expect(entries.filter(e => e.kind === 'tool_result')).toMatchObject([{ toolId: 'terminal-call', content: 'fixture result' }])
  expect(JSON.stringify(events)).not.toMatch(/USER-LEAK|REASONING-LEAK|CHILD-LEAK/)
})

test('unexpected parent permission requests are rejected and recorded as tool errors', async () => {
  const events = await runFixture('permission')
  expect(events.flatMap(e => e.entry?.kind === 'tool_result' ? [e.entry] : [])).toMatchObject([{ toolId: 'permission-call', isError: true, content: expect.stringContaining('permission rejected') }])
  expect(events.at(-1)?.entry).toMatchObject({ kind: 'result', subtype: 'success' })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function journal<T>() {
  const values: T[] = [], listeners = new Set<() => void>()
  return {
    values,
    push(value: T) { values.push(value); for (const listener of [...listeners]) listener() },
    waitFor(predicate: (value: T) => boolean): Promise<T> {
      const current = values.find(predicate)
      if (current !== undefined) return Promise.resolve(current)
      return new Promise(resolve => {
        const check = () => {
          const value = values.find(predicate)
          if (value !== undefined) { listeners.delete(check); resolve(value) }
        }
        listeners.add(check)
      })
    },
  }
}
interface FixtureNotice { kind: string; origin?: string; path?: string; method?: string; body?: unknown }
function lifecycleFixture(holdHistory = false, sameParent = false) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-lifecycle-')); roots.push(root)
  const notices = journal<FixtureNotice>()
  const observer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    notices.push(await request.json() as FixtureNotice)
    return Response.json(true)
  } })
  observers.push(observer)
  const runtime: EngineRuntime = {
    engine: 'opencode', executable: { state: 'ready', path: join(import.meta.dir, 'fixtures/opencode-agent-lifecycle-fixture.ts') },
    env: { HOME: root, PATH: process.env.PATH, FAKE_OC_OBSERVER: `http://127.0.0.1:${observer.port}`, FAKE_OC_HISTORY: holdHistory ? 'hold' : '', FAKE_OC_SAME_PARENT: sameParent ? '1' : '' },
    args: [], model: 'fixture/local', isolated: true,
  }
  const manager = new OpencodeAgentManager(); managers.push(manager)
  return {
    root, runtime, manager, notices,
    async post(path: string, body: unknown = null) {
      const { origin } = await notices.waitFor(n => n.kind === 'ready')
      const response = await fetch(`${origin}${path}`, { method: 'POST', body: JSON.stringify(body) })
      expect(response.ok).toBe(true)
    },
    start(args: Partial<Parameters<OpencodeAgentManager['startTurn']>[0]> = {}) {
      return manager.startTurn({ chatId: 'lifecycle', cwd: root, content: 'fixture', model: runtime.model, runtime, ...args })
    },
  }
}
test('native session rules must be confirmed before policy application and prompt dispatch', async () => {
  const f = lifecycleFixture(), applied = journal<string>()
  const turn = await f.start({ executionPolicy: { engine: 'opencode', permission: 'ask' }, onExecutionPolicyApplied: async id => { applied.push(id!) } })
  expect(applied.values).toEqual(['ses_created'])
  const update = await f.notices.waitFor(n => n.method === 'PATCH')
  expect(update.body).toEqual({ permission: [{ permission: '*', pattern: '*', action: 'ask' }] })
  await f.notices.waitFor(n => n.path?.endsWith('/prompt_async') === true)
  await turn.interrupt()

  const rejected = lifecycleFixture()
  rejected.runtime.env.FAKE_OC_REJECT_POLICY = '1'
  let confirmed = false
  await expect(rejected.start({ executionPolicy: { engine: 'opencode', permission: 'deny' }, onExecutionPolicyApplied: async () => { confirmed = true } })).rejects.toThrow('did not confirm')
  expect(confirmed).toBe(false)
  expect(rejected.notices.values.some(n => n.path?.endsWith('/prompt_async'))).toBe(false)
})

test('duplicate native permissions prompt once and an expired reply is rejected', async () => {
  const f = lifecycleFixture(), answer = deferred<boolean>(), entered = deferred<void>()
  let current = true, calls = 0
  const turn = await f.start({ isPolicyCurrent: () => current, onPermissionRequest: async () => { calls++; entered.resolve(); return answer.promise } })
  const event = { type: 'permission.asked', properties: { id: 'permission-1', sessionID: 'ses_created', permission: 'bash', patterns: ['*'], always: [], metadata: { command: 'synthetic' } } }
  await f.post('/test/events', [event, event])
  await entered.promise
  current = false
  answer.resolve(true)
  const reply = await f.notices.waitFor(n => n.path === '/permission/permission-1/reply')
  expect(reply.body).toMatchObject({ reply: 'reject' })
  expect(calls).toBe(1)
  await turn.interrupt()
})

function collectTurn(turn: HarnessTurn) {
  const events = journal<HarnessEvent>()
  const done = (async () => { for await (const event of turn.stream) events.push(event) })()
  return { events, done }
}
const question = (id: string, callID?: string) => ({ type: 'question.asked', properties: {
  sessionID: 'ses_created', id, ...(callID ? { tool: { callID, messageID: 'assistant' } } : {}),
  questions: [{ question: `Question ${id}`, header: id, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiple: true }],
} })
const marker = (id: string) => [
  { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'ses_created', role: 'assistant', time: { created: 1 } } } },
  { type: 'message.part.updated', properties: { part: { id, sessionID: 'ses_created', messageID: 'assistant', type: 'text', text: '' } } },
  { type: 'message.part.delta', properties: { sessionID: 'ses_created', messageID: 'assistant', partID: id, field: 'text', delta: id } },
]

test.each([undefined, 'CUSTOM_STABLE_SYSTEM'])('changing OpenCode memory uses prompt parts with stable system and native session (%s)', async systemPrompt => {
  const f = lifecycleFixture(), launches: any[] = []
  let token: string | undefined
  for (const [index, memoryContext] of ['MEMORY_A', 'MEMORY_B', undefined].entries()) {
    const content = `TURN_${index}`
    const turn = await f.start({ systemPrompt, memoryContext, content, sessionToken: token, onLaunch: launch => launches.push(launch) })
    const { events, done } = collectTurn(turn)
    const request = await f.notices.waitFor(n => n.path?.endsWith('/prompt_async') === true && JSON.stringify(n.body).includes(content))
    const body = request.body as any
    expect(body.system).toBe(systemPrompt ?? OPENCODE_SYSTEM_PROMPT)
    expect(body.parts).toEqual([
      ...(memoryContext ? [{ type: 'text', text: memoryContext }] : []),
      { type: 'text', text: content },
    ])
    expect(JSON.stringify(body.system)).not.toContain('MEMORY_')
    expect(request.path).toBe('/session/ses_created/prompt_async')
    await f.post('/test/events', [
      { type: 'message.updated', properties: { info: { id: `reply-${index}`, sessionID: 'ses_created', role: 'assistant', time: { created: 1 } } } },
      { type: 'message.part.updated', properties: { part: { id: `text-${index}`, sessionID: 'ses_created', messageID: `reply-${index}`, type: 'text', text: `reply ${index}`, time: { start: 1, end: 2 } } } },
      { type: 'session.idle', properties: { sessionID: 'ses_created' } },
    ])
    await done
    expect(events.values.at(-1)?.entry).toMatchObject({ kind: 'result', subtype: 'success' })
    token = events.values.find(e => e.type === 'session_token')?.sessionToken
    expect(token).toBe('ses_created')
  }
  expect(f.notices.values.filter(n => n.path === '/session')).toHaveLength(1)
  expect(f.notices.values.filter(n => n.path === '/session/ses_created/message')).toHaveLength(3)
  expect(f.notices.values.filter(n => n.method === 'DELETE' || n.path?.endsWith('/fork'))).toHaveLength(0)
  expect(launches).toHaveLength(3)
  for (const launch of launches) {
    expect(launch.options.systemPrompt).toBe(systemPrompt ?? OPENCODE_SYSTEM_PROMPT)
    expect(launch.options).not.toHaveProperty('memoryContext')
  }
}, 10_000)

for (const firstAnswer of ['reply', 'cancelled', 'throw'] as const) test(`questions serialize user callbacks through ${firstAnswer} acknowledgement and deduplicate request IDs`, async () => {
  const f = lifecycleFixture(), invoked = journal<string>(), first = deferred<unknown>(), second = deferred<unknown>()
  const turn = await f.start({ onToolRequest: async ({ tool }) => {
    invoked.push(tool.toolId)
    if (tool.toolId === 'native-call') {
      const response = await first.promise
      if (firstAnswer === 'throw') throw new Error('User callback failed')
      return response
    }
    return second.promise
  } })
  const { events, done } = collectTurn(turn)
  await f.notices.waitFor(n => n.path?.endsWith('/prompt_async') === true)
  await f.post('/test/events', [
    question('q1', 'native-call'), question('q1', 'native-call'),
    { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'ses_created', role: 'assistant', time: { created: 1 } } } },
    { type: 'message.part.updated', properties: { part: { id: 'question-part-2', sessionID: 'ses_created', messageID: 'assistant', type: 'tool', callID: 'q2', tool: 'question', state: { status: 'running', input: { questions: [] } } } } },
    question('q2'), ...marker('batch-read'),
  ])
  await events.waitFor(e => e.delta === 'batch-read')
  expect(invoked.values).toEqual(['native-call'])
  // The UI enables only its latest question, so queued questions must stay out
  // of the transcript until they actually become the host's pending request.
  expect(events.values.flatMap(e => e.entry?.kind === 'tool_call' ? [e.entry.tool.toolId] : [])).toEqual(['native-call'])
  first.resolve(firstAnswer === 'cancelled' ? { cancelled: true } : { answers: { q1: ['A', 'B'] } })
  const firstPath = `/question/q1/${firstAnswer === 'reply' ? 'reply' : 'reject'}`
  const answer = await f.notices.waitFor(n => n.kind === 'answer' && n.path === firstPath)
  if (firstAnswer === 'reply') expect(answer.body).toEqual({ answers: [['A', 'B']] })
  // The fixture holds the HTTP response even though the user callback resolved.
  expect(invoked.values).toEqual(['native-call'])
  await f.post('/test/answer/q1')
  await invoked.waitFor(id => id === 'q2')
  await f.post('/test/events', [question('q1', 'native-call'), question('q2'), ...marker('replay-read')])
  await events.waitFor(e => e.delta === 'replay-read')
  expect(invoked.values).toEqual(['native-call', 'q2'])
  second.resolve({ answers: { 'Question q2': 'B' } })
  expect((await f.notices.waitFor(n => n.path === '/question/q2/reply')).body).toEqual({ answers: [['B']] })
  await f.post('/test/answer/q2')
  await f.post('/test/events', [{ type: 'session.idle', properties: { sessionID: 'ses_created' } }])
  await done
  expect(events.values.flatMap(e => e.entry?.kind === 'tool_call' ? [e.entry.tool.toolId] : [])).toEqual(['native-call', 'q2'])
  expect(f.notices.values.filter(n => n.kind === 'answer')).toHaveLength(2)
  expect(events.values.at(-1)?.entry).toMatchObject({ kind: 'result', subtype: 'success' })
}, 10_000)

for (const ending of ['cancel', 'error', 'idle'] as const) test(`a queued question cannot start after ${ending}, while SSE continues reading`, async () => {
  const f = lifecycleFixture(), controller = new AbortController(), answer = deferred<unknown>(), invoked: string[] = []
  const turn = await f.start({ signal: controller.signal, onToolRequest: ({ tool }) => { invoked.push(tool.toolId); return answer.promise } })
  const { events, done } = collectTurn(turn)
  await f.notices.waitFor(n => n.path?.endsWith('/prompt_async') === true)
  await f.post('/test/events', [question('q1'), question('q2'), ...marker('questions-read')])
  await events.waitFor(e => e.delta === 'questions-read')
  if (ending === 'cancel') controller.abort()
  else await f.post('/test/events', [{ type: ending === 'error' ? 'session.error' : 'session.idle', properties: {
    sessionID: 'ses_created', ...(ending === 'error' ? { error: { name: 'FixtureError', data: { message: 'Stopped during question' } } } : {}),
  } }])
  await done
  expect(events.values.at(-1)?.entry).toMatchObject({ kind: 'result', subtype: ending === 'cancel' ? 'cancelled' : ending === 'error' ? 'error' : 'success' })
  answer.resolve({ answers: { q1: 'A' } })
  // Drain the promise continuations after the pending callback is released.
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(invoked).toEqual(['q1'])
  expect(f.notices.values.filter(n => n.kind === 'answer')).toEqual([])
}, 10_000)

test('cancellation remains responsive while question acknowledgement is pending', async () => {
  const f = lifecycleFixture(), controller = new AbortController(), invoked: string[] = []
  const turn = await f.start({ signal: controller.signal, onToolRequest: async ({ tool }) => {
    invoked.push(tool.toolId)
    return { answers: { q1: 'A' } }
  } })
  const { events, done } = collectTurn(turn)
  await f.notices.waitFor(n => n.path?.endsWith('/prompt_async') === true)
  await f.post('/test/events', [question('q1'), question('q2')])
  await f.notices.waitFor(n => n.path === '/question/q1/reply')
  expect(invoked).toEqual(['q1'])
  controller.abort()
  await done
  await turn.interrupt()
  expect(events.values.at(-1)?.entry).toMatchObject({ kind: 'result', subtype: 'cancelled' })
  expect(invoked).toEqual(['q1'])
  expect(f.notices.values.filter(n => n.kind === 'answer')).toHaveLength(1)
}, 10_000)

test('a successfully delivered analysis session remains owned by the branch until disposal', async () => {
  const f = lifecycleFixture(true)
  const branch = createMemoryBranch({ provider: 'opencode', localPath: f.root, model: f.runtime.model,
    runtime: f.runtime, parentSessionToken: 'ses_parent' }, { opencodeManager: f.manager })
  const request = branch.ask('Return JSON.')
  await f.notices.waitFor(n => n.path === '/session/ses_fork/message')
  await f.post('/test/history', 'ok')
  await f.notices.waitFor(n => n.path === '/session/ses_fork/prompt_async')
  await f.post('/test/events', [
    { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'ses_fork', role: 'assistant', time: { created: 1 } } } },
    { type: 'message.part.updated', properties: { part: { id: 'json', sessionID: 'ses_fork', messageID: 'assistant', type: 'text', text: '{"ok":true}', time: { start: 1, end: 2 } } } },
    { type: 'session.idle', properties: { sessionID: 'ses_fork' } },
  ])
  expect(await request).toEqual({ ok: true })
  expect(branch.sessionToken).toBe('ses_fork')
  expect(f.notices.values.filter(n => n.method === 'DELETE')).toEqual([])
  const disposal = branch.dispose()
  await f.notices.waitFor(n => n.method === 'DELETE')
  await f.post('/test/delete')
  await disposal
  await f.manager.dispose()
  expect(f.notices.values.filter(n => n.method === 'DELETE').map(n => n.path)).toEqual(['/session/ses_fork'])
}, 10_000)

for (const parent of [null, 'ses_parent']) for (const ending of ['cancel', 'branch-dispose', 'manager-dispose', 'history-error', 'timeout'] as const) {
  test(`unclaimed ${parent ? 'forked' : 'created'} analysis session is deleted before shutdown on ${ending}`, async () => {
    const f = lifecycleFixture(true), controller = new AbortController()
    const branch = createMemoryBranch({ provider: 'opencode', localPath: f.root, model: f.runtime.model, runtime: f.runtime,
      parentSessionToken: parent, timeoutMs: ending === 'timeout' ? 2000 : 30_000 }, { opencodeManager: f.manager })
    const request = branch.ask('Return JSON.', { signal: controller.signal })
    const failure = request.then(() => { throw new Error('Expected initialization failure') }, error => error as Error)
    const sessionID = parent ? 'ses_fork' : 'ses_created'
    await f.notices.waitFor(n => n.method === 'GET' && n.path === `/session/${sessionID}/message`)
    expect(f.manager.hasPendingWork(branch.id)).toBe(true)
    expect(branch.sessionToken).toBeNull()
    let branchDisposal: void | Promise<void> = undefined, managerDisposal: Promise<void> | undefined
    if (ending === 'cancel') controller.abort(new Error('External cancel'))
    if (ending === 'branch-dispose') branchDisposal = branch.dispose()
    if (ending === 'manager-dispose') managerDisposal = f.manager.dispose()
    if (ending === 'history-error') await f.post('/test/history', 'error')
    await f.notices.waitFor(n => n.method === 'DELETE' && n.path === `/session/${sessionID}`)
    managerDisposal ??= f.manager.dispose()
    let stopped = false
    void managerDisposal.then(() => { stopped = true })
    expect(stopped).toBe(false)
    expect(branch.sessionToken).toBeNull()
    // Deletion must reach the server despite the already aborted request signal.
    await f.post('/test/delete')
    await managerDisposal
    const error = await failure
    expect(error).toBeInstanceOf(Error)
    if (ending === 'cancel') expect(error.message).toContain('External cancel')
    if (ending === 'history-error') expect(error.message).toContain('Unable to read OpenCode session history')
    if (ending === 'timeout') expect(error.message).toContain('timed out')
    await branchDisposal!
    await branch.dispose()
    expect(f.notices.values.filter(n => n.method === 'DELETE').map(n => n.path)).toEqual([`/session/${sessionID}`])
    expect(f.notices.values.some(n => n.path?.endsWith('/prompt_async'))).toBe(false)
  }, 10_000)
}

for (const mode of ['resumed', 'parent-returned', 'main-created'] as const) test(`initialization failure never deletes a ${mode} session`, async () => {
  const f = lifecycleFixture(true, mode === 'parent-returned')
  const request = f.start({ agent: mode === 'main-created' ? undefined : 'memosync-branch',
    sessionToken: mode === 'resumed' ? 'ses_existing' : mode === 'parent-returned' ? 'ses_parent' : null,
    forkSession: mode === 'parent-returned' })
  const failure = request.then(() => { throw new Error('Expected history failure') }, error => error as Error)
  await f.notices.waitFor(n => n.path?.endsWith('/message') === true)
  await f.post('/test/history', 'error')
  expect((await failure).message).toContain('Unable to read OpenCode session history')
  await f.manager.dispose()
  expect(f.notices.values.filter(n => n.method === 'DELETE')).toEqual([])
}, 10_000)

test('analysis initialization cleanup has its own bounded deadline when deletion stalls', async () => {
  const f = lifecycleFixture(true)
  const request = f.start({ agent: 'memosync-branch', sessionToken: 'ses_parent', forkSession: true })
  const failure = request.then(() => { throw new Error('Expected history failure') }, error => error as Error)
  await f.notices.waitFor(n => n.path?.endsWith('/message') === true)
  await f.post('/test/history', 'error')
  await f.notices.waitFor(n => n.method === 'DELETE')
  await f.manager.dispose()
  expect((await failure).message).toContain('Unable to delete uninitialized OpenCode analysis session')
  expect(f.notices.values.filter(n => n.method === 'DELETE').map(n => n.path)).toEqual(['/session/ses_fork'])
}, 10_000)

test('branch gate validates actual project paths, including siblings and symlinks, rather than permission expressions', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-path-gate-')); roots.push(root)
  const project = join(root, 'project'); mkdirSync(project)
  writeFileSync(join(root, 'outside.txt'), 'outside')
  writeFileSync(join(project, 'inside.txt'), 'inside')
  symlinkSync(join(root, 'outside.txt'), join(project, 'linked.txt'))
  expect(isOpencodeBranchRead('read', { filePath: join(project, 'inside.txt') }, project)).toBe(true)
  expect(isOpencodeBranchRead('read', { filePath: join(root, 'outside.txt') }, project)).toBe(false)
  expect(isOpencodeBranchRead('read', { filePath: join(project, 'linked.txt') }, project)).toBe(false)
  expect(isOpencodeBranchRead('grep', { pattern: '../is-a-regex', path: project }, project)).toBe(true)
  expect(isOpencodeBranchRead('grep', { pattern: 'inside', path: root }, project)).toBe(false)
  expect(isOpencodeBranchRead('glob', { pattern: '../outside.txt', path: project }, project)).toBe(false)
  expect(isOpencodeBranchRead('bash', { command: 'pwd' }, project)).toBe(false)
})
