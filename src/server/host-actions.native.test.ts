import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startClaudeSession } from './agent'
import { OpencodeAgentManager } from './opencode-agent'
import { buildOpencodeProviderConfig, type EngineRuntime } from './model-access/runtime'
import { HostActionService, dispatchHostAction, hostActionToolSpecs } from './host-actions'
import { HarnessPolicyService, defaultExecutionPolicy } from './harness-policy'
import { HOST_ACTION_CAPABILITY, HOST_ACTION_TOOL_NAMES, type HostActionServerEvent, type HostNativeToolContext } from '../shared/host-actions'

// Explicit binaries only. Real native loops + scripted loopback responses prove
// protocol behavior, not external inference quality or provider cache performance.
for (const engine of ['claude', 'opencode'] as const) {
  const binary = process.env[engine === 'claude' ? 'MEMOSYNC_CLAUDE_TEST_BIN' : 'MEMOSYNC_OPENCODE_TEST_BIN']
  ;(binary ? test : test.skip)(`${engine} native tool IDs reach durable host receipts with memory disabled`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'memosync-native-host-')))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'README.md'), '# Synthetic native host snapshot\n')
    const events: HostActionServerEvent[] = []
    const observations: HostNativeToolContext[] = [], receipts: any[] = []
    const version = (await Bun.$`${binary!} --version`.quiet().text()).match(/\d+\.\d+\.\d+/)![0]
    const policies = new HarnessPolicyService()
    const policyScope = policies.beginTurn('synthetic-chat', defaultExecutionPolicy(engine), 1, 'synthetic-turn', version)
    const service = new HostActionService({ dataDir: join(root, 'data'), policy: policies })
    const connection = {}
    const client = service.bind(connection, [HOST_ACTION_CAPABILITY], event => { events.push(event); return true }, () => true)
    const lease = service.captureAdmission({ chatId: 'synthetic-chat', admittedTurnId: 'synthetic-turn', workspaceRef: 'project', workspaceRoot: workspace, targetClientId: client.clientId, policyScope })!
    const dispatch = async (name: string, input: Record<string, unknown>, native: HostNativeToolContext, signal?: AbortSignal) => {
      observations.push(native)
      const result = await dispatchHostAction(service, lease, name, input, native, signal)
      receipts.push(JSON.parse(result.text))
      return result
    }
    let providerCalls = 0
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
      const body = await request.json() as any
      if (++providerCalls > 12) return new Response('Scripted request limit', { status: 500 })
      const name = body.tools?.find((t: any) => t.name.endsWith(HOST_ACTION_TOOL_NAMES.openFile))?.name
      const statusName = body.tools?.find((t: any) => t.name.endsWith(HOST_ACTION_TOOL_NAMES.actionStatus))?.name
      const completed = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'tool_result'))
      const blocks = name && !completed
        ? ['native_first', 'native_second'].map(id => ({ type: 'tool_use', id, name, input: { path: 'README.md' } }))
        : statusName && receipts.length === 2
        ? [{ type: 'tool_use', id: 'native_status', name: statusName, input: { operationId: receipts[0].operationId } }]
        : [{ type: 'text', text: 'Synthetic host action complete.' }]
      const message = { id: `msg_synthetic_${providerCalls}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
      return new Response(event('message_start', { message }) + blocks.map((block: any, index) =>
        event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block })
        + (block.type === 'tool_use' ? event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }) : '')
        + event('content_block_stop', { index })).join('')
        + event('message_delta', { delta: { stop_reason: blocks[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
        + event('message_stop', {}), { headers: { 'content-type': 'text/event-stream' } })
    } })
    const baseURL = `http://127.0.0.1:${provider.port}`
    const env = { HOME: root, PATH: process.env.PATH, TMPDIR: root,
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'native-data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'), ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'synthetic-loopback-only', ANTHROPIC_AUTH_TOKEN: 'synthetic-loopback-only',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', MEMOSYNC_MODEL_API_KEY: 'synthetic-loopback-only',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1' }
    const runtime: EngineRuntime = { engine, model: 'claude-sonnet-4-6', env, args: [], isolated: true, executable: { state: 'ready', path: binary, version } }
    let close: () => unknown = () => {}
    try {
      if (engine === 'claude') {
        const session = await startClaudeSession({ localPath: workspace, model: runtime.model, planMode: false, sessionToken: null, forkSession: false,
          engineRuntime: runtime, hostActionsEnabled: true, memory: null, onToolRequest: async () => ({}),
          executionControl: { permissionMode: 'default', isCurrent: () => true, canUseMemory: () => false, approve: async () => true,
            onToolRequest: async () => ({}), onApplied: async () => {}, hostDispatch: dispatch } })
        close = () => session.close()
        const drain = (async () => { for await (const e of session.stream) if (e.entry?.kind === 'result') break })()
        await session.sendPrompt('Show README.md twice.', { promptId: crypto.randomUUID(), promptSeq: 1 })
        await drain
      } else {
        runtime.connectionId = 'synthetic-local'
        runtime.opencodeConfig = buildOpencodeProviderConfig({ protocol: 'anthropic-messages', baseUrl: baseURL }, { id: runtime.model })
        const manager = new OpencodeAgentManager()
        close = () => manager.dispose()
        const turn = await manager.startTurn({ chatId: 'synthetic-chat', cwd: workspace, content: 'Show README.md twice.', model: runtime.model, runtime,
          executionPolicy: { engine: 'opencode', permission: 'allow' }, memorySpecs: hostActionToolSpecs(),
          memoryDispatch: async (name, input, signal, native) => native ? dispatch(name, input, native, signal) : { text: 'Missing native context', isError: true } })
        for await (const _event of turn.stream) { /* Drive the real native loop. */ }
      }
      expect(observations.map(n => n.nativeToolCallId).sort()).toEqual(['native_first', 'native_second', 'native_status'])
      expect(new Set(observations.map(n => n.nativeTurnId)).size).toBe(1)
      expect(observations.every(n => n.engineInstanceId && n.nativeSessionId && n.nativeTurnId && Object.isFrozen(n))).toBe(true)
      expect(receipts.map(r => r.status)).toEqual(['accepted', 'accepted', 'accepted'])
      expect(new Set(receipts.map(r => r.operationId)).size).toBe(2)
      expect(events.filter(e => e.type === 'host.action.requested')).toHaveLength(2)
      const first = receipts[0]
      const snapshot = service.readSnapshot(connection, first.operationId)
      expect(snapshot.content).toBe('# Synthetic native host snapshot\n')
      expect(service.statusForTool(lease, first.operationId).status).toBe('accepted')
      service.presented(connection, { operationId: first.operationId, viewInstanceId: 'synthetic-rendered-tab', fileVersion: snapshot.version, digest: snapshot.digest })
      expect(service.statusForTool(lease, first.operationId).status).toBe('presented')
    } finally { await close(); provider.stop(true); await service.close(); await rm(root, { recursive: true, force: true }) }
  }, 45_000)
}
