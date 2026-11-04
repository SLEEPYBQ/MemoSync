import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCoordinator } from './agent'
import { EventStore } from './event-store'
import { MemoryService } from './memory'
import { buildMemoryToolSpecs } from './memory/tools'
import { discovery, type NativeCommandRuntime } from './command-registry'
import type { PreparedNativeContext } from './context-compiler'

for (const engine of ['claude', 'codex', 'pi', 'opencode'] as const) {
  test(`${engine} ordinary turn delivers stable schemas, effective policy and semantic memory revisions only on native receipt`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'memosync-normal-context-'))
    const store = new EventStore(join(root, 'data'))
    await store.initialize()
    const project = await store.openProject(root)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, engine)
    const memory = new MemoryService({ dbPath: join(root, 'memory.sqlite'), dataDir: join(root, 'memory') })
    const a = memory.store.create({ content: 'Keep native instructions.', scope: 'project', projectId: project.id, type: 'constraint' }, { actor: 'user' })
    const b = memory.store.create({ content: 'Use local fixtures.', scope: 'project', projectId: project.id, type: 'constraint' }, { actor: 'user' })
    const version = { claude: '2.1.318', codex: '0.166.0-alpha.6', pi: '1.5.0', opencode: '1.19.5' }[engine]
    const target = { nativeSession: `${engine}-session`, nativeInstance: `${engine}-instance`, version }
    const source = { api: 'synthetic-native-fixture', version, evidence: 'native-response' as const }
    const native: NativeCommandRuntime = { instance: target.nativeInstance, session: target.nativeSession, version, alive: () => true,
      discover: async () => ({ commands: discovery('ready', [], source), skills: discovery('ready', [], source), connectors: discovery('ready', [], source) }) }
    let prepared: PreparedNativeContext | undefined, finish: (() => void) | undefined, executionControl: any
    const stream = { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finish = resolve }) } }
    const turn = { provider: engine, stream, interrupt: async () => { finish?.() }, close: () => { finish?.() } }
    const startTurn = async (args: any) => {
      await args.onExecutionPolicyApplied?.(target.nativeSession)
      prepared = args.prepareContext(target)
      return turn
    }
    const coordinator = new AgentCoordinator({ store, memory, onStateChange() {},
      stableToolSchemas: () => [{ name: 'host.open', description: 'Open a workspace view', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
      resolvePiConnection: async () => ({ provider: 'custom', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic' }),
      startClaudeSession: async (args: any) => {
        executionControl = args.executionControl
        return { ...turn, provider: 'claude', commandRuntime: native, memoryPlan: args.memoryPlan,
          parentLaunch: { provider: 'claude', memorySpecs: buildMemoryToolSpecs(memory), options: { model: 'synthetic' } },
          setExecutionControl(control: unknown) { executionControl = control },
          sendPrompt: async (_text: string, context: any) => { await executionControl.onApplied(); prepared = context.prepareContext(target) },
          setModel: async () => {}, setPermissionMode: async () => {} } as never
      },
      codexManager: { startSession: async () => target.nativeSession, startTurn, getCommandRuntime: () => native, stopSession() {}, stopAll() {} } as never,
      piManager: { startTurn, getCommandRuntime: () => native, closeChat() {}, dispose() {} } as never,
      opencodeManager: { startTurn, getCommandRuntime: () => native, closeChat() {}, dispose() {} } as never,
    })
    try {
      const turnId = crypto.randomUUID()
      const policy = (coordinator as any).executionPolicyFor(chat.id, engine)
      const policyScope = (coordinator as any).harnessPolicies.beginTurn(chat.id, policy.policy, policy.revision, turnId, version)
      await (coordinator as any).bootEngineTurn({ chatId: chat.id, provider: engine, model: 'synthetic', effort: 'none', planMode: false,
        engineRuntime: { engine, executable: { state: 'ready', version }, env: { HOME: root }, args: [], model: 'synthetic', isolated: true },
        memoryState: { control: 'auto', memoryActive: true, learnActive: false }, attachments: [], content: 'Ordinary user request.', turnId, policyScope },
        { chat, project, turnNumber: 1, memoryDisabledForTurn: false })
      expect(prepared).toBeDefined()
      expect(prepared!.text).toContain('Preserve recognized user and project instructions')
      expect(prepared!.text).toContain('"name":"host.open"')
      expect(prepared!.text).toContain('"required":["path"]')
      expect(prepared!.text).toContain('"name":"load_memory_detail"')
      expect(prepared!.text).toContain('"policyRevision":1')
      expect(prepared!.text).toContain(`"nativeInstance":"${target.nativeInstance}"`)
      expect((coordinator as any).contextBaselines.has(chat.id)).toBe(false)
      prepared!.accepted()
      expect((coordinator as any).contextBaselines.get(chat.id).policyRevision).toBe(1)
      const compose = () => (coordinator as any).prepareCurrentContext(chat.id, target)
      // Use the same native declarations retained by the real adapters.
      if (engine !== 'claude') (coordinator as any).parentLaunches.set(chat.id, { provider: engine, ...(engine === 'codex'
        ? { session: { dynamicTools: (await import('./memory/codex-adapter')).toCodexDynamicTools(buildMemoryToolSpecs(memory)) } }
        : { options: { memorySpecs: buildMemoryToolSpecs(memory) } }) })
      expect(compose().text).toBe('')
      memory.store.addRelation(a.id, b.id, 'conflicts_with')
      const relation = compose()
      expect(relation.text).toContain(a.id)
      expect(relation.text).toContain('"version":1')
      relation.accepted()
      ;(coordinator as any).turnMemoryRestriction.set(chat.id, [a.id])
      expect(compose().text).toContain(`"id":"${b.id}","reason":"not-in-current-view"`)
      const withoutMemory = (coordinator as any).prepareCurrentContext(chat.id, target, { disabled: true })
      expect(withoutMemory.text).toContain('"availableHostTools":["host.open"]')
      withoutMemory.accepted()
      const withMemory = compose()
      expect(withMemory.text).toContain('"availableHostTools":["host.open","load_memory_detail"]')
      expect(withMemory.text).toContain(a.id)
      expect(coordinator.getCommandCatalog(chat.id).runtime).toMatchObject({ nativeSession: target.nativeSession, policyRevision: 1 })
    } finally {
      finish?.()
      await coordinator.closeChat(chat.id)
      memory.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
