import { expect, test } from 'bun:test'
import { readOpencodeEvents } from './opencode-events'

test('native SSE preserves split UTF-8/CRLF and cancellation settles without a discarded rejection', async () => {
  const controller = new AbortController()
  const frames = new TextEncoder().encode(': ping\r\n\r\ndata: {"type":"server.connected"}\r\n\r\ndata: {"type":"synthetic","text":"中文"}\r\n\r\n')
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    expect(request.headers.get('authorization')).toBe('synthetic')
    expect(new URL(request.url).searchParams.get('directory')).toBe('/synthetic 中文')
    let offset = 0
    return new Response(new ReadableStream({ pull(stream) { if (offset < frames.length) stream.enqueue(frames.slice(offset, ++offset)) } }),
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const events = readOpencodeEvents(`http://127.0.0.1:${server.port}`, '/synthetic 中文', 'synthetic', controller.signal)
  try {
    expect((await events.next()).value).toEqual({ type: 'server.connected' })
    expect((await events.next()).value).toEqual({ type: 'synthetic', text: '中文' })
    const pending = events.next().catch(error => error)
    controller.abort()
    expect((await pending).name).toBe('AbortError')
  } finally { await events.return(undefined); server.stop(true) }
})
