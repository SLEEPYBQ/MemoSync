/**
 * Offline proof that a memory branch shares its parent's prompt prefix and
 * stays read-only, on the real Claude Code (SDK-bundled), Codex and Pi.
 *
 * Fake upstreams on loopback record every request; credentials are fake and
 * nothing leaves the machine. For each engine the branch's first request must
 * equal the parent's next request on tools, system/instructions, earlier
 * messages, model and effort (Codex fork regenerates message ids, which are
 * excluded), and write / non-allowlisted Bash / memory calls must be denied
 * even when the user's settings allow them.
 *
 *   bun scripts/smoke-branch-prefix.ts               # parent with web search
 *   bun scripts/smoke-branch-prefix.ts --codex-no-web
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startClaudeSession } from '../src/server/agent'
import { createMemoryBranch } from '../src/server/memory/branch-runtime'
import { MemoryService } from '../src/server/memory'
import type { EngineRuntime } from '../src/server/model-access/runtime'

// Compare complete captured structures; only Codex message IDs are excluded
// explicitly below because its fork regenerates transport IDs, not prompt text.
function firstDifference(actual: any, expected: any, path = '$'): string | null {
  if (Object.is(actual, expected)) return null
  if (typeof actual !== typeof expected || actual === null || expected === null) return path
  if (typeof actual !== 'object') return path
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const next = Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`
    if (!(key in actual) || !(key in expected)) return next
    const difference = firstDifference(actual[key], expected[key], next)
    if (difference) return difference
  }
  return null
}
function equal(actual: unknown, expected: unknown, path = '$') {
  const difference = firstDifference(actual, expected, path)
  if (difference) throw new Error(`first differing path: ${difference}`)
}
const codexNoWeb = process.argv.includes('--codex-no-web')
const root = mkdtempSync(join(tmpdir(), 'memosync-prefix-'))
const cwd = join(root, 'project')
mkdirSync(cwd)
mkdirSync(join(root, 'claude'))
writeFileSync(join(root, 'claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Write', 'Bash', 'mcp__memory__*'] } }))
const memory = new MemoryService({ dbPath: ':memory:', dataDir: join(root, 'memory') })
memory.store.create({ content: 'Preserve project conventions.', type: 'constraint', scope: 'project', projectId: 'smoke-project' }, { actor: 'user' })
const requests: any[] = []
let branchMode = false
let branchCalls = 0
function sse(event: string, data: unknown) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({}))
  if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 })
  requests.push(body)
  const probes = [
    { name: 'Write', input: { file_path: join(cwd, 'MUST_NOT_EXIST'), content: 'unsafe' } },
    { name: 'Bash', input: { command: `touch ${join(cwd, 'BASH_MUST_NOT_EXIST')}` } },
    { name: body.tools.find((tool: any) => tool.name?.startsWith('mcp__memory__'))?.name, input: { ids: [] } },
    { name: 'WebSearch', input: { query: 'MUST NOT CONTACT NETWORK' } },
  ]
  const probe = branchMode ? probes[branchCalls++] : undefined
  const call = Boolean(probe)
  const content = probe ? { type: 'tool_use', id: `tool_probe_${branchCalls}`, ...probe } : { type: 'text', text: '{"ok":true}' }
  const msg = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }
  return new Response([
    sse('message_start', { type: 'message_start', message: msg }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { ...content, input: {} } : { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(probe!.input) } : { type: 'text_delta', text: content.text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
} })
const env: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
  PATH: process.env.PATH, HOME: root, TMPDIR: root,
  CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_API_KEY: 'offline-fake-key',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', DISABLE_AUTOUPDATER: '1',
}
const runtime: EngineRuntime = { engine: 'claude', model: 'claude-sonnet-4-6', env, args: [], isolated: false,
  executable: { state: 'ready', path: resolve(`node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`) } }
let main: Awaited<ReturnType<typeof startClaudeSession>> | undefined
let branch: ReturnType<typeof createMemoryBranch> | undefined
try {
  main = await startClaudeSession({ localPath: cwd, model: runtime.model, effort: 'low', planMode: false, sessionToken: null, forkSession: false,
    onToolRequest: async () => { throw new Error('unexpected UI request') }, engineRuntime: runtime, memory, projectId: 'smoke-project', chatId: 'smoke-main' })
  assert(main.parentLaunch!.memorySpecs.length > 0, 'memory schemas must be exercised')
  await main.sendPrompt('Say OK.')
  let token: string | null = null
  const iterator = main.stream[Symbol.asyncIterator]()
  while (true) {
    const { value, done } = await iterator.next()
    if (done) throw new Error('main ended before result')
    if (value.type === 'session_token') token = value.sessionToken ?? null
    if (value.type === 'transcript' && value.entry?.kind === 'result') break
  }
  assert(token)
  const firstMain = requests.at(-1)
  branchMode = true
  branch = createMemoryBranch({ provider: 'claude', model: runtime.model, localPath: cwd, parentSessionToken: token,
    runtime, parentLaunch: main.parentLaunch, timeoutMs: 30000 })
  await branch.ask('Analyze memory.', { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
  const branchRequest = requests[requests.indexOf(firstMain) + 1]
  branchMode = false
  await main.sendPrompt('Continue.')
  while (true) {
    const { value, done } = await iterator.next()
    if (done) throw new Error('main continuation ended')
    if (value.type === 'transcript' && value.entry?.kind === 'result') break
  }
  const mainRequest = requests.at(-1)
  writeFileSync(join(root, 'claude-requests.json'), JSON.stringify(requests, null, 2))
  assert(!existsSync(join(cwd, 'MUST_NOT_EXIST')), 'Write bypassed branch guard')
  assert(!existsSync(join(cwd, 'BASH_MUST_NOT_EXIST')), 'Bash bypassed branch guard')
  for (const body of requests.slice(requests.indexOf(branchRequest) + 1, -1)) {
    const results = body.messages.at(-1).content.filter((item: any) => item.type === 'tool_result')
    assert(results.some((item: any) => item.is_error && item.content.includes('Memory-analysis branches may only inspect files')), 'tool probe must be denied')
  }
  equal(branchRequest.model, mainRequest.model, '$.model')
  equal(branchRequest.thinking, mainRequest.thinking, '$.thinking')
  equal(branchRequest.output_config, mainRequest.output_config, '$.output_config')
  equal(branchRequest.tools, mainRequest.tools, '$.tools')
  equal(branchRequest.system, mainRequest.system, '$.system')
  equal(branchRequest.messages.slice(0, -1), mainRequest.messages.slice(0, -1), '$.messages')
  console.log('Claude PASS: tools (including memory MCP), system, history, model/effort; Write/Bash/memory/web denied despite allow rules + disableAllHooks')
} catch (error) {
  console.error(`Claude FAIL: ${(error as Error).message}`); process.exitCode = 1
} finally {
  writeFileSync(join(root, 'claude-requests.json'), JSON.stringify(requests, null, 2))
  branch?.dispose(); main?.close(); memory.close(); server.stop(true)
}

const { CodexAppServerManager } = await import('../src/server/codex-app-server')
const codexRequests: any[] = []
let codexBranchMode = false
let codexBranchCalls = 0
const codexServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (req.method !== 'POST') return Response.json({ data: [] })
  const body: any = await req.json()
  codexRequests.push(body)
  const call = codexBranchMode && codexBranchCalls++ < 2
  const item = call && codexBranchCalls === 2 ? { type: 'function_call', id: 'fc_memory', call_id: 'probe_memory', name: 'propose_memory', arguments: '{}' } : call ? { type: 'function_call', id: 'fc_probe', call_id: 'probe', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${join(cwd, 'CODEX_MUST_NOT_EXIST')}`, max_output_tokens: 100 }) }
    : { type: 'message', id: `msg_${codexRequests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }
  const response = { id: `resp_${codexRequests.length}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  return new Response([
    sse('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
    sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }),
    sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
    sse('response.completed', { type: 'response.completed', response }),
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
} })
const codexDir = join(root, 'codex')
mkdirSync(codexDir)
writeFileSync(join(codexDir, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "offline"\ncheck_for_update_on_startup = false\n${codexNoWeb ? 'web_search = "disabled"\n' : ''}[model_providers.offline]\nname = "Offline"\nbase_url = "http://127.0.0.1:${codexServer.port}/v1"\nwire_api = "responses"\nenv_key = "OFFLINE_KEY"\n`)
const codexRuntime: EngineRuntime = { engine: 'codex', model: 'gpt-5.4', env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CODEX_HOME: codexDir, OFFLINE_KEY: 'fake-key' }, args: ['app-server'], isolated: true,
  executable: { state: 'ready', path: Bun.which('codex')! } }
const manager = new CodexAppServerManager()
let codexBranch: ReturnType<typeof createMemoryBranch> | undefined
try {
  const sessionOptions = { chatId: 'prefix-main', cwd, model: codexRuntime.model, runtime: codexRuntime, sessionToken: null, dynamicTools: [{ type: 'function' as const, name: 'propose_memory', description: 'Record memory', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
  const token = await manager.startSession(sessionOptions)
  assert(token)
  const turnOptions = { chatId: 'prefix-main', model: codexRuntime.model, effort: 'low' as const, planMode: false, developerInstructions: 'Preserve the project conventions.', onToolRequest: async () => ({}) }
  const turn = await manager.startTurn({ ...turnOptions, content: 'Say OK.' })
  for await (const event of turn.stream) if (event.type === 'transcript' && event.entry?.kind === 'result') assert(!event.entry.isError, event.entry.result)
  const firstMain = codexRequests.at(-1)
  codexBranchMode = true
  codexBranch = createMemoryBranch({ provider: 'codex', model: codexRuntime.model, localPath: cwd, parentSessionToken: token,
    runtime: codexRuntime, parentLaunch: { provider: 'codex', session: sessionOptions, turn: turnOptions }, timeoutMs: 30000 })
  await codexBranch.ask('Analyze memory.')
  const branchRequest = codexRequests[codexRequests.indexOf(firstMain) + 1]
  codexBranchMode = false
  const next = await manager.startTurn({ ...turnOptions, content: 'Continue.' })
  for await (const event of next.stream) if (event.type === 'transcript' && event.entry?.kind === 'result') assert(!event.entry.isError, event.entry.result)
  const mainRequest = codexRequests.at(-1)
  writeFileSync(join(root, 'codex-requests.json'), JSON.stringify(codexRequests, null, 2))
  assert(!existsSync(join(cwd, 'CODEX_MUST_NOT_EXIST')), 'Codex write bypassed sandbox')
  const guardResult = codexRequests[codexRequests.indexOf(branchRequest) + 1].input.at(-1).output
  assert(codexRequests[codexRequests.indexOf(branchRequest) + 2].input.at(-1).output.includes('blocked by PreToolUse hook'), 'memory probe must be denied')
  assert(guardResult.includes('blocked by PreToolUse hook'), 'Codex hook must deny before executing the command')
  const toolDifference = firstDifference(branchRequest.tools, mainRequest.tools, '$.tools')
  console.log(toolDifference
    ? `Codex PREFIX FAIL: ${toolDifference}`
    : `Codex PREFIX PASS${codexNoWeb ? ' (parent web disabled)' : ''}: tools/instructions/history content retained; SAFETY PASS: native hook denies command + memory calls`)
  equal(branchRequest.instructions, mainRequest.instructions, '$.instructions')
  const withoutIds = (items: any[]) => items.map(({ id, ...item }) => item)
  equal(withoutIds(branchRequest.input.slice(0, mainRequest.input.length - 1)), withoutIds(mainRequest.input.slice(0, -1)), '$.input')
  equal(branchRequest.model, mainRequest.model, '$.model')
  equal(branchRequest.reasoning, mainRequest.reasoning, '$.reasoning')
  console.log('Codex HISTORY PASS: sandbox/environment changes append after history; generated message IDs excluded from content comparison')
  if (toolDifference) process.exitCode = 1
} catch (error) {
  console.error(`Codex FAIL: ${(error as Error).message}`); process.exitCode = 1
} finally {
  writeFileSync(join(root, 'codex-requests.json'), JSON.stringify(codexRequests, null, 2))
  codexBranch?.dispose(); manager.stopAll(); codexServer.stop(true)
}

const { PiAgentManager } = await import('../src/server/pi-agent')
const piRequests: any[] = []
let piBranchMode = false
let piCalls = 0
const piServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (req.method !== 'POST') return Response.json({ data: [] })
  const body: any = await req.json()
  piRequests.push(body)
  const probes = [
    { name: 'write', arguments: JSON.stringify({ path: join(cwd, 'PI_MUST_NOT_EXIST'), content: 'unsafe' }) },
    { name: 'bash', arguments: JSON.stringify({ command: `touch ${join(cwd, 'PI_BASH_MUST_NOT_EXIST')}` }) },
    { name: 'propose_memory', arguments: '{}' },
  ]
  const probe = piBranchMode ? probes[piCalls++] : undefined
  const chunks = probe
    ? [{ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `pi_probe_${piCalls}`, type: 'function', function: probe }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
    : [{ choices: [{ index: 0, delta: { role: 'assistant', content: '{"ok":true}' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: `pi_${piRequests.length}`, object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
} })
const piManager = new PiAgentManager({ dataDir: join(root, 'pi'), loadModels: async () => [] })
const connection = { provider: 'custom' as const, baseUrl: `http://127.0.0.1:${piServer.port}/v1`, apiKey: 'offline-fake-key' }
const memorySpecs = [{ name: 'propose_memory', description: 'Record memory', schema: {}, handler: () => { throw new Error('memory handler must never execute') } }]
let piRecorded: import('../src/server/memory/parent-launch').PiParentLaunch | undefined
const piOptions = { onLaunch: (launch: import('../src/server/memory/parent-launch').PiParentLaunch) => { piRecorded = launch }, model: 'offline-model', effort: 'default' as const, connection, memorySpecs }
let piBranch: ReturnType<typeof createMemoryBranch> | undefined
try {
  const mainTurn = await piManager.startTurn({ ...piOptions, cwd, chatId: 'pi-main', content: 'Say OK.', sessionToken: null, forkSession: false })
  let token: string | null = null
  for await (const event of mainTurn.stream) {
    if (event.type === 'session_token') token = event.sessionToken ?? null
    if (event.type === 'transcript' && event.entry?.kind === 'result') assert(!event.entry.isError, event.entry.result)
  }
  assert(token)
  const firstMain = piRequests.at(-1)
  // A fork reloads project resources; its system prompt must still match the
  // running parent's frozen prompt even when a file changed between turns.
  writeFileSync(join(cwd, 'AGENTS.md'), 'New project instructions after the parent launch.\n')
  piBranchMode = true
  piBranch = createMemoryBranch({ provider: 'pi', model: piOptions.model, localPath: cwd, parentSessionToken: token,
    parentLaunch: piRecorded, timeoutMs: 30000 }, { piManager, resolvePiConnection: async () => connection })
  await piBranch.ask('Analyze memory.')
  const branchRequest = piRequests[piRequests.indexOf(firstMain) + 1]
  piBranchMode = false
  const next = await piManager.startTurn({ ...piOptions, cwd, chatId: 'pi-main', content: 'Continue.', sessionToken: token, forkSession: false })
  for await (const event of next.stream) if (event.type === 'transcript' && event.entry?.kind === 'result') assert(!event.entry.isError, event.entry.result)
  const mainRequest = piRequests.at(-1)
  writeFileSync(join(root, 'pi-requests.json'), JSON.stringify(piRequests, null, 2))
  assert(!existsSync(join(cwd, 'PI_MUST_NOT_EXIST')))
  assert(!existsSync(join(cwd, 'PI_BASH_MUST_NOT_EXIST')))
  equal(branchRequest.tools, mainRequest.tools, '$.tools')
  equal(branchRequest.messages.slice(0, -1), mainRequest.messages.slice(0, -1), '$.messages')
  equal(branchRequest.model, mainRequest.model, '$.model')
  equal(branchRequest.reasoning_effort, mainRequest.reasoning_effort, '$.reasoning_effort')
  for (const body of piRequests.slice(piRequests.indexOf(branchRequest) + 1, -1)) assert(body.messages.at(-1).content.includes('Memory branches may only inspect files.'))
  console.log('Pi PASS: real SDK requests have identical tools/system/history/model/effort; write/bash/memory denied')
} catch (error) {
  console.error(`Pi FAIL: ${(error as Error).message}`); process.exitCode = 1
} finally {
  writeFileSync(join(root, 'pi-requests.json'), JSON.stringify(piRequests, null, 2))
  piBranch?.dispose(); piManager.dispose(); piServer.stop(true)
}
console.log(`Evidence: ${root}`)
