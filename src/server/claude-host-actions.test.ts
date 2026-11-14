import { expect, test } from 'bun:test'
import { ClaudeHostActions, type HostToolDispatch } from './claude-host-actions'
import { HOST_ACTION_TOOL_NAMES } from '../shared/host-actions'

const name = HOST_ACTION_TOOL_NAMES.openFile
const input = { path: 'README.md' }
const replay = (uuid: string) => ({ type: 'user', uuid, session_id: 'native-session', message: { content: 'synthetic prompt' }, isReplay: true })
const call = (id: string, parent_tool_use_id: string | null = null) => ({ type: 'assistant', session_id: 'native-session', parent_tool_use_id, message: { content: [{ type: 'tool_use', id, name: `mcp__memory__${name}` }] } })
const extra = (id: string, signal?: AbortSignal) => ({ _meta: { 'claudecode/toolUseId': id }, signal })
const status = async (result: ReturnType<ClaudeHostActions['dispatch']>) => JSON.parse((await result).text).status

test('Claude exact native IDs disambiguate identical concurrent input and survive callback/stream reordering', async () => {
  const bridge = new ClaudeHostActions(), observed: string[] = []
  const dispatch: HostToolDispatch = async (_name, _input, native) => {
    expect(Object.isFrozen(native)).toBe(true)
    expect(native).toMatchObject({ nativeSessionId: 'native-session', nativeTurnId: 'prompt-1' })
    observed.push(native.nativeToolCallId)
    return { text: JSON.stringify({ status: 'accepted' }) }
  }
  bridge.reserve('prompt-1', dispatch); bridge.observe(replay('prompt-1'))
  const second = bridge.dispatch(name, input, extra('call-2'))
  bridge.observe(call('call-1')); bridge.observe(call('call-2'))
  expect(await status(second)).toBe('accepted')
  expect(await status(bridge.dispatch(name, input, extra('call-1')))).toBe('accepted')
  expect(observed).toEqual(['call-2', 'call-1'])
  bridge.close()
})

test('Claude cancelled/completed calls cannot acquire a new prompt dispatch, even if their native frames repeat', async () => {
  const bridge = new ClaudeHostActions(), observed: string[] = []
  const dispatch = (turn: string): HostToolDispatch => async () => { observed.push(turn); return { text: '{"status":"accepted"}' } }
  bridge.reserve('old', dispatch('old')); bridge.observe(replay('old')); bridge.observe(call('old-call'))
  bridge.revoke('old')
  bridge.reserve('new', dispatch('new')); bridge.observe(replay('new')); bridge.observe(call('old-call')); bridge.observe(call('new-call'))
  expect(await status(bridge.dispatch(name, input, extra('old-call')))).toBe('unavailable')
  expect(await status(bridge.dispatch(name, input, extra('new-call')))).toBe('accepted')
  bridge.observe({ type: 'result', user_message_uuid: 'old' })
  expect(await status(bridge.dispatch(name, input, extra('new-call')))).toBe('accepted')
  bridge.observe({ type: 'result', user_message_uuid: 'new' })
  expect(await status(bridge.dispatch(name, input, extra('new-call')))).toBe('unavailable')
  expect(observed).toEqual(['new', 'new'])
  bridge.close()
})

test('Claude ignores model-supplied identity, unknown/native-control prompts, child calls and wrong tool names', async () => {
  const bridge = new ClaudeHostActions()
  bridge.reserve('known', async () => { throw new Error('Must not dispatch') })
  bridge.observe(replay('known')); bridge.observe(call('child', 'parent')); bridge.observe(replay('native-control')); bridge.observe(call('control'))
  expect(await status(bridge.dispatch(name, { ...input, nativeToolCallId: 'forged' }, {}))).toBe('unavailable')
  const abort = new AbortController()
  const pending = bridge.dispatch(name, input, extra('child', abort.signal)); abort.abort()
  expect(await status(pending)).toBe('unavailable')
  bridge.observe(replay('known')); bridge.observe(call('real'))
  expect(await status(bridge.dispatch(HOST_ACTION_TOOL_NAMES.actionStatus, input, extra('real')))).toBe('unavailable')
  const late = bridge.dispatch(name, input, extra('control')); bridge.close()
  expect(await status(late)).toBe('unavailable')
})
