import { describe, expect, test } from 'bun:test'
import { CleanContextEpochRequired, compileContext, contextIdentity, HOST_CONTRACT, type ContextCompilerInput } from './context-compiler'

function input(): ContextCompilerInput {
  return { epoch: 1, nativeSession: 'native-1', capabilityRevision: 2, policyRevision: 3,
    tools: [{ name: 'detail', description: 'Read current memory', schema: { type: 'object', properties: { id: { type: 'string' } } } }],
    view: { revision: 7, selectionRevision: 5, memories: [{ id: 'M-1', version: 1, content: 'Use the fixture', semantics: { conflicts: [] } }] } }
}
describe('ContextCompiler', () => {
  test('stable host/tool identity ignores JSON insertion order and dynamic view changes', () => {
    const first = compileContext(input())
    const changed = input()
    changed.view = { ...changed.view, revision: 8, memories: [{ id: 'M-2', version: 2, content: 'new' }] }
    changed.tools[0]!.schema = { properties: { id: { type: 'string' } }, type: 'object' }
    const next = compileContext(changed, first.nextBaseline)
    expect(next.stable).toEqual(first.stable)
    expect(next.append).toContain('"removals":[{"id":"M-1"')
    expect(next.append).toContain('"historyErased":false')
    expect(next.delivery).toBe('not-queued')
    expect(first.stable.contract).toBe(HOST_CONTRACT)
    expect(first.nextBaseline.view.memories[0]!.id).toBe('M-1')
    expect(contextIdentity({ a: 1, b: { c: 2 } })).toBe(contextIdentity({ b: { c: 2 }, a: 1 }))
  })
  test('unchanged turn is silent; relation-only and selection-only changes retain view identity', () => {
    const first = compileContext(input())
    expect(compileContext(input(), first.nextBaseline).append).toBe('')
    const changed = input()
    changed.view.revision = 8
    changed.view.memories[0]!.semantics = { conflicts: ['M-2'] }
    const second = compileContext(changed, first.nextBaseline)
    expect(second.append).toContain('"conflicts":["M-2"]')
    expect(second.append).toContain('"memoryViewRevision":8')
    changed.view.selectionRevision = 6
    expect(compileContext(changed, second.nextBaseline).append).toContain('"selectionRevision":6')
  })
  test('unaccepted plans do not change the delivery baseline', () => {
    const first = compileContext(input())
    const changed = input()
    changed.view.memories = []
    const rejected = compileContext(changed, first.nextBaseline)
    expect(compileContext(changed, first.nextBaseline).append).toBe(rejected.append)
    expect(first.nextBaseline.view.memories).toHaveLength(1)
  })
  test.each(['withdrawal', 'schema', 'capability'] as const)('%s requires a fresh epoch, never a resume of old history', reason => {
    const first = compileContext(input())
    const next = input()
    if (reason === 'withdrawal') next.strictWithdrawal = true
    if (reason === 'schema') next.tools[0]!.schema = { type: 'string' }
    if (reason === 'capability') next.capabilityRevision = 4
    expect(() => compileContext(next, first.nextBaseline)).toThrow(CleanContextEpochRequired)
    next.epoch = 2
    next.cleanEpoch = { nativeSession: 'native-1', history: 'fresh' }
    expect(() => compileContext(next, first.nextBaseline)).toThrow(CleanContextEpochRequired)
    next.nativeSession = 'native-2'
    next.cleanEpoch.nativeSession = 'native-2'
    expect(compileContext(next, first.nextBaseline).append).toContain('"epoch":2')
  })
})
