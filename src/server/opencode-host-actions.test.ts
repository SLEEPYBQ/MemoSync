import { expect, test } from 'bun:test'
import { access, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createOpencodeHostPlugin } from './opencode-host-actions'
import { createOpencodeMemoryMcp, OPENCODE_HOST_TICKET } from './memory/opencode-adapter'
import { hostActionToolSpecs } from './host-actions'
import { HOST_ACTION_TOOL_NAMES, type HostNativeToolContext } from '../shared/host-actions'

const name = HOST_ACTION_TOOL_NAMES.openFile
const native = Object.freeze({ engineInstanceId: 'native-instance', nativeSessionId: 'native-session', nativeTurnId: 'native-turn', nativeToolCallId: 'native-call' })
const input = { path: 'README.md' }
const invoke = async (bridge: ReturnType<typeof createOpencodeMemoryMcp>, args: Record<string, unknown>, tool = name) => {
  const response = await fetch(bridge.config.url, { method: 'POST', headers: bridge.config.headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) })
  const body = await response.json() as { result: { content: { text: string }[] } }
  return JSON.parse(body.result.content[0]!.text)
}

test('OpenCode native plugin binds exact call identity; ordinary MCP cannot mint tickets or change their input', async () => {
  const observed: HostNativeToolContext[] = []
  const bridge = createOpencodeMemoryMcp(hostActionToolSpecs())
  const plugin = await createOpencodeHostPlugin(bridge.nativeConfig)
  bridge.setDispatch(async (_name, _args, _signal, context) => { observed.push(context!); return { text: '{"status":"accepted"}' } },
    async (tool, context) => tool === name && context.callID === native.nativeToolCallId && context.sessionID === native.nativeSessionId ? native : undefined)
  try {
    expect((await stat(fileURLToPath(plugin.url))).mode & 0o777).toBe(0o600)
    const hook = (await (await import(plugin.url)).default())['tool.execute.before']
    const output = { args: { ...input, [OPENCODE_HOST_TICKET]: 'model-chosen' } }
    await hook({ tool: `memosync_${name}`, sessionID: native.nativeSessionId, callID: native.nativeToolCallId }, output)
    expect(output.args[OPENCODE_HOST_TICKET]).not.toBe('model-chosen')
    expect(await invoke(bridge, output.args)).toMatchObject({ status: 'accepted' })
    expect(await invoke(bridge, output.args)).toMatchObject({ status: 'accepted' })
    expect(observed).toEqual([native, native])
    expect(await invoke(bridge, { ...output.args, path: 'changed.md' })).toMatchObject({ status: 'unavailable' })
    expect(await invoke(bridge, { ...input, nativeSessionId: native.nativeSessionId, nativeToolCallId: native.nativeToolCallId })).toMatchObject({ status: 'unavailable' })
    const forged = await fetch(bridge.nativeConfig.url, { method: 'POST', headers: bridge.config.headers, body: JSON.stringify({ name, args: input, ...native }) })
    expect(forged.status).toBe(401)
    bridge.setDispatch(async () => { throw new Error('Old ticket reached the replacement turn') })
    expect(await invoke(bridge, output.args)).toMatchObject({ status: 'unavailable' })
    const other = { args: { ...input, [OPENCODE_HOST_TICKET]: 'model-chosen' } }
    await hook({ tool: `memosync_${name}`, sessionID: 'child-session', callID: 'child-call' }, other)
    expect(other.args).not.toHaveProperty(OPENCODE_HOST_TICKET)
  } finally { bridge.close(); await plugin.close() }
  await expect(access(fileURLToPath(plugin.url))).rejects.toThrow()
})

test('OpenCode a native binding that completes after dispatch replacement cannot authorize the new turn', async () => {
  const bridge = createOpencodeMemoryMcp(hostActionToolSpecs())
  let release!: (value: HostNativeToolContext) => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  bridge.setDispatch(async () => ({ text: 'old' }), async () => { entered(); return new Promise(resolve => { release = resolve }) })
  try {
    const pending = fetch(bridge.nativeConfig.url, { method: 'POST', headers: { Authorization: bridge.nativeConfig.authorization },
      body: JSON.stringify({ name, args: input, sessionID: native.nativeSessionId, callID: native.nativeToolCallId }) })
    await waiting
    bridge.setDispatch(async () => ({ text: 'new' }), async () => native)
    release(native)
    expect(await (await pending).json()).toEqual({ unavailable: true })
  } finally { bridge.close() }
})
