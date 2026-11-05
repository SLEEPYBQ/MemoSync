import { describe, expect, test } from 'bun:test'
import { CODEX_INIT_PROMPT, createClaudeCommandRuntime, createOpencodeCommandRuntime, createPiCommandRuntime, discoverCodexCommands, parseCodexReviewTarget } from './native-command-drivers'

const signal = () => new AbortController().signal
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('public native command protocol fixtures', () => {
  test('Claude replaces an empty discovery and waits for boundary plus the matching prompt result', async () => {
    let commands = [{ name: 'compact', description: 'Compact', argumentHint: '' }]
    const inputs: Array<{ text: string; uuid: string; shouldQuery: boolean }> = []
    const control = createClaudeCommandRuntime({ query: { supportedCommands: async () => commands, mcpServerStatus: async () => [{ name: 'fixture', status: 'needs-auth', config: { type: 'http', url: 'https://unused.invalid', headers: { Authorization: 'must-not-leak' } } }], interrupt: async () => {} },
      session: () => 'native', version: '2.1.241', acknowledgesInputs: true, push: (text, uuid, shouldQuery) => { inputs.push({ text, uuid, shouldQuery }) }, close() {} })
    const found = await control.runtime.discover()
    expect(found.connectors.items[0]).toMatchObject({ kind: 'mcp', state: 'needs-auth' })
    expect(JSON.stringify(found)).not.toContain('must-not-leak')
    let completed = false
    const done = control.runtime.compact!(signal()).then(() => { completed = true })
    expect(inputs[0]!.text).toBe('/compact')
    control.observe({ type: 'result', user_message_uuids: ['previous-turn'], is_error: false })
    await flush()
    expect(completed).toBe(false)
    control.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } })
    await flush()
    expect(completed).toBe(false)
    control.observe({ type: 'result', user_message_uuids: [inputs[0]!.uuid], is_error: false })
    await done
    let restoreAccepted = false
    const restored = control.runtime.restore!('view-7', signal()).then(receipt => { restoreAccepted = true; return receipt })
    expect(inputs[1]!.text).toContain('view-7')
    expect(inputs[1]!.shouldQuery).toBe(false)
    control.observe({ type: 'user', uuid: inputs[1]!.uuid, shouldQuery: false })
    await flush()
    expect(restoreAccepted).toBe(false)
    control.observe({ type: 'result', user_message_uuid: inputs[1]!.uuid, is_error: false })
    expect(await restored).toEqual({ delivery: 'native-accepted' })
    commands = []
    expect((await control.runtime.discover()).commands).toMatchObject({ status: 'ready', items: [] })
    expect(control.runtime.compact).toBeUndefined()
    control.dispose()
  })
  test('Claude refreshes native skills without claiming their instructions were loaded', async () => {
    let skills = [{ name: 'old-skill', description: 'Old skill', argumentHint: '' }]
    let reloads = 0
    const control = createClaudeCommandRuntime({ query: {
      supportedCommands: async () => [{ name: 'compact', description: 'Compact', argumentHint: '' }, { name: 'old-skill', description: 'Old skill', argumentHint: '' }],
      reloadSkills: async () => { reloads++; return { skills } }, mcpServerStatus: async () => [], interrupt: async () => {},
    }, session: () => 'native', version: '2.1.318', acknowledgesInputs: true, push() {}, close() {} })
    try {
      const initial = await control.runtime.discover()
      expect(initial.skills.items).toMatchObject([{ name: 'old-skill', discovered: true, loaded: null }])
      skills = [{ name: 'new-skill', description: 'New skill', argumentHint: '' }]
      const refreshed = await control.runtime.discover()
      expect(reloads).toBe(2)
      expect(refreshed.commands.items.map(c => c.name)).toEqual(['compact', 'new-skill'])
      expect(refreshed.skills.items).toMatchObject([{ name: 'new-skill', loaded: null }])
      skills = []
      expect((await control.runtime.discover()).commands.items.map(c => c.name)).toEqual(['compact'])
    } finally { control.dispose() }
  })
  test('Claude fails without compact_boundary and native change events invalidate even empty catalogs', async () => {
    let uuid = '', changes = 0
    const control = createClaudeCommandRuntime({ query: { supportedCommands: async () => [{ name: 'compact', description: '', argumentHint: '' }], mcpServerStatus: async () => [], interrupt: async () => {} },
      session: () => 'native', version: '2.1.241', acknowledgesInputs: true, push: (_text, id) => { uuid = id }, close() {} })
    await control.runtime.discover()
    control.runtime.onChanged!(() => { changes++ })
    control.observe({ type: 'system', subtype: 'commands_changed', commands: [] })
    expect(changes).toBe(1)
    const done = control.runtime.compact!(signal())
    control.observe({ type: 'result', user_message_uuid: uuid, is_error: false })
    await expect(done).rejects.toThrow('completion')
    control.dispose()
  })
  test('Pi uses the current resource loader, leaves loaded unknown, restores without triggering a model turn', async () => {
    const calls: unknown[] = []
    const session = { sessionId: 'pi-native', isStreaming: false, promptTemplates: [{ name: 'review', description: 'Review' }],
      resourceLoader: { getSkills: () => ({ skills: [{ name: 'fixture', description: 'Fixture', disableModelInvocation: true }] }) },
      compact: async () => { calls.push('compact') }, sendCustomMessage: async (...args: unknown[]) => { calls.push(args) }, abortCompaction() { calls.push('abortCompact') }, abort: async () => { calls.push('abort') } }
    const runtime = createPiCommandRuntime(session as never, '/temp/isolated-pi', () => true)
    const found = await runtime.discover()
    expect(found.commands.items.map(c => c.name)).toEqual(['review', 'skill:fixture'])
    expect(found.skills.items[0]).toMatchObject({ discovered: true, loaded: null, enabled: true })
    expect(found.connectors.status).toBe('unsupported')
    await runtime.compact!(signal())
    await runtime.restore!('view-8', signal())
    expect(calls[0]).toBe('compact')
    expect(calls[1]).toMatchObject([{ customType: 'memosync-context', display: false }, { triggerTurn: false }])
    await runtime.cancel!()
    expect(calls.slice(-2)).toEqual(['abortCompact', 'abort'])
  })
  test('OpenCode routes discovery, summarize, noReply append, and abort to public session APIs', async () => {
    const calls: unknown[] = []
    const client = { command: { list: async () => ({ data: [{ name: 'review', description: 'Review', source: 'command' }] }) },
      app: { skills: async () => ({ data: [{ name: 'fixture', description: 'Fixture', content: 'Fixture instructions' }] }) },
      mcp: { status: async () => ({ data: { fixture: { status: 'connected', authorization: 'must-not-leak' } } }) },
      session: { summarize: async (args: unknown) => { calls.push(['summarize', args]); return { data: true } },
        prompt: async (args: unknown) => { calls.push(['prompt', args]); return { data: {} } }, abort: async (args: unknown) => { calls.push(['abort', args]); return { data: true } } } }
    const runtime = createOpencodeCommandRuntime({ client: client as never, session: () => 'oc-native', version: '1.19.5', alive: () => true, model: () => ({ providerID: 'fake', modelID: 'fixture' }) })
    const found = await runtime.discover()
    expect(found.commands.items[0]!.route).toBe('session-command')
    expect(found.skills.items[0]!.loaded).toBeNull()
    expect(JSON.stringify(found)).not.toContain('must-not-leak')
    await runtime.compact!(signal())
    await runtime.restore!('view-9', signal())
    await runtime.cancel!()
    expect(calls[0]).toEqual(['summarize', { sessionID: 'oc-native', providerID: 'fake', modelID: 'fixture', auto: false }])
    expect(calls[1]).toMatchObject(['prompt', { sessionID: 'oc-native', noReply: true, parts: [{ type: 'text' }] }])
    expect(calls[2]).toEqual(['abort', { sessionID: 'oc-native' }])
  })
  test('Codex discovers exact workspace skills and MCP facts without inventing executable TUI commands', async () => {
    const calls: unknown[] = []
    const found = await discoverCodexCommands(async (method, params) => {
      calls.push([method, params])
      return method === 'skills/list' ? { data: [{ cwd: '/temp/project', skills: [{ name: 'fixture', path: '/temp/profile/fixture/SKILL.md', enabled: false }] }] }
        : { data: [{ name: 'fixture', authStatus: 'notLoggedIn', tools: {}, secret: 'must-not-leak' }] }
    }, '/temp/project', '0.166.0-alpha.5.1')
    expect(calls).toEqual([['skills/list', { cwds: ['/temp/project'], forceReload: true }], ['mcpServerStatus/list', {}]])
    expect(found.commands.items).toMatchObject([{ name: 'review', route: 'review-start', source: { api: 'review/start (inline) + turn events' } },
      { id: 'host:init', name: 'init', route: 'host-prompt', namespace: 'host', owner: 'memosync' }])
    expect(found.skills.items[0]).toMatchObject({ discovered: true, loaded: null, enabled: false })
    expect(found.connectors.items[0]!.state).toBe('needs-auth')
    expect(JSON.stringify(found)).not.toContain('must-not-leak')
    const old = await discoverCodexCommands(async () => { throw new Error('Method not found') }, '/temp/project', 'old')
    expect(old.skills.status).toBe('unsupported')
    expect(old.connectors.status).toBe('unsupported')
    expect(old.commands.status).toBe('ready')
    expect(old.commands.items.map(c => c.name)).toEqual(['review', 'init'])
  })

  test('Codex review targets use structured public API fields and init preserves existing guidelines', () => {
    expect(parseCodexReviewTarget('')).toEqual({ type: 'uncommittedChanges' })
    expect(parseCodexReviewTarget('uncommitted')).toEqual({ type: 'uncommittedChanges' })
    expect(parseCodexReviewTarget('base main')).toEqual({ type: 'baseBranch', branch: 'main' })
    expect(parseCodexReviewTarget('commit abc123')).toEqual({ type: 'commit', sha: 'abc123', title: null })
    expect(parseCodexReviewTarget('commit abc123 Fix bug')).toEqual({ type: 'commit', sha: 'abc123', title: 'Fix bug' })
    expect(parseCodexReviewTarget('custom Check concurrency')).toEqual({ type: 'custom', instructions: 'Check concurrency' })
    expect(parseCodexReviewTarget('Check concurrency')).toEqual({ type: 'custom', instructions: 'Check concurrency' })
    for (const args of ['base', 'base main extra', 'commit', 'custom']) expect(() => parseCodexReviewTarget(args)).toThrow()
    expect(CODEX_INIT_PROMPT).toContain('If it does, do not overwrite or modify it.')
  })
})
