import type { HostNativeToolContext } from '../shared/host-actions'
import { isHostActionTool, unavailableHostCall } from './host-actions'
import type { MemoryToolResult } from './memory/tools'

export type HostToolDispatch = (name: string, input: Record<string, unknown>, native: HostNativeToolContext, signal?: AbortSignal) => Promise<MemoryToolResult>

interface Prompt {
  id: string
  active: boolean
  dispatch: HostToolDispatch
}
interface Call { name: string; prompt: Prompt; native: HostNativeToolContext }

/** Join the SDK's echoed input UUID and native tool_use block to MCP metadata.
 * Neither arguments nor whichever human turn happens to be current grant authority.
 */
export class ClaudeHostActions {
  private readonly instance = crypto.randomUUID()
  private readonly prompts = new Map<string, Prompt>()
  private readonly calls = new Map<string, Call>()
  private readonly changed = new Set<() => void>()
  private current?: Prompt
  private closed = false

  reserve(id: string, dispatch?: HostToolDispatch) {
    if (!this.closed && dispatch) this.prompts.set(id, { id, dispatch, active: true })
  }
  revoke(id: string) {
    const prompt = this.prompts.get(id)
    if (prompt) prompt.active = false
    for (const notify of this.changed) notify()
  }
  observe(message: any) {
    if (this.closed) return
    if (message.type === 'user' && !message.parent_tool_use_id && typeof message.message?.content === 'string') {
      // --replay-user-messages echoes the exact SDKUserMessage UUID. Unknown
      // native/background inputs deliberately remove foreground authority.
      this.current = this.prompts.get(message.uuid)
    }
    if (message.type === 'result') {
      const ids: string[] = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])
      for (const id of ids) this.revoke(id)
      if (!ids.length && this.current) this.revoke(this.current.id)
    }
    const prompt = this.current
    if (!prompt?.active || message.parent_tool_use_id || typeof message.session_id !== 'string' || !message.session_id) return
    const blocks = message.type === 'assistant' ? message.message?.content
      : message.type === 'stream_event' && message.event?.type === 'content_block_start' ? [message.event.content_block] : []
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !block.id || typeof block.name !== 'string') continue
      const prefix = 'mcp__memory__'
      if (!block.name.startsWith(prefix) || !isHostActionTool(block.name.slice(prefix.length)) || this.calls.has(block.id)) continue
      this.calls.set(block.id, { name: block.name.slice(prefix.length), prompt,
        native: Object.freeze({ engineInstanceId: this.instance, nativeSessionId: message.session_id, nativeTurnId: prompt.id, nativeToolCallId: block.id }) })
      for (const notify of this.changed) notify()
    }
  }
  async dispatch(name: string, input: Record<string, unknown>, extra: unknown): Promise<MemoryToolResult> {
    const metadata = extra as { _meta?: Record<string, unknown>; signal?: AbortSignal } | undefined
    const id = metadata?._meta?.['claudecode/toolUseId']
    if (typeof id !== 'string' || !id || this.closed || metadata?.signal?.aborted) return unavailableHostCall()
    // The native MCP callback and stream are independent SDK channels.
    if (!this.calls.has(id)) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.changed.delete(check); metadata?.signal?.removeEventListener('abort', done); resolve() }
      const check = () => { if (this.closed || this.calls.has(id)) done() }
      const timer = setTimeout(done, 2_000)
      this.changed.add(check)
      metadata?.signal?.addEventListener('abort', done, { once: true })
      check()
    })
    const call = this.calls.get(id)
    if (this.closed || metadata?.signal?.aborted || !call?.prompt.active || call.name !== name) return unavailableHostCall()
    return call.prompt.dispatch(name, input, call.native, metadata?.signal)
  }
  close() {
    this.closed = true
    for (const prompt of this.prompts.values()) prompt.active = false
    for (const notify of this.changed) notify()
    this.prompts.clear()
    this.calls.clear()
  }
}
