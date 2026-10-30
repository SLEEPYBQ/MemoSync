// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/{sse,chat,anthropic,responses}.go: SSE, choice locking,
// interleaved calls, usage, and the two client event encoders.
import { CustomInputStream, customInput, type ToolMapping } from "./custom-tool"
import { GatewayError, object, type Target, type Wire } from "./request"

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = "", data: string[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      // Like Magpie's scanner, bound each event rather than the entire reply.
      if (buffer.length + data.reduce((n, s) => n + s.length, 0) > 32 * 1024 * 1024) throw new GatewayError("Upstream SSE event too large", 502)
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "")
        buffer = buffer.slice(end + 1)
        if (!line) { if (data.length) yield data.join("\n"); data = [] }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      if (done) {
        if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, "").replace(/\r$/, ""))
        if (data.length) yield data.join("\n")
        return
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

type Event = { kind: "text" | "thinking" | "args"; text: string }
  | { kind: "tool"; id: string; name: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "stop"; reason: string }
interface Usage { input: number; output: number; cached: number; reasoning: number }
interface Call { index: number; id: string; name: string; args: string; emitted: boolean }
export class ChatDecoder {
  private choice?: number
  private calls: Call[] = []
  private active?: Call
  finished = false
  done = false
  private flush(): Event[] {
    const events: Event[] = []
    for (const c of this.calls.filter(c => !c.emitted).sort((a, b) => a.index - b.index)) {
      if (!c.name) throw new GatewayError("Upstream tool call has no name", 502)
      c.emitted = true
      events.push({ kind: "tool", id: c.id, name: c.name })
      if (c.args) events.push({ kind: "args", text: c.args })
    }
    return events
  }
  decode(data: string): Event[] {
    if (data.trim() === "[DONE]") { this.done = true; return this.flush() }
    let b: Wire
    try { b = object(JSON.parse(data)) } catch { throw new GatewayError("Malformed Chat Completions SSE event", 502) }
    if (b.error) throw new GatewayError("Upstream stream reported an error", 502)
    const out: Event[] = []
    for (const c of b.choices ?? []) {
      const index = typeof c.index === "number" || (typeof c.index === "string" && c.index.trim()) ? Number(c.index) : NaN
      if (Number.isSafeInteger(index) && index >= 0) {
        if (this.choice === undefined) this.choice = index
        else if (index !== this.choice) continue
      }
      const d = c.delta ?? {}
      const thought = d.reasoning_content || d.reasoning
      if (typeof thought === "string" && thought) out.push({ kind: "thinking", text: thought })
      if (typeof d.content === "string" && d.content) out.push({ kind: "text", text: d.content })
      else if (d.content != null && typeof d.content !== "string") throw new GatewayError("Unsupported upstream content delta", 502)
      if (d.refusal) throw new GatewayError("Upstream refused the request", 502)
      for (const [i, tc] of (d.tool_calls ?? []).entries()) {
        const idx = tc.index ?? i
        let call = [...this.calls].reverse().find(c => c.index === idx)
        if (!call || (tc.id && tc.id !== call.id)) {
          call = { index: idx, id: tc.id || `call_${crypto.randomUUID()}`, name: tc.function?.name ?? "", args: "", emitted: false }
          this.calls.push(call)
        }
        if (tc.function?.name && !call.name) call.name = tc.function.name
        const args = tc.function?.arguments ?? ""
        if (typeof args !== "string") throw new GatewayError("Invalid upstream tool arguments", 502)
        call.args += args
        // Hold other interleaved calls until the first has finished, so each
        // Anthropic block and Responses item opens and closes exactly once.
        if (!this.active && call.name) {
          this.active = call; call.emitted = true
          out.push({ kind: "tool", id: call.id, name: call.name })
          if (call.args) out.push({ kind: "args", text: call.args })
        } else if (this.active === call && args) out.push({ kind: "args", text: args })
      }
      if (c.finish_reason) {
        out.push(...this.flush(), { kind: "stop", reason: c.finish_reason })
        this.finished = true
      }
    }
    if (b.usage) {
      const u = b.usage
      const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
      out.push({ kind: "usage", usage: { input: number(u.prompt_tokens), output: number(u.completion_tokens), cached: number(u.prompt_tokens_details?.cached_tokens), reasoning: number(u.completion_tokens_details?.reasoning_tokens) } })
    }
    return out
  }
}

