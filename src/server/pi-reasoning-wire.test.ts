import { expect, test } from "bun:test"
import { streamSimpleOpenAICompletions } from "@mariozechner/pi-ai/openai-completions"
import { streamSimpleOpenAIResponses } from "@mariozechner/pi-ai/openai-responses"
import { resolvePiEffort, toPiThinkingLevel, type RegistryModelCard } from "../shared/model-capabilities"
import { buildRegistryModel } from "./pi-agent"
import { parseRegistryModelCard } from "./registry-models"

// Exercise Pi's real clamp/serialization path and capture the HTTP JSON. No
// provider or paid model is called; the fixture deliberately ends with a 400.
async function outgoingBody(format: "openai" | "openrouter" | "responses", card?: RegistryModelCard, requested?: "off" | "high" | "max") {
  let body: Record<string, unknown> | undefined
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    body = await request.json() as Record<string, unknown>
    return Response.json({ error: { message: "fixture request captured" } }, { status: 400 })
  } })
  try {
    const connection = { provider: "custom" as const, baseUrl: format === "openrouter" ? "https://openrouter.ai/api/v1" : "https://example.test/v1", apiKey: "fixture-key" }
    const effort = resolvePiEffort(card, requested)
    const model = { ...buildRegistryModel(connection, card?.id ?? "unknown-model", card, effort), baseUrl: `http://127.0.0.1:${server.port}/v1` }
    const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] }
    // Agent core passes no simple-stream reasoning option for its off slot.
    const thinkingLevel = toPiThinkingLevel(effort)
    const options = { apiKey: connection.apiKey, reasoning: thinkingLevel === "off" ? undefined : thinkingLevel, maxRetries: 0 }
    const result = await (format === "responses"
      ? streamSimpleOpenAIResponses({ ...model, api: "openai-responses" }, context, options)
      : streamSimpleOpenAICompletions(model, context, options)).result()
    expect(result.errorMessage).toContain("fixture request captured")
    expect(body).toBeDefined()
    return body!
  } finally { await server.stop(true) }
}

test.each(["openai", "openrouter", "responses"] as const)("unknown-model default omits reasoning from the real %s HTTP body", async format => {
  for (const card of [undefined, parseRegistryModelCard({ id: "unknown-model" })!]) {
    const body = await outgoingBody(format, card, "high")
    for (const field of ["reasoning", "reasoning_effort", "thinking", "enable_thinking"]) {
      expect(body).not.toHaveProperty(field)
    }
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      expect(body).not.toHaveProperty(field)
    }
  }
})

test.each(["openai", "openrouter", "responses"] as const)("a known 8K output cap is respected in %s HTTP JSON", async format => {
  const card = parseRegistryModelCard({ id: "small-model", max_output_tokens: 8192 })!
  const body = await outgoingBody(format, card)
  expect(body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens).toBe(8192)
})

test.each(["openai", "openrouter", "responses"] as const)("explicit Off remains distinguishable from default in %s HTTP JSON", async format => {
  const card = parseRegistryModelCard({ id: "optional", reasoning: { supported_efforts: ["none", "high"] } })!
  const body = await outgoingBody(format, card, "off")
  expect(format === "openai" ? body.reasoning_effort : (body.reasoning as { effort: string }).effort).toBe("none")
})

test("supported Max reaches the OpenRouter HTTP body as max", async () => {
  const card = parseRegistryModelCard({ id: "model", reasoning: { mandatory: true, supported_efforts: ["low", "high", "max"] } })!
  expect((await outgoingBody("openrouter", card, "max")).reasoning).toEqual({ effort: "max" })
})
