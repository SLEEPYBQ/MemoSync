import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { createWsRouter } from "./ws-router"
import type { StartPiTurnArgs } from "./pi-agent"
import type { HarnessTurn } from "./harness-types"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean() })

async function setup(onStart?: (args: StartPiTurnArgs) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "memosync-policy-"))
  const store = new EventStore(join(dir, "data"))
  await store.initialize()
  const project = await store.openProject(dir)
  const chat = await store.createChat(project.id)
  await store.setChatProvider(chat.id, "pi")
  let launch!: StartPiTurnArgs
  let finish!: () => void
  let nativeLive = false
  const turn: HarnessTurn = {
    provider: "pi", interrupt: async () => { finish() }, close: () => { finish?.() },
    stream: { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finish = resolve }) } },
  }
  const coordinator = new AgentCoordinator({
    store, onStateChange() {}, resolvePiConnection: async () => ({ provider: "openrouter", baseUrl: "http://127.0.0.1:1", apiKey: "synthetic" }),
    piManager: {
      startTurn: async (args: StartPiTurnArgs) => { launch = args; await onStart?.(args); nativeLive = !args.signal?.aborted; return turn },
      getCommandRuntime: () => nativeLive ? { alive: () => nativeLive } : undefined,
      closeChat() { nativeLive = false }, dispose() { nativeLive = false },
    } as never,
    codexManager: { async stopSession() {}, async stopAll() {} } as never,
    opencodeManager: { closeChat() {}, dispose() {} } as never,
  })
  cleanups.push(async () => { await coordinator.closeChat(chat.id); await rm(dir, { recursive: true, force: true }) })
  const boot = () => {
    const turnId = crypto.randomUUID()
    const policy = (coordinator as any).executionPolicyFor(chat.id, "pi")
    const policyScope = (coordinator as any).harnessPolicies.beginTurn(chat.id, policy.policy, policy.revision, turnId, "1.5.0")
    return (coordinator as any).bootEngineTurn({ chatId: chat.id, provider: "pi", model: "synthetic", effort: "none", planMode: false, attachments: [], content: "synthetic turn", turnId, policyScope }, { chat, project, turnNumber: 1, memoryDisabledForTurn: true })
  }
  const finishTurn = async () => {
    finish()
    for (let i = 0; i < 100; i++) {
      if (!coordinator.activeTurns.has(chat.id)) return
      await Bun.sleep(1)
    }
    throw new Error("Turn did not finish")
  }
  return { store, coordinator, chat, boot, finishTurn, launch: () => launch }
}
async function pending(coordinator: AgentCoordinator, chatId: string) {
  for (let i = 0; i < 100; i++) {
    const value = coordinator.activeTurns.get(chatId)?.pendingTool
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error("Approval was not presented")
}

describe("coordinator execution policy", () => {
  test("Pi launch installs gate; desired does not become effective before adapter acknowledgement", async () => {
    const { coordinator, store, chat, boot, launch } = await setup()
    await boot()
    expect(coordinator.getHarnessSnapshot(chat.id)?.policy).toMatchObject({ status: "pending", effective: null })
    expect(launch().beforeToolCall).toBeFunction()
    await launch().onExecutionPolicyApplied?.("native-session")
    expect(coordinator.getHarnessSnapshot(chat.id)?.policy).toMatchObject({ status: "applied", effectiveRevision: 1 })
    const reloaded = new EventStore(store.dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).executionPolicyStates?.pi).toMatchObject({ effectiveRevision: 1, effective: { engine: "pi", toolGate: "ask" } })
    const restored = new AgentCoordinator({ store: reloaded, onStateChange() {} })
    expect(restored.getHarnessSnapshot(chat.id)?.policy).toMatchObject({ status: "pending", effective: null, effectiveRevision: null })
  })

  test("snapshots use native handles rather than saved tokens or host activity, and closing clears the acknowledgement", async () => {
    const { coordinator, store, chat, boot, launch, finishTurn } = await setup()
    await store.setSessionToken(chat.id, "saved-native-session")
    ;(coordinator as any).parentLaunches.set(chat.id, { provider: "pi" })
    ;(coordinator as any).startingChats.set(chat.id, "preparing")
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "absent", policy: { effective: null, status: "pending" } })
    ;(coordinator as any).startingChats.delete(chat.id)
    ;(coordinator as any).parentLaunches.delete(chat.id)

    await boot()
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "present", policy: { effective: null } })
    await launch().onExecutionPolicyApplied?.("native-session")
    await finishTurn()
    expect(coordinator.activeTurns.has(chat.id)).toBe(false)
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "present", policy: { status: "applied", effectiveRevision: 1 } })

    await coordinator.closeChat(chat.id)
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "absent", policy: { status: "pending", effective: null, effectiveRevision: null } })
    expect(store.requireChat(chat.id).sessionToken).toBe("saved-native-session")
    expect(store.requireChat(chat.id).executionPolicyStates?.pi).toMatchObject({ status: "pending", effective: null, effectiveRevision: null })
  })

  test("changing an idle native handle retains descendant-process uncertainty", async () => {
    const { coordinator, chat, boot, launch, finishTurn } = await setup()
    await boot()
    await launch().onExecutionPolicyApplied?.("native-session")
    await finishTurn()
    // Parent-launch metadata can be absent while the adapter still owns a session.
    ;(coordinator as any).parentLaunches.delete(chat.id)
    const state = await coordinator.setExecutionPolicy({ type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    expect(state).toMatchObject({ status: "partial", effective: null, effectiveRevision: null })
    expect(state.boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
    expect(coordinator.getHarnessSnapshot(chat.id)?.nativeRuntime).toBe("absent")
  })

  test("a closing native handle keeps its old acknowledgement until it disappears, then the next turn can apply the policy", async () => {
    const { coordinator, chat, boot, launch, finishTurn } = await setup()
    await boot()
    await launch().onExecutionPolicyApplied?.("old-native")
    await finishTurn()
    const manager = (coordinator as any).piManager
    const closeChat = manager.closeChat
    manager.closeChat = () => {}
    try {
      const pending = await coordinator.setExecutionPolicy({ type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
      expect(pending).toMatchObject({ status: "partial", desiredRevision: 2, effectiveRevision: 1 })
      expect(coordinator.getHarnessSnapshot(chat.id)?.nativeRuntime).toBe("present")
    } finally {
      manager.closeChat = closeChat
      manager.closeChat(chat.id)
    }
    // Admission must reconcile completed retirement even without an intervening UI read.
    await boot()
    await launch().onExecutionPolicyApplied?.("fresh-native")
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "present", policy: { status: "partial", effectiveRevision: 2 } })
  })

  test("approval contains arguments and authorizes only one call; duplicate replies are rejected", async () => {
    const { coordinator, chat, boot, launch } = await setup()
    await boot()
    const first = launch().beforeToolCall!("bash", { command: "touch exact-file" })
    const ui = await pending(coordinator, chat.id)
    expect(ui.tool.toolKind).toBe("ask_user_question")
    const question = (ui.tool.input as any).questions[0].question
    expect(question).toContain("touch exact-file")
    const command = { type: "chat.respondTool" as const, chatId: chat.id, toolUseId: ui.toolUseId, result: { answers: { [question]: "Allow once" } } }
    const responses = await Promise.allSettled([coordinator.respondTool(command), coordinator.respondTool(command)])
    expect(responses.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(await first).toBeUndefined()
    const second = launch().beforeToolCall!("bash", { command: "touch different-file" })
    const next = await pending(coordinator, chat.id)
    expect(next.toolUseId).not.toBe(ui.toolUseId)
    await coordinator.cancel(chat.id)
    expect(await second).toMatchObject({ block: true })
    await expect(coordinator.respondTool(command)).rejects.toThrow()
  })

  test("tightening revokes waiting and future calls immediately, persists process uncertainty across restart", async () => {
    const { coordinator, store, chat, boot, launch } = await setup()
    await boot()
    await launch().onExecutionPolicyApplied?.("native")
    const gate = launch().beforeToolCall!
    const waiting = gate("bash", { command: "write" })
    await pending(coordinator, chat.id)
    const changed = coordinator.setExecutionPolicy({ type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    expect(await gate("read", {})).toMatchObject({ block: true })
    expect(await waiting).toMatchObject({ block: true })
    const state = await changed
    expect(state).toMatchObject({ status: "partial", desiredRevision: 2, effectiveRevision: null })
    const reloaded = new EventStore(store.dataDir)
    await reloaded.initialize()
    const restored = new AgentCoordinator({ store: reloaded, onStateChange() {} })
    expect(restored.getHarnessSnapshot(chat.id)?.policy).toMatchObject({ status: "unknown", desiredRevision: 2, effectiveRevision: null })
    expect(restored.getHarnessSnapshot(chat.id)?.policy.boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
    await boot()
    await launch().onExecutionPolicyApplied?.("fresh-native")
    expect(await launch().beforeToolCall!("bash", { command: "write under new policy" })).toMatchObject({ block: true })
    expect(await launch().beforeToolCall!("read", {})).toBeUndefined()
    expect(coordinator.getHarnessSnapshot(chat.id)?.policy).toMatchObject({ status: "partial", effectiveRevision: 2 })
    expect(coordinator.getHarnessSnapshot(chat.id)?.policy.boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
  })

  test("tightening during startup aborts native dispatch before it can register a stale turn", async () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { coordinator, chat, boot, launch } = await setup(async () => { entered(); await gate })
    const starting = boot()
    await ready
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "starting", policy: { effective: null, effectiveRevision: null } })
    const changed = coordinator.setExecutionPolicy({ type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    expect(launch().signal?.aborted).toBe(true)
    await changed
    release()
    await starting
    expect(coordinator.activeTurns.has(chat.id)).toBe(false)
    expect(coordinator.getHarnessSnapshot(chat.id)).toMatchObject({ nativeRuntime: "absent", policy: { status: "partial", effective: null, effectiveRevision: null } })
  })

  test("WS exposes verified capabilities and acknowledges desired policy before native application", async () => {
    const { coordinator, store, chat } = await setup()
    const router = createWsRouter({ store, agent: coordinator, terminals: { onEvent: () => () => {} } as never, keybindings: { onChange: () => () => {} } as never, refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "synthetic", updateManager: null })
    const sent: any[] = []
    const ws = { data: { subscriptions: new Map(), protectedDraftChatIds: new Set<string>() }, send(text: string) { sent.push(JSON.parse(text)); return text.length } }
    const command = (id: string, value: unknown) => router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id, command: value }))
    const fresh = await store.createChat(chat.projectId)
    await command("fresh", { type: "chat.readHarness", chatId: fresh.id, engine: "pi" })
    expect(sent.at(-1)).toMatchObject({ type: "ack", id: "fresh", result: { capabilities: { engine: "pi" }, policy: { desired: { engine: "pi", toolGate: "ask" }, effective: null } } })
    expect(store.requireChat(fresh.id).provider).toBeNull()
    await command("caps", { type: "harness.getCapabilities", engine: "pi" })
    expect(sent.at(-1)).toMatchObject({ type: "ack", id: "caps", result: { engine: "pi", executionPolicies: expect.arrayContaining([expect.objectContaining({ boundary: "tool-gating", availability: "available" })]) } })
    await command("set", { type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    expect(sent.at(-1)).toMatchObject({ type: "ack", id: "set", result: { desiredRevision: 2, effective: null, effectiveRevision: null, status: "pending" } })
    await command("stale", { type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "allow" }, expectedRevision: 1 })
    expect(sent.at(-1)).toMatchObject({ type: "error", id: "stale" })
  })

  test("policy revisions survive compaction; forks copy desired selection without claiming the parent's effective runtime", async () => {
    const { coordinator, store, chat } = await setup()
    await coordinator.setExecutionPolicy({ type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    await store.setSessionToken(chat.id, "parent-native")
    const fork = await store.forkChat(chat.id)
    expect(fork.executionPolicyVersion).toBe(1)
    expect(fork.executionPolicies?.pi).toMatchObject({ revision: 2, policy: { toolGate: "read-only" } })
    expect(fork.executionPolicyStates?.pi).toBeUndefined()
    await store.compact()
    const reloaded = new EventStore(store.dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).executionPolicyStates?.pi).toMatchObject({ desiredRevision: 2, effectiveRevision: null })
    expect(reloaded.requireChat(fork.id).executionPolicies?.pi?.revision).toBe(2)
  })

  test("an explicit policy change opts a legacy chat in and persists that opt-in", async () => {
    const { coordinator, store, chat, boot, launch } = await setup()
    delete chat.executionPolicyVersion
    await coordinator.setExecutionPolicy({ type: "chat.setExecutionPolicy", chatId: chat.id, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    expect(store.requireChat(chat.id).executionPolicyVersion).toBe(1)
    await boot()
    expect(await launch().beforeToolCall!("bash", { command: "synthetic" })).toMatchObject({ block: true })
    await store.compact()
    const reloaded = new EventStore(store.dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).executionPolicyVersion).toBe(1)
    expect(reloaded.requireChat(chat.id).executionPolicies?.pi?.revision).toBe(2)
  })

  test("existing chats without a version retain legacy Pi tool authorization", async () => {
    const { coordinator, chat, boot, launch } = await setup()
    delete chat.executionPolicyVersion
    await boot()
    expect(await launch().beforeToolCall!("bash", { command: "legacy" })).toBeUndefined()
    expect(coordinator.getHarnessSnapshot(chat.id)?.policy.desired).toEqual({ engine: "pi", toolGate: "allow" })
  })
})
