// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/gateway.go: routing and translation orchestration.
// MemoSync owns the loopback listener, process token and credential-store bindings.
import type { ConnectionEndpoint } from "../../../shared/model-access"
import type { ModelAccessService } from "../service"
import { encodeChat, GatewayError, parseRequest, type Target, type Wire } from "./request"
import { ChatDecoder, ClientEncoder, readSSE } from "./stream"

const token = crypto.randomUUID() + crypto.randomUUID()
const bindings = new Map<string, { service: ModelAccessService; connectionId: string; target: Target }>()
let serviceIds = new WeakMap<ModelAccessService, string>()
let server: ReturnType<typeof Bun.serve> | undefined

export function errorBody(target: Target, status: number, message: string): Wire {
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "api_error"
  return target === "anthropic" ? { type: "error", error: { type, message } } : { error: { type, code: type, message, param: null } }
}
const failure = (target: Target, status: number, message: string) => Response.json(errorBody(target, status, message), { status })

async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname
  const target: Target = path.includes("/anthropic/") ? "anthropic" : "responses"
  if (req.headers.get("authorization") !== `Bearer ${token}` && req.headers.get("x-api-key") !== token) return failure(target, 401, "Invalid gateway token")
  const match = path.match(/^(\/c\/[^/]+\/(anthropic|responses))\/(?:v1\/)?(messages|responses)$/)
  const binding = match && bindings.get(match[1])
  if (!binding || (binding.target === "anthropic" ? match![3] !== "messages" : match![3] !== "responses")) return failure(target, 404, "Unknown gateway route")
  if (req.method !== "POST") return failure(target, 405, "Only POST is supported")
  const abort = new AbortController()
  const cancel = () => abort.abort()
  req.signal.addEventListener("abort", cancel, { once: true })
  const cleanup = () => req.signal.removeEventListener("abort", cancel)
  let handedOff = false
  let upstream: Response | undefined
  try {
    const connection = binding.service.connection(binding.connectionId)
    const endpoint = connection?.endpoints.find(e => e.protocol === "openai-chat")
    if (!endpoint) return failure(target, 404, "Connection or Chat endpoint no longer exists")
    const request = parseRequest(target, await req.json().catch(() => { throw new GatewayError("Invalid JSON request") }))
    const key = await binding.service.getKey(binding.connectionId)
    if (!key && connection!.keySource !== "none") return failure(target, 401, "Connection key is missing")
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" }
    if (key) headers[endpoint.authHeader === "x-api-key" ? "x-api-key" : "authorization"] = endpoint.authHeader === "x-api-key" ? key : `Bearer ${key}`
    upstream = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(encodeChat(request)), signal: abort.signal,
      // Do not forward credentials to a redirect destination.
      redirect: "error",
    })
    if (!upstream.ok) {
      // Provider bodies can echo request keys. Keep the status and a safe message.
      return failure(target, upstream.status, `Chat Completions upstream returned HTTP ${upstream.status}`)
    }
    if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) return failure(target, 502, "Chat Completions upstream did not return an SSE stream")
    const encoder = new ClientEncoder(target, request.model, request.toolMappings)
    const decoder = new ChatDecoder()
    const body = upstream.body
    async function* events(): AsyncGenerator<Wire> {
      try {
        encoder.start()
        yield* encoder.drain()
        for await (const data of readSSE(body)) {
          for (const ev of decoder.decode(data)) encoder.event(ev)
          yield* encoder.drain()
          if (decoder.done) break
        }
        if (!decoder.finished && !decoder.done) throw new GatewayError("Chat Completions upstream disconnected before completing the response", 502)
        encoder.finish()
        yield* encoder.drain()
      } catch (error) {
        const message = error instanceof GatewayError ? error.message : "Chat Completions upstream disconnected"
        if (!request.stream) throw new GatewayError(message, 502)
        encoder.fail(message)
        yield* encoder.drain()
      } finally { cleanup(); abort.abort() }
    }
    if (!request.stream) {
      for await (const _ of events()) { /* collect into encoder.result */ }
      return Response.json(encoder.result)
    }
    const iterator = events()
    const utf8 = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(utf8.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`))
      },
      async cancel() { abort.abort(); await iterator.return(undefined); cleanup() },
    })
    handedOff = true
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  } catch (error) {
    return failure(target, error instanceof GatewayError ? error.status : 502, error instanceof GatewayError ? error.message : "Chat Completions upstream request failed")
  } finally {
    if (!handedOff) { cleanup(); abort.abort(); await upstream?.body?.cancel().catch(() => {}) }
  }
}

/** Lazily shared across all translated turns; the child receives only this token. */
export function gatewayEndpoint(service: ModelAccessService, connectionId: string, target: Target): { endpoint: ConnectionEndpoint; key: string } {
  if (!server) {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 32 * 1024 * 1024, fetch: handle })
    server.unref()
  }
  let serviceId = serviceIds.get(service)
  if (!serviceId) { serviceId = crypto.randomUUID(); serviceIds.set(service, serviceId) }
  const path = `/c/${serviceId}-${encodeURIComponent(connectionId)}/${target}`
  bindings.set(path, { service, connectionId, target })
  return { endpoint: { protocol: target === "anthropic" ? "anthropic-messages" : "openai-responses", baseUrl: `http://127.0.0.1:${server.port}${path}`, authHeader: "bearer" }, key: token }
}

/** Explicit lifecycle hook, also used by isolated tests. */
export function stopGateway() {
  server?.stop(true); server = undefined; bindings.clear(); serviceIds = new WeakMap()
}
