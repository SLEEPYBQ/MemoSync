// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/{ir,anthropic,responses,chat}.go: text/function request subset.
import { customSchema, type ToolMapping } from "./custom-tool"

export type Target = "anthropic" | "responses"
// Wire objects are validated at the protocol boundary; schemas remain opaque JSON.
export type Wire = Record<string, any>
export class GatewayError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
export function object(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("Expected a JSON object")
  return value as Wire
}
function list(value: unknown): any[] {
  if (!Array.isArray(value)) throw new GatewayError("Expected a JSON array")
  return value
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new GatewayError("Expected a string")
  return value
}
function text(value: unknown, types: string[]): string {
  if (typeof value === "string") return value
  return list(value).map(v => {
    const p = object(v)
    if (!types.includes(p.type)) throw new GatewayError(`Cannot translate content type: ${p.type}; use a native endpoint`)
    return str(p.text)
  }).join("")
}
export interface Part { kind: "text" | "thinking" | "call" | "result"; text?: string; id?: string; name?: string; args?: string }
export interface TranslationRequest {
  model: string
  stream: boolean
  messages: { role: string; parts: Part[] }[]
  tools: Wire[]
  options: Wire
  toolMappings: Record<string, ToolMapping>
}

export function parseRequest(target: Target, value: unknown): TranslationRequest {
  const b = object(value)
  if (!str(b.model).trim()) throw new GatewayError("model is required")
  if (b.stream !== undefined && typeof b.stream !== "boolean") throw new GatewayError("stream must be boolean")
  if (b.previous_response_id || b.conversation || b.background) throw new GatewayError("Stateful/background Responses requests require a native endpoint; send the full input history")
  const r: TranslationRequest = { model: b.model, stream: b.stream === true, messages: [], tools: [], options: {}, toolMappings: Object.create(null) }
  const add = (role: string, parts: Part[]) => {
    if (!["user", "assistant", "system", "developer"].includes(role)) throw new GatewayError(`Unsupported role: ${role}`)
    r.messages.push({ role, parts })
  }
  const plain = (v: unknown, types: string[]) => ({ kind: "text" as const, text: text(v, types) })
  if (target === "anthropic") {
    if (b.system !== undefined) add("system", [plain(b.system, ["text"])])
    for (const raw of list(b.messages)) {
      const m = object(raw)
      // Current Claude Code also appends system/developer turn instructions;
      // encodeChat places them where every Chat vendor accepts them.
      if (!["user", "assistant", "system", "developer"].includes(m.role)) throw new GatewayError("Unsupported Messages role")
      const parts: Part[] = typeof m.content === "string" ? [plain(m.content, ["text"])] : list(m.content).map(raw => {
        const p = object(raw)
        switch (p.type) {
          case "text": return { kind: "text", text: str(p.text) }
          case "thinking":
            if (m.role !== "assistant") throw new GatewayError("thinking requires an assistant message")
            return { kind: "thinking", text: str(p.thinking) }
          case "tool_use":
            if (m.role !== "assistant") throw new GatewayError("tool_use requires an assistant message")
            return { kind: "call", id: str(p.id), name: str(p.name), args: JSON.stringify(object(p.input)) }
          case "tool_result":
            if (m.role !== "user") throw new GatewayError("tool_result requires a user message")
            return { kind: "result", id: str(p.tool_use_id), text: text(p.content ?? "", ["text"]) }
          default: throw new GatewayError(`Cannot translate content type: ${p.type}; use a native endpoint`)
        }
      })
      add(m.role, parts)
    }
    for (const raw of list(b.tools ?? [])) {
      const t = object(raw)
      // Server tools (web search, code execution) run at the vendor and have no Chat form.
      // Leave them out, as Magpie does: Claude Code always offers WebSearch.
      if (t.type && t.type !== "custom") continue
      r.tools.push({ type: "function", function: { name: str(t.name), ...(t.description ? { description: str(t.description) } : {}), parameters: object(t.input_schema) } })
    }
    if (b.tool_choice) {
      const tc = object(b.tool_choice)
      if (!["auto", "any", "none", "tool"].includes(tc.type)) throw new GatewayError("Unsupported tool_choice")
      r.options.tool_choice = tc.type === "tool" ? { type: "function", function: { name: str(tc.name) } } : tc.type === "any" ? "required" : tc.type
      if (tc.disable_parallel_tool_use) r.options.parallel_tool_calls = false
    }
    if (b.stop_sequences !== undefined) r.options.stop = list(b.stop_sequences).map(str)
    if (b.thinking?.type === "disabled") r.options.reasoning_effort = "none"
    else if (b.thinking && b.output_config?.effort) r.options.reasoning_effort = str(b.output_config.effort)
    if (b.output_config?.format) {
      const f = object(b.output_config.format)
      if (f.type !== "json_schema") throw new GatewayError("Unsupported output format")
      r.options.response_format = { type: "json_schema", json_schema: { name: "response", schema: object(f.schema) } }
    }
  } else {
    if (b.instructions !== undefined && b.instructions !== null) add("system", [plain(b.instructions, ["input_text"])])
    if (typeof b.input === "string") add("user", [{ kind: "text", text: b.input }])
    else for (const raw of list(b.input)) {
      const it = object(raw)
      switch (it.type ?? "message") {
        case "message": add(str(it.role), [plain(it.content, ["input_text", "output_text"])]); break
        case "function_call":
          add("assistant", [{ kind: "call", id: str(it.call_id), name: it.namespace ? `${str(it.namespace)}__${str(it.name)}` : str(it.name), args: str(it.arguments) }]); break
        case "custom_tool_call":
          add("assistant", [{ kind: "call", id: str(it.call_id), name: it.namespace ? `${str(it.namespace)}__${str(it.name)}` : str(it.name), args: JSON.stringify({ input: str(it.input) }) }]); break
        case "custom_tool_call_output":
        case "function_call_output": add("user", [{ kind: "result", id: str(it.call_id), text: text(it.output, ["input_text", "output_text", "text"]) }]); break
        case "reasoning":
          if (it.encrypted_content) throw new GatewayError("Encrypted reasoning requires a native endpoint")
          add("assistant", [{ kind: "thinking", text: text(it.summary ?? [], ["summary_text"]) }]); break
        default: throw new GatewayError(`Cannot translate input item: ${it.type}; use a native endpoint`)
      }
    }
    const addTool = (raw: unknown, namespace?: string) => {
      const t = object(raw)
      if (t.type === "namespace" && !namespace) { for (const child of list(t.tools)) addTool(child, str(t.name)); return }
      // Hosted tools (web_search, file_search, …) have no Chat form; Codex always sends
      // web_search. Leave them out rather than failing every turn, as Magpie does.
      if (!["function", "custom"].includes(t.type)) return
      const original = str(t.name), name = namespace ? `${namespace}__${original}` : original
      if (r.toolMappings[name]) throw new GatewayError(`Duplicate or colliding tool name: ${name}`)
      const custom = t.type === "custom"
      r.toolMappings[name] = { name: original, ...(namespace ? { namespace } : {}), custom }
      let description = t.description ? str(t.description) : ""
      if (custom) {
        description += "\nPass the tool's complete free-form input in the input string."
        if (t.format?.type === "grammar") description += `\nInput grammar (${str(t.format.syntax)}):\n${str(t.format.definition)}`
        else if (t.format && t.format.type !== "text") throw new GatewayError("Unsupported custom tool format")
      }
      r.tools.push({ type: "function", function: { name, ...(description ? { description } : {}), parameters: custom ? customSchema : object(t.parameters ?? {}), ...(!custom && t.strict !== undefined ? { strict: t.strict } : {}) } })
    }
    for (const raw of list(b.tools ?? [])) addTool(raw)
    if (b.tool_choice !== undefined) {
      const tc = b.tool_choice
      if (typeof tc === "string" && ["auto", "none", "required"].includes(tc)) r.options.tool_choice = tc
      else if (["function", "custom"].includes(object(tc).type)) r.options.tool_choice = { type: "function", function: { name: tc.namespace ? `${str(tc.namespace)}__${str(tc.name)}` : str(tc.name) } }
      else throw new GatewayError("Unsupported tool_choice")
    }
    if (b.parallel_tool_calls !== undefined) r.options.parallel_tool_calls = b.parallel_tool_calls
    if (b.reasoning?.effort) r.options.reasoning_effort = str(b.reasoning.effort)
    if (b.text?.format) {
      const f = object(b.text.format)
      if (f.type === "json_schema") r.options.response_format = { type: f.type, json_schema: { name: str(f.name), schema: object(f.schema), ...(f.strict !== undefined ? { strict: f.strict } : {}) } }
      else if (["text", "json_object"].includes(f.type)) r.options.response_format = { type: f.type }
      else throw new GatewayError("Unsupported text format")
    }
  }
  for (const key of ["temperature", "top_p"]) if (b[key] !== undefined) {
    if (typeof b[key] !== "number" || !Number.isFinite(b[key])) throw new GatewayError(`${key} must be numeric`)
    r.options[key] = b[key]
  }
  const max = target === "anthropic" ? b.max_tokens : b.max_output_tokens
  if (max !== undefined) {
    if (!Number.isSafeInteger(max) || max <= 0) throw new GatewayError("Maximum output tokens must be a positive integer")
    r.options.max_tokens = max
  }
  if (r.options.tool_choice === "required" && !r.tools.length) throw new GatewayError("Required tool choice has no callable tools")
  const named = r.options.tool_choice?.function?.name
  if (named && !r.tools.some(t => t.function.name === named)) throw new GatewayError("Chosen tool is not declared")
  return r
}

