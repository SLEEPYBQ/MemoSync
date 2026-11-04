import { describe, expect, test } from 'bun:test'
import { CommandRegistry, commandRuntimeKey, discovery, type NativeCommandDiscovery, type NativeCommandRuntime } from './command-registry'
import type { CommandRuntimeIdentity, RuntimeCommand } from '../shared/runtime-commands'
const source = { api: 'fixture/native', version: '1', evidence: 'native-response' as const }
const entry: RuntimeCommand = { id: 'native:fixture', name: 'fixture', description: 'Fixture command', namespace: 'native', owner: 'native-engine', arguments: { type: 'string' }, requiresIdle: true, sideEffect: 'model-turn', route: 'native-prompt', source, requiredRuntimeVersion: '1' }
function result(items = [entry]): NativeCommandDiscovery {
  return { commands: discovery('ready', items, source), skills: discovery('ready', [], source), connectors: discovery('ready', [], source) }
}
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve() }
function setup(overrides: Partial<NativeCommandRuntime> = {}, busy = () => false) {
  const native: NativeCommandRuntime = { instance: 'instance-1', session: 'session-1', version: '1', alive: () => true, discover: async () => result(), ...overrides }
  const identity: CommandRuntimeIdentity = { engine: 'pi', nativeInstance: native.instance, nativeSession: native.session, version: native.version, profile: '/temp/profile', workspace: '/temp/project', mode: 'normal' }
  const submissions: unknown[] = []
  const registry = new CommandRegistry(() => {})
  const binding = { identity, native, busy, restoreText: () => 'current-view', submit: async (command: RuntimeCommand, args: string) => { submissions.push({ command, args }); return { chatId: 'chat' } } }
  registry.bind('chat', binding)
  return { registry, binding, submissions }
}
async function execute(s: ReturnType<typeof setup>, commandId = 'native:compact', args?: string) {
  await s.registry.refresh('chat')
  const snapshot = s.registry.snapshot('chat')
  return s.registry.execute({ type: 'chat.executeCommand', chatId: 'chat', commandId, arguments: args, runtimeKey: snapshot.runtimeKey!, expectedRevision: snapshot.revision })
}
describe('runtime command registry', () => {
  test('successful EMPTY discovery invalidates old executable commands; failed is distinct', async () => {
    let response = result()
    const s = setup({ discover: async () => response })
    await s.registry.refresh('chat')
    const old = s.registry.snapshot('chat')
    response = result([])
    await s.registry.refresh('chat')
    expect(s.registry.snapshot('chat').commands).toMatchObject({ status: 'ready', items: [] })
    expect(s.registry.snapshot('chat').revision).toBeGreaterThan(old.revision)
    await expect(s.registry.execute({ type: 'chat.executeCommand', chatId: 'chat', commandId: entry.id, runtimeKey: old.runtimeKey!, expectedRevision: old.revision })).rejects.toThrow('changed')
    s.binding.native.discover = async () => { throw new Error('protocol failed') }
    await s.registry.refresh('chat')
    expect(s.registry.snapshot('chat').commands).toMatchObject({ status: 'failed', items: [] })
  })
  test('each identity dimension invalidates the runtime key', () => {
    const { binding } = setup()
    for (const field of ['engine', 'nativeInstance', 'nativeSession', 'version', 'profile', 'workspace', 'mode'] as const) {
      expect(commandRuntimeKey({ ...binding.identity, [field]: 'changed' } as CommandRuntimeIdentity)).not.toBe(commandRuntimeKey(binding.identity))
    }
  })
  test('late discovery cannot repopulate an invalidated or replaced native instance', async () => {
    const old = deferred<NativeCommandDiscovery>()
    const s = setup({ discover: () => old.promise })
    s.registry.invalidate('chat')
    s.binding.native.discover = async () => result([])
    await s.registry.refresh('chat')
    old.resolve(result())
    await settle()
    expect(s.registry.snapshot('chat').commands.items).toEqual([])
  })
  test('discovered commands dispatch to the normal validated turn seam', async () => {
    const s = setup()
    await execute(s, entry.id, 'file with spaces')
    expect(s.submissions).toEqual([{ command: entry, args: 'file with spaces' }])
  })
  test('busy execution never compacts or submits a model turn', async () => {
    let calls = 0
    const s = setup({ compact: async () => { calls++ }, restore: async () => ({ delivery: 'native-accepted' }) }, () => true)
    await expect(execute(s)).rejects.toThrow('busy')
    expect(s.registry.snapshot('chat').compact.status).toBe('busy')
    expect(calls).toBe(0)
    expect(s.submissions).toEqual([])
  })
  test('compact completion waits for native completion AND successful current-view append', async () => {
    const compact = deferred(), restored = deferred<{ delivery: 'native-accepted' }>()
    const seen: string[] = []
    const s = setup({ compact: () => compact.promise, restore: text => { seen.push(text); return restored.promise } })
    await execute(s)
    expect(s.registry.snapshot('chat').operation).toMatchObject({ status: 'running', phase: 'native', contextRestored: false })
    compact.resolve()
    await settle()
    expect(s.registry.snapshot('chat').operation).toMatchObject({ status: 'running', phase: 'restoring', contextRestored: false })
    expect(seen).toEqual(['current-view'])
    restored.resolve({ delivery: 'native-accepted' })
    await settle()
    expect(s.registry.snapshot('chat').operation).toMatchObject({ status: 'completed', phase: 'settled', contextRestored: true })
    expect(s.submissions).toEqual([])
  })
  test.each(['failed', 'queued'] as const)('restoration %s cannot claim context restored', async kind => {
    const s = setup({ compact: async () => {}, restore: async () => { if (kind === 'failed') throw new Error('append failed'); return { delivery: 'queued' } } })
    await execute(s)
    await settle()
    expect(s.registry.snapshot('chat').operation).toMatchObject({ status: 'failed', contextRestored: false })
  })
  test('cancellation reaches the native API and does not restore after a late compact result', async () => {
    const compact = deferred()
    let cancels = 0, restores = 0
    const s = setup({ compact: () => compact.promise, cancel: async () => { cancels++ }, restore: async () => { restores++; return { delivery: 'native-accepted' } } })
    await execute(s)
    await s.registry.cancel('chat', s.registry.snapshot('chat').operation!.id)
    compact.resolve()
    await settle()
    expect(cancels).toBe(1)
    expect(restores).toBe(0)
    expect(s.registry.snapshot('chat').operation).toMatchObject({ status: 'cancelled', contextRestored: false })
  })
  test('view changes while reinjection is pending never report the latest view restored', async () => {
    const append = deferred<{ delivery: 'native-accepted' }>()
    let view = 'view-1'
    const s = setup({ compact: async () => {}, restore: () => append.promise })
    s.binding.restoreText = () => view
    // Rebind a fresh instance so the callback is captured with this view source.
    s.registry.bind('chat', { ...s.binding, identity: { ...s.binding.identity, nativeInstance: 'replacement' } })
    await execute(s)
    await settle()
    view = 'view-2'
    append.resolve({ delivery: 'native-accepted' })
    await settle()
    expect(s.registry.snapshot('chat').operation).toMatchObject({ status: 'failed', contextRestored: false })
  })
  test('native abort must settle before admitting a new turn', async () => {
    const stop = deferred()
    const s = setup({ compact: () => new Promise(() => {}), restore: async () => ({ delivery: 'native-accepted' }), cancel: () => stop.promise })
    await execute(s)
    const cancelling = s.registry.cancel('chat', s.registry.snapshot('chat').operation!.id)
    await settle()
    expect(s.registry.isRunning('chat')).toBe(true)
    stop.resolve()
    await cancelling
    await settle()
    expect(s.registry.isRunning('chat')).toBe(false)
    expect(s.registry.snapshot('chat').operation!.status).toBe('cancelled')
  })
  test('missing restoration API is explicitly unsupported and no compact route is advertised', async () => {
    const s = setup({ compact: async () => {}, discover: async () => result([{ ...entry, name: 'compact', id: 'native:compact' }]) })
    await s.registry.refresh('chat')
    expect(s.registry.snapshot('chat').compact.status).toBe('unsupported')
    expect(s.registry.snapshot('chat').commands.items).toEqual([])
    await expect(execute(s)).rejects.toThrow('unavailable')
    expect(s.submissions).toEqual([])
  })
})
