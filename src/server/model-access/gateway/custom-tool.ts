// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/responses.go (customSchema) and custom_tool.go (customStream).
import { GatewayError, type Wire } from "./request"

export interface ToolMapping { name: string; namespace?: string; custom: boolean }
export const customSchema = { type: "object", properties: { input: { type: "string", description: "The tool's free-form input, the whole of it, exactly as it is to be run." } }, required: ["input"], additionalProperties: false }

/** Incremental JSON string unescaping. An incomplete escape/surrogate pair waits. */
export class CustomInputStream {
  private buffer = ""
  private depth = 0
  private inString = false
  private escaped = false
  private key = ""
  private readingKey = false
  private wantKey = false
  private lastKey = ""
  private value = false
  private input = false
  private over = false
  feed(fragment: string): string {
    if (this.over) return ""
    this.buffer += fragment
    let i = 0
    if (!this.input) {
      for (; i < this.buffer.length; i++) {
        const b = this.buffer[i]
        if (this.inString) {
          if (this.readingKey) this.key += b
          if (this.escaped) this.escaped = false
          else if (b === "\\") this.escaped = true
          else if (b === '"') {
            this.inString = false
            if (this.readingKey) { this.readingKey = false; try { this.lastKey = JSON.parse('"' + this.key) } catch { this.lastKey = "" } }
          }
        } else if (b === '"' && (this.depth === 0 || this.depth === 1 && this.value)) { this.input = true; i++; break }
        else if (b === '"') { this.inString = true; if (this.depth === 1 && this.wantKey) { this.readingKey = true; this.key = ""; this.wantKey = false } }
        else if (b === "{" || b === "[") { this.depth++; if (this.depth === 1 && b === "{") this.wantKey = true }
        else if (b === "}" || b === "]") { if (--this.depth <= 0) { this.over = true; break } }
        else if (b === ":" && this.depth === 1) this.value = this.lastKey === "input"
        else if (b === "," && this.depth === 1) { this.wantKey = true; this.value = false }
        else if (!/\s/.test(b)) { if (!this.depth) { this.over = true; break }; if (this.depth === 1) this.value = false }
      }
      this.buffer = this.buffer.slice(i)
    }
    if (!this.input || this.over) return ""
    let n = 0
    for (; n < this.buffer.length;) {
      const c = this.buffer[n]
      if (c === '"') { this.over = true; break }
      if (c === "\\") {
        if (n + 1 >= this.buffer.length) break
        if (this.buffer[n + 1] !== "u") { n += 2; continue }
        if (n + 6 > this.buffer.length) break
        const code = parseInt(this.buffer.slice(n + 2, n + 6), 16)
        if (code >= 0xd800 && code < 0xdc00) {
          if (n + 8 > this.buffer.length) break
          if (this.buffer.slice(n + 6, n + 8) === "\\u") { if (n + 12 > this.buffer.length) break; n += 12; continue }
        }
        n += 6
      } else {
        const code = this.buffer.charCodeAt(n)
        if (code >= 0xd800 && code < 0xdc00 && n + 1 === this.buffer.length) break
        n++
      }
    }
    let text: string
    try { text = JSON.parse('"' + this.buffer.slice(0, n) + '"') } catch { throw new GatewayError("Invalid custom tool input escape", 502) }
    this.buffer = this.buffer.slice(n)
    return text
  }
}
export function customInput(args: string): string {
  let value: unknown
  try { value = JSON.parse(args) } catch { throw new GatewayError("Invalid custom tool argument JSON", 502) }
  if (typeof value === "string") return value
  if (value && typeof value === "object" && typeof (value as Wire).input === "string") return (value as Wire).input
  throw new GatewayError("Custom tool arguments must contain a string input", 502)
}
