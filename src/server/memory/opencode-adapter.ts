import { randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { MemoryToolResult, MemoryToolSpec } from './tools'

export type OpencodeMemoryDispatch = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<MemoryToolResult>

/** A chat-scoped capability: OpenCode's MCP requests carry no session identity. */
export function createOpencodeMemoryMcp(specs: MemoryToolSpec[], initial?: OpencodeMemoryDispatch) {
  const bearer = `Bearer ${randomUUID()}`
  let dispatch = initial
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const incoming = Buffer.from(request.headers.get('authorization') || '')
      const expected = Buffer.from(bearer)
      if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) return new Response(null, { status: 401 })
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      let id: unknown = null
      try {
        const message = await request.json() as { id?: unknown; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }
        id = message.id
        if (id === undefined) return new Response(null, { status: 202 })
        let result: unknown
        switch (message.method) {
          case 'initialize': result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'memosync', version: '1' } }; break
          case 'tools/list': result = { tools: specs.map(spec => ({ name: spec.name, description: spec.description, inputSchema: z.toJSONSchema(z.object(spec.schema)) })) }; break
          case 'tools/call': {
            const name = message.params?.name
            const spec = specs.find(spec => spec.name === name)
            const input = spec ? z.object(spec.schema).safeParse(message.params?.arguments ?? {}) : null
            const response = dispatch && name && input?.success
              ? await dispatch(name, input.data, request.signal)
              : { text: 'Memory tool unavailable for this turn.', isError: true }
            result = { content: [{ type: 'text', text: response.text }], ...(response.isError ? { isError: true } : {}) }
            break
          }
          default: return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        }
        return Response.json({ jsonrpc: '2.0', id, result })
      } catch {
        return Response.json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Memory tool request failed' } })
      }
    },
  })
  return {
    config: { type: 'remote' as const, url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: bearer }, oauth: false as const },
    setDispatch(next?: OpencodeMemoryDispatch) { dispatch = next },
    close() { dispatch = undefined; server.stop(true) },
  }
}
