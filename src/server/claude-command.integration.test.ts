import { expect, test } from 'bun:test'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCommandRuntime } from './native-command-drivers'

// Opt-in only. Both native history and all provider traffic stay in this temporary profile.
const binary = process.env.MEMOSYNC_CLAUDE_TEST_BIN
const nativeTest = binary ? test : test.skip
nativeTest('installed Claude compact and noReply restoration settle through correlated native results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memosync-claude-commands-'))
  const requests: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as any
    if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 100 })
    requests.push(body)
    const message = { id: `msg_local_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Synthetic local reply.' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 8 } }
    if (!body.stream) return Response.json(message)
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic local reply.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  // The SDK overlays process.env; explicitly remove every ambient key before setting synthetic values.
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(k => [k, undefined]))
  Object.assign(env, { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'profile'), TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    ANTHROPIC_API_KEY: 'synthetic-loopback-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const version = new TextDecoder().decode(Bun.spawnSync([binary!, '--version'], { env }).stdout).match(/\d+\.\d+\.\d+/)?.[0] ?? 'unreported'
  const inputs: SDKUserMessage[] = []
  let wake: (() => void) | undefined, stopped = false
  const prompt = { async *[Symbol.asyncIterator]() {
    while (!stopped) {
      if (!inputs.length) await new Promise<void>(resolve => { wake = resolve })
      while (inputs.length) yield inputs.shift()!
    }
  } }
  const push = (content: string, uuid: string, shouldQuery: boolean) => {
    inputs.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid: uuid as SDKUserMessage['uuid'], shouldQuery })
    wake?.()
  }
  const q = query({ prompt, options: { cwd: root, env, pathToClaudeCodeExecutable: binary, settingSources: [],
    settings: { autoMemoryEnabled: false, autoDreamEnabled: false }, tools: [], model: 'claude-sonnet-4-6', extraArgs: { 'replay-user-messages': null } } })
  const control = createClaudeCommandRuntime({ query: q, session: () => '', version, acknowledgesInputs: true, push, close: () => q.close() })
  let warm!: () => void
  const ready = new Promise<void>(resolve => { warm = resolve })
  const ordinaryResults: unknown[] = []
  const pump = (async () => {
    for await (const message of q) {
      if (control.observe(message)) continue
      if (message.type === 'result') { ordinaryResults.push(message); warm() }
    }
  })()
  // Install a rejection handler before native teardown can end the iterator.
  void pump.catch(() => {})
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(); q.close() }, 20_000)
  try {
    push('Synthetic warmup.', crypto.randomUUID(), true)
    await ready
    const catalog = await control.runtime.discover()
    expect(catalog.commands.items.some(c => c.name === 'compact')).toBe(true)
    expect(catalog.skills.status).toBe('unsupported')
    await control.runtime.compact!(controller.signal)
    const callsAfterCompact = requests.length
    expect(callsAfterCompact).toBeGreaterThan(1)
    expect(await control.runtime.restore!('CURRENT_CAPABILITY_AND_MEMORY_CONTEXT', controller.signal)).toEqual({ delivery: 'native-accepted' })
    expect(requests.length).toBe(callsAfterCompact)
    expect(ordinaryResults).toHaveLength(1)
  } finally {
    clearTimeout(timer)
    stopped = true; wake?.(); control.dispose(); q.close()
    await pump.catch(() => {})
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
