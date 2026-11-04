#!/usr/bin/env bun
// Transport fixture: deterministic SSE/HTTP failure cases unavailable from a real model.
import { appendFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log('1.19.5'); process.exit(0) }
if (process.env.FAKE_OC_CONFIG === 'invalid') {
  console.error(`private key FAKE-SECRET\n\x1b[31mConfiguration is invalid at ${process.env.HOME}/bad.json\x1b[0m\n↳ Unrecognized key: "invalid"\nprivate footer FAKE-SECRET`)
  process.exit(1)
}
const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
const send = (type: string, properties: unknown) => {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`)
  for (const controller of controllers) controller.enqueue(bytes)
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`) return new Response(null, { status: 401 })
    const url = new URL(request.url)
    if (process.env.FAKE_OC_COMMAND_LOG && request.method === 'POST') appendFileSync(process.env.FAKE_OC_COMMAND_LOG, `${JSON.stringify({ path: url.pathname, body: await request.clone().json() })}\n`)
    if (request.method === 'GET' && url.pathname === '/command') return Response.json([{ name: 'fixture', description: 'Native fixture command', source: 'command', template: 'Fixture', hints: [] }])
    if (request.method === 'GET' && url.pathname === '/skill') return Response.json([{ name: 'fixture', description: 'Native fixture skill', location: '/temp/fixture/SKILL.md', content: 'Fixture instructions' }])
    if (request.method === 'GET' && url.pathname === '/mcp') return Response.json({ fixture: { status: 'disabled' } })
    if (request.method === 'POST' && url.pathname.endsWith('/command')) {
      const body = await request.json() as { command: string; arguments: string }
      setTimeout(() => {
        send('message.updated', { info: { id: 'command-assistant', sessionID: 'ses_fixture', role: 'assistant', time: { created: 1 } } })
        send('message.part.updated', { part: { id: 'command-text', sessionID: 'ses_fixture', messageID: 'command-assistant', type: 'text', text: `native-command:${body.command}:${body.arguments}`, time: { start: 1, end: 2 } } })
        send('session.idle', { sessionID: 'ses_fixture' })
      }, 10)
      return Response.json({ info: { id: 'command-assistant' }, parts: [] })
    }
    if (request.method === 'POST' && url.pathname.endsWith('/summarize')) return Response.json(true)
    if (request.method === 'POST' && url.pathname.endsWith('/message')) return Response.json({ info: { id: 'restore', role: 'user' }, parts: [] })
    if (url.pathname === '/config/providers') return Response.json({ providers: [{ id: 'connected', name: 'Connected', key: 'FAKE-SECRET', options: { apiKey: 'FAKE-SECRET' }, models: { 'vendor/m': { id: 'vendor/m', name: 'Model', tool_call: true, limit: { context: 10000, output: 1000 }, key: 'FAKE-SECRET' } } }], default: { connected: 'vendor/m' }, key: 'FAKE-SECRET' })
    if (url.pathname === '/config') return Response.json({ model: process.env.FAKE_OC_MODEL || 'connected/vendor/m', key: 'FAKE-SECRET' })
    if (url.pathname === '/event') return new Response(new ReadableStream({ start(controller) { controllers.add(controller); controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n')) }, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/permission/perm_fixture/reply') {
      const body = await request.json() as { reply: string }
      if (body.reply !== 'reject') return new Response(null, { status: 400 })
      setTimeout(() => {
        send('message.part.updated', { part: { id: 'permission-tool', sessionID: 'ses_fixture', messageID: 'assistant', type: 'tool', callID: 'permission-call', tool: 'bash', state: { status: 'error', input: { command: 'forbidden' }, error: 'rejected' } } })
        send('session.idle', { sessionID: 'ses_fixture' })
      }, 20)
      return Response.json(true)
    }
    if (request.method === 'GET' && url.pathname.endsWith('/message')) return Response.json([])
    if (url.pathname === '/session') return Response.json({ id: 'ses_fixture' })
    if (url.pathname.endsWith('/abort')) return Response.json(true)
    if (url.pathname.endsWith('/prompt_async')) {
      const body = await request.json() as { parts: Array<{ text: string }> }
      const mode = body.parts[0]?.text
      setTimeout(() => {
        const sessionID = 'ses_fixture'
        if (mode === 'disconnect') { for (const controller of controllers) controller.close(); controllers.clear(); return }
        if (mode === 'exit') process.exit(42)
        if (mode === 'retry') { send('session.status', { sessionID, status: { type: 'retry', attempt: 4, message: 'Scripted retry exhaustion', next: Date.now() } }); return }
        if (mode === 'permission') {
          send('message.updated', { info: { id: 'assistant', sessionID, role: 'assistant', time: { created: 1 } } })
          send('message.part.updated', { part: { id: 'permission-tool', messageID: 'assistant', sessionID, type: 'tool', callID: 'permission-call', tool: 'bash', state: { status: 'running', input: { command: 'forbidden' } } } })
          send('permission.asked', { sessionID, id: 'perm_fixture', permission: 'bash', patterns: ['forbidden'], always: [], tool: { callID: 'permission-call', messageID: 'assistant' }, metadata: {} })
          return
        }
        if (mode === 'mixed') {
          // Child sessions, user parts, and reasoning deltas must never leak into text.
          send('message.updated', { info: { id: 'user', sessionID, role: 'user', time: { created: 1 } } })
          send('message.part.updated', { part: { id: 'user-part', messageID: 'user', sessionID, type: 'text', text: 'user text' } })
          send('message.part.delta', { sessionID, messageID: 'user', partID: 'user-part', field: 'text', delta: 'USER-LEAK' })
          send('message.updated', { info: { id: 'assistant', sessionID, role: 'assistant', time: { created: 1 } } })
          send('message.part.updated', { part: { id: 'reason', messageID: 'assistant', sessionID, type: 'reasoning', text: 'Reasoning preserved', time: { start: 1, end: 2 } } })
          send('message.part.delta', { sessionID, messageID: 'assistant', partID: 'reason', field: 'text', delta: 'REASONING-LEAK' })
          send('message.part.updated', { part: { id: 'child', messageID: 'assistant', sessionID: 'ses_child', type: 'text', text: 'CHILD-LEAK' } })
          send('message.part.delta', { sessionID, messageID: 'assistant', partID: 'text', field: 'text', delta: 'visible' })
          send('message.part.updated', { part: { id: 'text', messageID: 'assistant', sessionID, type: 'text', text: 'visible', time: { start: 1, end: 2 } } })
          // Terminal-only tool events must still produce one matching call/result.
          send('message.part.updated', { part: { id: 'tool-part', messageID: 'assistant', sessionID, type: 'tool', callID: 'terminal-call', tool: 'read', state: { status: 'completed', input: { filePath: '/fixture' }, output: 'fixture result' } } })
          send('message.part.updated', { part: { id: 'tool-part', messageID: 'assistant', sessionID, type: 'tool', callID: 'terminal-call', tool: 'read', state: { status: 'completed', input: { filePath: '/fixture' }, output: 'fixture result' } } })
        }
        send('session.idle', { sessionID })
      }, 20)
      return new Response(null, { status: 204 })
    }
    return Response.json(true)
  },
})
console.log(`opencode server listening on http://127.0.0.1:${server.port}`)