export function encodeChat(r: TranslationRequest): Wire {
  const messages: Wire[] = []
  // Many Chat vendors reject "developer" and any system message after the first
  // (GLM: 1214). As Magpie does, instructions before the first reply become one
  // leading system message; later ones ride in a user turn as a system reminder.
  const system: string[] = []
  let replied = false
  for (const m of r.messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = m.parts.map(p => p.kind === "text" ? p.text : "").join("")
      if (!text) continue
      if (!replied) system.push(text)
      else messages.push({ role: "user", content: `<system-reminder>\n${text}\n</system-reminder>` })
      continue
    }
    if (m.role === "assistant") {
      replied = true
      // Responses sends reasoning and parallel calls as separate adjacent items.
      let out = messages.at(-1)
      if (out?.role !== "assistant") { out = { role: "assistant", content: "" }; messages.push(out) }
      for (const p of m.parts) {
        if (p.kind === "text") out!.content += p.text
        if (p.kind === "thinking") out!.reasoning_content = (out!.reasoning_content ?? "") + p.text
        if (p.kind === "call") (out!.tool_calls ??= []).push({ id: p.id, type: "function", function: { name: p.name, arguments: p.args } })
      }
    } else {
      let content = ""
      const flush = () => { if (content) messages.push({ role: m.role, content }); content = "" }
      for (const p of m.parts) {
        if (p.kind === "result") { flush(); messages.push({ role: "tool", tool_call_id: p.id, content: p.text }) }
        else content += p.text ?? ""
      }
      flush()
    }
  }
  if (system.length) messages.unshift({ role: "system", content: system.join("\n\n") })
  return { model: r.model, messages, stream: true, stream_options: { include_usage: true }, ...r.options, ...(r.tools.length ? { tools: r.tools } : {}) }
}
