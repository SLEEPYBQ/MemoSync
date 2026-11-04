import type { HostActionRequested, HostActionWorkbenchController, HostFileSnapshot } from "../../shared/host-actions"

export interface ReadonlySnapshotTab {
  request: HostActionRequested
  snapshot: HostFileSnapshot
  viewInstanceId: string
  signal: AbortSignal
}
type Presentation = Awaited<ReturnType<HostActionWorkbenchController["presentReadonlySnapshot"]>>
interface WorkbenchState { tabs: readonly ReadonlySnapshotTab[]; activeId: string | null }
const EMPTY_STATE: WorkbenchState = { tabs: [], activeId: null }

/** Separate from editable buffers: an operation can acknowledge only its own immutable bytes. */
export class HostFileWorkbench implements HostActionWorkbenchController {
  private state: WorkbenchState = EMPTY_STATE
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, { promise: Promise<Presentation>; resolve: (value: Presentation) => void; reject: (error: Error) => void }>()
  private readonly receipts = new Map<string, Presentation>()
  private readonly stopped = new Set<string>()
  private disposed = false

  constructor(
    readonly chatId: string,
    readonly projectId: string,
    private readonly navigate: () => void,
    private readonly isCurrent: (request: HostActionRequested) => boolean,
  ) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.state
  getServerSnapshot = () => EMPTY_STATE
  private publish(state: WorkbenchState) { this.state = state; for (const listener of this.listeners) listener() }

  private eligible(request: HostActionRequested, signal: AbortSignal) {
    return !this.disposed && !signal.aborted && !this.stopped.has(request.operationId) && request.chatId === this.chatId
      && request.action.workspaceRef === this.projectId && request.expiresAt > Date.now() && this.isCurrent(request)
  }

  async presentReadonlySnapshot(request: HostActionRequested, snapshot: HostFileSnapshot, signal: AbortSignal): Promise<Presentation> {
    const receipt = this.receipts.get(request.operationId)
    if (receipt) return receipt // A duplicate never changes the active tab.
    const pending = this.pending.get(request.operationId)
    if (pending) return pending.promise
    if (!this.eligible(request, signal)) throw new Error("Host file action is no longer current")
    const bytes = new TextEncoder().encode(snapshot.content)
    if (bytes.byteLength > 2 * 1024 * 1024 || bytes.byteLength !== snapshot.byteLength
      || snapshot.version !== request.snapshot.version || snapshot.digest !== request.snapshot.digest
      || snapshot.byteLength !== request.snapshot.byteLength || snapshot.mediaType !== request.snapshot.mediaType
      || snapshot.origin !== "snapshot") throw new Error("Host file snapshot does not match the requested version")
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")
    if (hash !== snapshot.digest || !this.eligible(request, signal)) throw new Error("Host file snapshot changed or is no longer current")
    // Digest verification can yield. Another delivery may have admitted the operation meanwhile.
    const admitted = this.pending.get(request.operationId)
    if (admitted) return admitted.promise
    const completed = this.receipts.get(request.operationId)
    if (completed) return completed
    if (this.state.tabs.length >= 16) throw new Error("Close a read-only snapshot tab before opening another")
    let resolve!: (value: Presentation) => void, reject!: (error: Error) => void
    const promise = new Promise<Presentation>((yes, no) => { resolve = yes; reject = no })
    this.pending.set(request.operationId, { promise, resolve, reject })
    const tab = { request: structuredClone(request), snapshot: Object.freeze({ ...snapshot }), viewInstanceId: crypto.randomUUID(), signal }
    const stop = () => this.close(request.operationId)
    signal.addEventListener("abort", stop, { once: true })
    this.publish({ tabs: [...this.state.tabs, tab], activeId: request.operationId })
    this.navigate()
    return promise.finally(() => signal.removeEventListener("abort", stop))
  }

  /** Called by the actual mounted view, after its source/Markdown content is committed. */
  rendered(operationId: string) {
    const pending = this.pending.get(operationId)
    const tab = this.state.tabs.find(tab => tab.request.operationId === operationId)
    if (!pending || !tab || this.state.activeId !== operationId) return
    if (!this.eligible(tab.request, tab.signal)) { this.stop(operationId); return }
    const receipt = { viewInstanceId: tab.viewInstanceId, fileVersion: tab.snapshot.version, digest: tab.snapshot.digest }
    this.receipts.set(operationId, receipt)
    this.pending.delete(operationId)
    pending.resolve(receipt)
  }

  select(operationId: string) {
    if (this.state.tabs.some(tab => tab.request.operationId === operationId)) this.publish({ ...this.state, activeId: operationId })
  }
  showEditableFiles() { if (this.state.activeId) this.publish({ ...this.state, activeId: null }) }
  close(operationId: string) {
    this.pending.get(operationId)?.reject(new Error("Host snapshot was closed before presentation"))
    this.pending.delete(operationId)
    this.publish({ tabs: this.state.tabs.filter(tab => tab.request.operationId !== operationId), activeId: this.state.activeId === operationId ? null : this.state.activeId })
  }
  stop(operationId: string) {
    this.stopped.add(operationId)
    // Already presented content is history. Stopping its delivery never reselects it.
    if (!this.receipts.has(operationId)) this.close(operationId)
  }
  activate() { this.disposed = false }
  dispose() {
    this.disposed = true
    for (const pending of this.pending.values()) pending.reject(new Error("File workbench closed"))
    this.pending.clear()
    this.publish(EMPTY_STATE)
    this.listeners.clear()
  }
}
