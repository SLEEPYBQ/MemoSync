import type { ChatCommandCatalog, CommandRuntimeIdentity, ExecuteRuntimeCommand, RuntimeCommand, RuntimeConnector, RuntimeDiscovery, RuntimeSkill, RuntimeSourceProof } from "../shared/runtime-commands"
import { contextIdentity } from "./context-compiler"

export interface NativeCommandDiscovery {
  commands: RuntimeDiscovery<RuntimeCommand>
  skills: RuntimeDiscovery<RuntimeSkill>
  connectors: RuntimeDiscovery<RuntimeConnector>
}
export interface NativeCommandRuntime {
  instance: string
  session: string
  version: string
  profile?: string
  alive(): boolean
  discover(): Promise<NativeCommandDiscovery>
  compactSource?: RuntimeSourceProof
  compact?: (signal: AbortSignal) => Promise<void>
  restore?: (text: string, signal: AbortSignal) => Promise<{ delivery: "queued" | "native-accepted" }>
  cancel?: () => Promise<void>
  /** A native reload/commands_changed event invalidates the current registry, including an empty response. */
  onChanged?: (listener: () => void) => () => void
}
interface Binding {
  identity: CommandRuntimeIdentity
  native: NativeCommandRuntime
  snapshot: ChatCommandCatalog
  busy: () => boolean
  restoreText: () => string
  contextAccepted?: (text: string) => void
  invalidateContext?: () => void
  submit: (command: RuntimeCommand, args: string, hostClientId?: string) => Promise<unknown>
  generation: number
  refresh?: Promise<ChatCommandCatalog>
  controller?: AbortController
  cancellation?: Promise<void>
  unsubscribe?: () => void
}
export function commandRuntimeKey(identity: CommandRuntimeIdentity): string { return contextIdentity(identity) }
export function discovery<T>(status: RuntimeDiscovery<T>["status"], items: T[], source: RuntimeSourceProof, reason?: string): RuntimeDiscovery<T> {
  return { status, items, source, ...(reason ? { reason } : {}) }
}
export function emptyCommandCatalog(): ChatCommandCatalog {
  const source: RuntimeSourceProof = { api: "native-session", version: "unknown", evidence: "public-api" }
  return { runtime: null, runtimeKey: null, revision: 0, commands: discovery("unknown", [], source), skills: discovery("unknown", [], source),
    connectors: discovery("unknown", [], source), compact: { status: "unknown", reason: "Start a native session to discover its APIs" }, operation: null }
}
async function withCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new Error('Native command cancelled')); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([work, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}
export class CommandRegistry {
  private bindings = new Map<string, Binding>()
  private retiredOperations = new Map<string, NonNullable<ChatCommandCatalog['operation']>>()
  private revision = 0
  constructor(private changed: (chatId: string) => void) {}
  bind(chatId: string, input: Omit<Binding, "snapshot" | "generation">) {
    const previous = this.bindings.get(chatId)
    const key = commandRuntimeKey(input.identity)
    if (previous?.snapshot.runtimeKey === key && previous.native === input.native) return
    this.unbind(chatId)
    const snapshot = { ...emptyCommandCatalog(), runtime: input.identity, runtimeKey: key, revision: ++this.revision }
    const binding: Binding = { ...input, snapshot, generation: 0 }
    this.bindings.set(chatId, binding)
    binding.unsubscribe = input.native.onChanged?.(() => { this.invalidate(chatId); void this.refresh(chatId).catch(() => {}) })
    void this.refresh(chatId).catch(() => {})
  }
  unbind(chatId: string) {
    const old = this.bindings.get(chatId)
    old?.controller?.abort()
    old?.unsubscribe?.()
    if (old?.snapshot.operation) this.retiredOperations.set(chatId, { ...old.snapshot.operation,
      ...(old.snapshot.operation.status === 'running' ? { status: 'cancelled', phase: 'settled', contextRestored: false, reason: 'Native instance retired; history may already have been compacted' } : {}) })
    this.bindings.delete(chatId)
    if (old?.controller) void old.native.cancel?.().catch(() => {})
  }
  invalidate(chatId: string) {
    const b = this.bindings.get(chatId)
    if (!b) return
    b.generation++
    b.refresh = undefined
    b.snapshot.revision = ++this.revision
    for (const category of ["commands", "skills", "connectors"] as const) b.snapshot[category] = { ...b.snapshot[category], status: "stale", items: [] }
    this.changed(chatId)
  }
  snapshot(chatId: string): ChatCommandCatalog {
    const b = this.bindings.get(chatId)
    if (!b) return { ...emptyCommandCatalog(), operation: structuredClone(this.retiredOperations.get(chatId) ?? null) }
    if (!b.native.alive()) { this.unbind(chatId); return this.snapshot(chatId) }
    const snapshot = structuredClone(b.snapshot)
    snapshot.compact = !b.native.compact || !b.native.restore ? { status: "unsupported", reason: "No verified compact and context append APIs for this native session/version" }
      : { status: b.controller || b.busy() ? "busy" : "available" }
    return snapshot
  }
  isRunning(chatId: string) { return Boolean(this.bindings.get(chatId)?.controller) }
  async refresh(chatId: string): Promise<ChatCommandCatalog> {
    const b = this.bindings.get(chatId)
    if (!b) return emptyCommandCatalog()
    if (b.refresh) return b.refresh
    const generation = b.generation
    const pending = (async () => {
      try {
        const result = await b.native.discover()
        if (this.bindings.get(chatId) === b && generation === b.generation && b.native.alive()) {
          Object.assign(b.snapshot, result)
          // A native /compact name must never fall through to ordinary chat capture when its control route is unsupported.
          b.snapshot.commands = { ...result.commands, items: result.commands.items.filter(c => c.name !== 'compact') }
          if (b.native.compact && b.native.restore) {
            const source: RuntimeSourceProof = b.native.compactSource ?? { api: `${b.identity.engine}:native-compact`, version: b.identity.version, evidence: "public-api" }
            // Compact is a separately proven control API; a successful empty slash list still replaces all old slash entries.
            b.snapshot.commands.items = [...result.commands.items.filter(c => c.name !== "compact"), { id: "native:compact", name: "compact", description: "Compact the native session context", namespace: "native", owner: "native-engine", arguments: { type: "string" }, requiresIdle: true, sideEffect: "context-compaction", route: "compact", source, requiredRuntimeVersion: b.identity.version }]
          }
          b.snapshot.revision = ++this.revision
          this.changed(chatId)
        }
      } catch {
        if (this.bindings.get(chatId) === b && generation === b.generation) {
          for (const category of ["commands", "skills", "connectors"] as const) b.snapshot[category] = { ...b.snapshot[category], status: "failed", items: [], reason: "Native discovery failed" }
          b.snapshot.revision = ++this.revision
          this.changed(chatId)
        }
      }
      return this.snapshot(chatId)
    })()
    b.refresh = pending
    try { return await pending } finally { if (b.refresh === pending) b.refresh = undefined }
  }
  async execute(command: ExecuteRuntimeCommand, hostClientId?: string): Promise<unknown> {
    const b = this.bindings.get(command.chatId)
    if (!b || !b.native.alive()) throw new Error("Native session unavailable")
    if (b.snapshot.runtimeKey !== command.runtimeKey || b.snapshot.revision !== command.expectedRevision) throw new Error("Command catalog changed; refresh before executing")
    const entry = b.snapshot.commands.items.find(c => c.id === command.commandId)
    if (!entry || entry.route !== 'compact' && b.snapshot.commands.status !== "ready") throw new Error("Command unavailable in the current native session")
    if (entry.requiredRuntimeVersion !== b.identity.version) throw new Error('Command capability version changed')
    if (typeof command.arguments !== "undefined" && typeof command.arguments !== "string") throw new Error("Command arguments must be a string")
    if ((command.arguments?.length ?? 0) > 32_768) throw new Error("Command arguments are too long")
    if (b.controller || b.busy()) throw new Error("Chat is busy; wait for its native turn to finish")
    if (entry.route !== "compact") return b.submit(entry, command.arguments ?? "", hostClientId)
    if (command.arguments?.trim()) throw new Error("Compact does not accept free-form instructions")
    if (!b.native.compact || !b.native.restore) throw new Error("Native compaction or context restoration unsupported")
    const controller = new AbortController()
    b.controller = controller
    const operation = { id: crypto.randomUUID(), commandId: entry.id, status: "running" as const, phase: "native" as const, contextRestored: false }
    b.snapshot.operation = operation
    b.invalidateContext?.()
    this.changed(command.chatId)
    void (async () => {
      const update = (patch: Partial<NonNullable<ChatCommandCatalog["operation"]>>) => {
        if (this.bindings.get(command.chatId) !== b) return
        Object.assign(operation, patch)
        this.changed(command.chatId)
      }
      try {
        await withCancellation(b.native.compact!(controller.signal), controller.signal)
        controller.signal.throwIfAborted()
        update({ phase: "restoring" })
        const restoredText = b.restoreText()
        const receipt = await withCancellation(b.native.restore!(restoredText, controller.signal), controller.signal)
        controller.signal.throwIfAborted()
        if (receipt.delivery !== "native-accepted") throw new Error("Context append queued without native acceptance")
        if (b.restoreText() !== restoredText) throw new Error('Current context view changed during restoration')
        b.contextAccepted?.(restoredText)
        update({ status: "completed", phase: "settled", contextRestored: true, delivery: receipt.delivery })
        this.invalidate(command.chatId)
        await this.refresh(command.chatId)
      } catch {
        update({ status: controller.signal.aborted ? "cancelled" : "failed", phase: "settled", contextRestored: false,
          reason: controller.signal.aborted ? "Cancelled; native history may already have been compacted" : "Native compact or context restoration failed; context is not confirmed restored" })
      } finally {
        // Do not admit a new user turn while the native abort is still settling.
        let stopped = true
        try { await b.cancellation } catch {
          stopped = false
          update({ status: 'failed', phase: 'settled', contextRestored: false, reason: 'Native cancellation was not confirmed; retry cancellation or restart the native session' })
        }
        if (stopped && b.controller === controller) b.controller = undefined
        b.cancellation = undefined
        this.changed(command.chatId)
      }
    })()
    return { chatId: command.chatId, operationId: operation.id }
  }
  async cancel(chatId: string, operationId: string) {
    const b = this.bindings.get(chatId)
    if (!b?.controller || b.snapshot.operation?.id !== operationId) throw new Error("Command operation is no longer running")
    b.cancellation ??= Promise.resolve().then(() => b.native.cancel?.())
    b.controller.abort()
    await b.cancellation
    if (b.snapshot.operation.status !== 'running' && b.controller?.signal.aborted) b.controller = undefined
    this.changed(chatId)
  }
  dispose() { for (const id of this.bindings.keys()) this.unbind(id) }
}
