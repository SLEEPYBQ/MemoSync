#!/usr/bin/env bun
export {}
// Local-only, externally gated transport for question ordering and orphan cleanup.
const notify = async (event: Record<string, unknown>) => {
  const response = await fetch(process.env.FAKE_OC_OBSERVER!, { method: 'POST', body: JSON.stringify(event) })
  if (!response.ok) throw new Error('Fixture observer unavailable')
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const history = deferred<string>()
const answers = new Map<string, ReturnType<typeof deferred<void>>>()
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/test/host-bind' || path === '/test/host-call') {
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!)
      const input = await request.json() as { name: string; sessionID: string; callID: string; args: Record<string, unknown> }
      const output = { args: input.args }
      if (path.endsWith('bind')) {
        const plugin = await (await import(config.plugin.at(-1))).default()
        await plugin['tool.execute.before']({ tool: `memosync_${input.name}`, sessionID: input.sessionID, callID: input.callID }, output)
        return Response.json(output.args)
      }
      const response = await fetch(config.mcp.memosync.url, { method: 'POST', headers: config.mcp.memosync.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: input.name, arguments: output.args } }) })
      return Response.json(await response.json())
    }
    if (path === '/test/events') {
      const events = await request.json() as unknown[]
      for (const event of events) {
        const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
        for (const stream of streams) stream.enqueue(bytes)
      }
      return Response.json(true)
    }
    if (path === '/test/history') { history.resolve(await request.json() as string); return Response.json(true) }
    if (path.startsWith('/test/answer/')) { answers.get(path.split('/').at(-1)!)?.resolve(); return Response.json(true) }
    if (path === '/event') {
      if (process.env.FAKE_OC_HOLD_EVENTS === '1') {
        await notify({ kind: 'subscribing' })
        return await new Promise<Response>(() => {})
      }
      let stream: ReadableStreamDefaultController<Uint8Array>
      return new Response(new ReadableStream({
        start(controller) {
          stream = controller; streams.add(controller)
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
        },
        cancel() { streams.delete(stream) },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = ['POST', 'PATCH'].includes(request.method) ? await request.json().catch(() => null) : undefined
    if (/^\/question\/[^/]+\/(reply|reject)$/.test(path)) {
      const gate = deferred<void>()
      answers.set(path.split('/')[2]!, gate)
      await notify({ kind: 'answer', path, body })
      await gate.promise
      return Response.json(true)
    }
    await notify({ kind: 'request', path, method: request.method, body })
    if (request.method === 'PATCH' && path === '/session/ses_created') return Response.json({ id: 'ses_created', permission: process.env.FAKE_OC_REJECT_POLICY ? [] : (body as { permission?: unknown })?.permission })
    if (path === '/session') return Response.json({ id: 'ses_created' })
    if (path.endsWith('/fork')) return Response.json({ id: process.env.FAKE_OC_SAME_PARENT ? 'ses_parent' : 'ses_fork' })
    if (request.method === 'DELETE') {
      const response = await fetch(process.env.FAKE_OC_OBSERVER! + '/deletion')
      if (!response.ok) throw new Error('Fixture deletion gate unavailable')
      return Response.json(true)
    }
    if (path.endsWith('/message')) {
      const outcome = process.env.FAKE_OC_HISTORY === 'hold' ? await history.promise : 'ok'
      return outcome === 'error' ? Response.json({ name: 'FixtureHistoryError' }, { status: 500 }) : Response.json([])
    }
    if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 })
    return Response.json(true)
  },
})
await notify({ kind: 'ready', origin: `http://127.0.0.1:${server.port}` })
console.log(`opencode server listening on http://127.0.0.1:${server.port}`)
