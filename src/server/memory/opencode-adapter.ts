import { randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { MemoryToolResult, MemoryToolSpec } from './tools'
import type { HostNativeToolContext } from '../../shared/host-actions'
import { isHostActionTool, unavailableHostCall } from '../host-actions'

export type OpencodeMemoryDispatch = (name: string, args: Record<string, unknown>, signal?: AbortSignal, native?: HostNativeToolContext) => Promise<MemoryToolResult>
export type OpencodeNativeResolver = (name: string, input: { sessionID: string; callID: string }, signal: AbortSignal) => Promise<HostNativeToolContext | undefined>
export const OPENCODE_HOST_TICKET = '__memosync_host_ticket'

/** A chat-scoped capability: OpenCode's MCP requests carry no session identity. */
export function createOpencodeMemoryMcp(specs: MemoryToolSpec[], initial?: OpencodeMemoryDispatch) {
  const bearer = `Bearer ${randomUUID()}`
  const nativeBearer = `Bearer ${randomUUID()}`
  let dispatch = initial
  let resolveNative: OpencodeNativeResolver | undefined
  const tickets = new Map<string, { name: string; input: string; native: HostNativeToolContext; dispatch: OpencodeMemoryDispatch }>()
  const parse = (name: unknown, input: unknown) => {
    const spec = specs.find(spec => spec.name === name)
    return spec ? z.object(spec.schema).safeParse(input ?? {}) : undefined
  }
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const incoming = Buffer.from(request.headers.get('authorization') || '')
      const binding = new URL(request.url).pathname === '/native-call'
      const expected = Buffer.from(binding ? nativeBearer : bearer)
      if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) return new Response(null, { status: 401 })
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      let id: unknown = null
      try {
        if (binding) {
          const body = await request.json() as { name: string; args: unknown; sessionID: string; callID: string }
          const input = parse(body.name, body.args), captured = dispatch, resolver = resolveNative
          if (!isHostActionTool(body.name) || !input?.success || !captured || !resolver || tickets.size >= 4096) return Response.json({ unavailable: true })
          const native = await resolver(body.name, body, request.signal)
          if (!native || dispatch !== captured || resolveNative !== resolver || request.signal.aborted) return Response.json({ unavailable: true })
          const ticket = randomUUID()
          tickets.set(ticket, { name: body.name, input: JSON.stringify(input.data), native, dispatch: captured })
          return Response.json({ ticket })
        }
        const message = await request.json() as { id?: unknown; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }
        id = message.id
        if (id === undefined) return new Response(null, { status: 202 })
        let result: unknown
        switch (message.method) {
          case 'initialize': result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'memosync', version: '1' } }; break
          case 'tools/list': result = { tools: specs.map(spec => ({ name: spec.name, description: spec.description, inputSchema: z.toJSONSchema(z.object(spec.schema)) })) }; break
          case 'tools/call': {
            const name = message.params?.name
            const input = parse(name, message.params?.arguments)
            let response: MemoryToolResult
            if (name && isHostActionTool(name)) {
              const ticket = message.params?.arguments?.[OPENCODE_HOST_TICKET]
              const call = typeof ticket === 'string' ? tickets.get(ticket) : undefined
              response = input?.success && call && call.name === name && call.dispatch === dispatch && call.input === JSON.stringify(input.data)
                ? await call.dispatch(name, input.data, request.signal, call.native) : unavailableHostCall()
            } else response = dispatch && name && input?.success
              ? await dispatch(name, input.data, request.signal) : { text: 'Memory tool unavailable for this turn.', isError: true }
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
    nativeConfig: { url: `http://127.0.0.1:${server.port}/native-call`, authorization: nativeBearer },
    setDispatch(next?: OpencodeMemoryDispatch, resolver?: OpencodeNativeResolver) { dispatch = next; resolveNative = resolver; tickets.clear() },
    close() { dispatch = undefined; resolveNative = undefined; tickets.clear(); server.stop(true) },
  }
}
