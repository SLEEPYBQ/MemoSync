// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/provider/test.go: tiny native requests and Anthropic auth fallback.
import type { ConnectionEndpoint, ConnectionTestResult } from "../../shared/model-access"

export async function testEndpoint(endpoint: ConnectionEndpoint, key: string | undefined, model: string): Promise<ConnectionTestResult> {
  const started = performance.now()
  const protocol = endpoint.protocol
  const anthropic = protocol === "anthropic-messages"
  const suffix = anthropic ? "/v1/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions"
  const body = protocol === "openai-responses"
    ? { model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], max_output_tokens: 16 }
    : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 }
  const request = (auth: "bearer" | "x-api-key") => fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}${suffix}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}), ...(key ? auth === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  })
  try {
    const auth = endpoint.authHeader ?? "bearer"
    let response = await request(auth)
    if (anthropic && (response.status === 401 || response.status === 403)) {
      await response.body?.cancel()
      response = await request(auth === "bearer" ? "x-api-key" : "bearer")
    }
    const latencyMs = Math.round(performance.now() - started)
    const status = response.status
    // Providers sometimes echo credentials/request headers in errors. Never return raw bodies.
    await response.body?.cancel()
    if (response.ok) return { ok: true, protocol, latencyMs }
    const errorCode = status === 401 || status === 403 ? "unauthorized" : status === 404 ? "not-found" : status === 400 || status === 422 ? "model-unavailable" : "unknown"
    return { ok: false, protocol, latencyMs, errorCode }
  } catch { return { ok: false, protocol, errorCode: "network", latencyMs: Math.round(performance.now() - started) } }
}