export class ClientEncoder {
  private seq = 0
  private id: string
  private created = Math.floor(Date.now() / 1000)
  private output: Wire[] = []
  private current?: { kind: "text" | "thinking" | "tool"; id: string; name?: string; callId?: string; text: string }
  private usage: Usage = { input: 0, output: 0, cached: 0, reasoning: 0 }
  private stop = "stop"
  private hasTools = false
  private customStream = new CustomInputStream()
  private events: Wire[] = []
  result?: Wire
  constructor(readonly target: Target, readonly model: string, readonly tools: Record<string, ToolMapping> = {}) { this.id = `${target === "anthropic" ? "msg" : "resp"}_${crypto.randomUUID()}` }
  private send(type: string, value: Wire = {}) { this.events.push({ type, ...(this.target === "responses" ? { sequence_number: this.seq++ } : {}), ...value }) }
  drain(): Wire[] { const out = this.events; this.events = []; return out }
  private get index() { return this.output.length }
  private antUsage() { return { input_tokens: Math.max(0, this.usage.input - this.usage.cached), output_tokens: this.usage.output, cache_read_input_tokens: this.usage.cached, cache_creation_input_tokens: 0 } }
  private response(status: string): Wire {
    return { id: this.id, object: "response", created_at: this.created, status, model: this.model, output: [...this.output], error: null, incomplete_details: null,
      usage: { input_tokens: this.usage.input, output_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output, input_tokens_details: { cached_tokens: this.usage.cached }, output_tokens_details: { reasoning_tokens: this.usage.reasoning } } }
  }
  start() {
    if (this.target === "anthropic") this.send("message_start", { message: { id: this.id, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: this.antUsage() } })
    else {
      this.send("response.created", { response: this.response("in_progress") })
      this.send("response.in_progress", { response: this.response("in_progress") })
    }
  }
  private close() {
    const c = this.current
    if (!c) return
    if (c.kind === "tool" && !c.text) this.delta("{}")
    if (this.target === "anthropic") {
      let block: Wire
      if (c.kind === "tool") {
        let input: unknown
        try { input = JSON.parse(c.text); object(input) } catch { throw new GatewayError("Upstream returned invalid tool argument JSON", 502) }
        block = { type: "tool_use", id: c.callId, name: c.name, input }
      } else block = c.kind === "thinking" ? { type: "thinking", thinking: c.text, signature: "" } : { type: "text", text: c.text }
      this.send("content_block_stop", { index: this.index })
      this.output.push(block)
    } else {
      const at = { item_id: c.id, output_index: this.index }
      let item: Wire
      if (c.kind === "text") {
        const part = { type: "output_text", text: c.text, annotations: [], logprobs: [] }
        this.send("response.output_text.done", { ...at, content_index: 0, text: c.text, logprobs: [] })
        this.send("response.content_part.done", { ...at, content_index: 0, part })
        item = { id: c.id, type: "message", role: "assistant", status: "completed", content: [part] }
      } else if (c.kind === "thinking") {
        const part = { type: "summary_text", text: c.text }
        this.send("response.reasoning_summary_text.done", { ...at, summary_index: 0, text: c.text })
        this.send("response.reasoning_summary_part.done", { ...at, summary_index: 0, part })
        item = { id: c.id, type: "reasoning", status: "completed", summary: [part] }
      } else {
        const mapping = this.tools[c.name!]
        const name = mapping?.name ?? c.name
        const namespace = mapping?.namespace ? { namespace: mapping.namespace } : {}
        if (mapping?.custom) {
          const input = customInput(c.text)
          this.send("response.custom_tool_call_input.done", { ...at, input })
          item = { id: c.id, type: "custom_tool_call", status: "completed", call_id: c.callId, name, ...namespace, input }
        } else {
          try { object(JSON.parse(c.text)) } catch { throw new GatewayError("Upstream returned invalid tool argument JSON", 502) }
          this.send("response.function_call_arguments.done", { ...at, call_id: c.callId, name, ...namespace, arguments: c.text })
          item = { id: c.id, type: "function_call", status: "completed", call_id: c.callId, name, ...namespace, arguments: c.text }
        }
      }
      this.send("response.output_item.done", { output_index: this.index, item })
      this.output.push(item)
    }
    this.current = undefined
  }
  private open(kind: "text" | "thinking" | "tool", id?: string, name?: string) {
    if (this.current?.kind === kind && kind !== "tool") return
    this.close()
    const itemId = `${kind === "tool" ? "fc" : kind === "thinking" ? "rs" : "msg"}_${crypto.randomUUID()}`
    this.current = { kind, id: itemId, callId: id, name, text: "" }
    this.customStream = new CustomInputStream()
    if (kind === "tool") this.hasTools = true
    if (this.target === "anthropic") {
      const block = kind === "tool" ? { type: "tool_use", id, name, input: {} } : kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" }
      this.send("content_block_start", { index: this.index, content_block: block })
    } else {
      const mapping = name ? this.tools[name] : undefined
      const tool = { type: mapping?.custom ? "custom_tool_call" : "function_call", call_id: id, name: mapping?.name ?? name, ...(mapping?.namespace ? { namespace: mapping.namespace } : {}), ...(mapping?.custom ? { input: "" } : { arguments: "" }) }
      const item = kind === "tool" ? tool : kind === "thinking" ? { type: "reasoning", summary: [] } : { type: "message", role: "assistant", content: [] }
      this.send("response.output_item.added", { output_index: this.index, item: { ...item, id: itemId, status: "in_progress" } })
      const at = { item_id: itemId, output_index: this.index }
      if (kind === "text") this.send("response.content_part.added", { ...at, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } })
      if (kind === "thinking") this.send("response.reasoning_summary_part.added", { ...at, summary_index: 0, part: { type: "summary_text", text: "" } })
    }
  }
  private delta(text: string) {
    const c = this.current!
    c.text += text
    if (this.target === "anthropic") {
      const delta = c.kind === "text" ? { type: "text_delta", text } : c.kind === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "input_json_delta", partial_json: text }
      this.send("content_block_delta", { index: this.index, delta })
    } else {
      const at = { item_id: c.id, output_index: this.index, delta: text }
      if (c.kind === "text") this.send("response.output_text.delta", { ...at, content_index: 0, logprobs: [] })
      else if (c.kind === "thinking") this.send("response.reasoning_summary_text.delta", { ...at, summary_index: 0 })
      else if (this.tools[c.name!]?.custom) {
        const delta = this.customStream.feed(text)
        if (delta) this.send("response.custom_tool_call_input.delta", { ...at, delta })
      } else this.send("response.function_call_arguments.delta", at)
    }
  }
  event(ev: Event) {
    switch (ev.kind) {
      case "text": case "thinking": this.open(ev.kind); this.delta(ev.text); break
      case "tool": this.open("tool", ev.id, ev.name); break
      case "args":
        if (this.current?.kind !== "tool") throw new GatewayError("Out-of-order upstream tool arguments", 502)
        this.delta(ev.text); break
      case "usage": this.usage = ev.usage; break
      case "stop": this.stop = ev.reason; break
    }
  }
  finish() {
    this.close()
    if (this.target === "anthropic") {
      const reason = this.stop === "length" ? "max_tokens" : this.stop === "content_filter" ? "refusal" : this.hasTools ? "tool_use" : "end_turn"
      this.send("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: this.antUsage() })
      this.send("message_stop")
      this.result = { id: this.id, type: "message", role: "assistant", model: this.model, content: this.output, stop_reason: reason, stop_sequence: null, usage: this.antUsage() }
    } else {
      const incomplete = ["length", "content_filter"].includes(this.stop)
      this.result = this.response(incomplete ? "incomplete" : "completed")
      if (incomplete) this.result.incomplete_details = { reason: this.stop === "length" ? "max_output_tokens" : "content_filter" }
      this.send(incomplete ? "response.incomplete" : "response.completed", { response: this.result })
    }
  }
  fail(message: string) {
    // An incomplete block must never be finalized as a successful tool call.
    if (this.target === "anthropic") this.send("error", { error: { type: "api_error", message } })
    else this.send("response.failed", { response: { ...this.response("failed"), error: { code: "server_error", message } } })
  }
}
