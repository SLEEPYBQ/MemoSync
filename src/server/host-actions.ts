import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, fstatSync, lstatSync, mkdirSync, read, realpathSync, statSync } from "node:fs"
import { lstat, realpath, stat } from "node:fs/promises"
import { promisify } from "node:util"
import { openWorkspaceSnapshotFd } from "./host-snapshot-fd"
import path from "node:path"
import { z } from "zod"
import {
  HOST_ACTION_CAPABILITY, HOST_ACTION_TOOL_NAMES,
  type HostActionClientBinding, type HostActionReceipt, type HostActionRequested,
  type HostActionServerEvent, type HostFileSnapshot, type HostNativeToolContext,
} from "../shared/host-actions"
import type { MemoryToolResult, MemoryToolSpec } from "./memory/tools"
import type { PolicyCallScope } from "../shared/harness-capabilities"

export const MAX_HOST_SNAPSHOT_BYTES = 256 * 1024
const openInput = z.object({
  workspaceRef: z.string().min(1).max(256).optional(),
  path: z.string().min(1).max(4096),
  view: z.enum(["source", "preview"]).default("source"),
  selection: z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).strict().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict()

export interface HostAdmissionScope {
  chatId: string
  admittedTurnId: string
  workspaceRef: string
  workspaceRoot: string
  targetClientId?: string
  /** Coordinator-owned execution epoch, captured before startup awaits. */
  policyScope?: Readonly<PolicyCallScope>
}
/** Synchronously captured before startup/tool awaits. Native metadata is added at callback entry. */
export interface HostAdmissionLease extends Readonly<HostAdmissionScope> {
  readonly leaseId: string
  readonly generation: number
  readonly adapterInstanceId: string
  readonly workspaceIdentity: string
  readonly policyRevision: number
  readonly capabilityRevision: number
  readonly signal: AbortSignal
}
export interface HostActionAdmissionPolicy {
  capture(scope: Readonly<HostAdmissionScope>): { policyRevision: number; capabilityRevision: number }
  /** Re-check the exact captured revisions/scope, never rebind to a new revision. */
  allows(lease: HostAdmissionLease): boolean
  onRevoked?(listener: (chatId: string, reason: string) => void): () => void
}
interface Operation {
  receipt: HostActionReceipt
  lease: Omit<HostAdmissionLease, "signal">
  nativeObservations: HostNativeToolContext[]
  fingerprint: string
  request: HostActionRequested
  snapshot: HostFileSnapshot
  /** Presentation is permitted only after scoped snapshot retrieval. */
  snapshotRetrieved: boolean
  ready: boolean
}
interface Client {
  clientId: string
  resumeToken: string
  capable: boolean
  connection?: object
  eligible?: (chatId: string) => boolean
  send?: (event: HostActionServerEvent) => boolean
}
interface HostActionsOptions {
  dataDir: string
  policy?: HostActionAdmissionPolicy
  workspaceStillCurrent?: (lease: HostAdmissionLease) => boolean
  now?: () => number
  ttlMs?: number
  /** Tests can pause a real disk read; production always uses boundedDiskSnapshot. */
  readSnapshot?: typeof boundedDiskSnapshot
}
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const sameFile = (a: Awaited<ReturnType<typeof stat>>, b: Awaited<ReturnType<typeof stat>>) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

const readChunk = promisify(read)
/** V1 rejects symlink components, including in-root links. Opens each component with
 * descriptor-relative openat + O_NOFOLLOW, then revalidates path and file identity.
 */
export async function boundedDiskSnapshot(root: string, relative: string, view: "source" | "preview", expectedRootIdentity?: string): Promise<HostFileSnapshot> {
  if (!relative || relative.includes("\\") || relative.includes(":") || relative.includes("\0") || path.isAbsolute(relative)
    || relative.split("/").some(part => part === ".." || part === "")) throw new Error("Invalid workspace-relative path")
  if (view === "preview" && !/\.(md|markdown|mdown)$/i.test(relative)) throw new Error("Only Markdown snapshot previews are supported")
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== root) throw new Error("Workspace root changed")
  const rootBefore = await stat(root)
  const target = path.resolve(root, relative)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Path outside workspace")
  const checkPath = async () => {
    let component = root
    for (const segment of path.relative(root, target).split(path.sep)) {
      component = path.join(component, segment)
      const info = await lstat(component)
      if (info.isSymbolicLink()) throw new Error("Symlink paths are unavailable for host snapshots")
    }
    if (await realpath(target) !== target || await realpath(root) !== root) throw new Error("Workspace path changed")
    const rootAfter = await stat(root)
    if (rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino) throw new Error("Workspace root changed")
  }
  await checkPath()
  const fd = openWorkspaceSnapshotFd(root, relative, expectedRootIdentity ?? `${rootBefore.dev}:${rootBefore.ino}`)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error("Only regular text files are supported")
    if (before.size > MAX_HOST_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds 256 KiB")
    const bytes = Buffer.alloc(MAX_HOST_SNAPSHOT_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const chunk = await readChunk(fd, bytes, length, bytes.length - length, length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    if (length > MAX_HOST_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds 256 KiB")
    await checkPath()
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, await stat(target))) throw new Error("File changed during snapshot read")
    const body = bytes.subarray(0, length)
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content)) throw new Error("Binary files are unsupported")
    const hash = digest(body)
    return { content, digest: hash, version: hash, origin: "snapshot", byteLength: length, mediaType: /\.(md|markdown|mdown)$/i.test(relative) ? "text/markdown" : "text/plain" }
  } finally {
    closeSync(fd)
  }
}

/** Persistent operation/outbox. Every delivery is serialized with its durable sent intent. */
export class HostActionService {
  private readonly db: Database
  private readonly clients = new Map<string, Client>()
  private readonly leases = new Map<string, { lease: HostAdmissionLease; controller: AbortController }>()
  private readonly generations = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<HostActionReceipt>>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly policy: HostActionAdmissionPolicy
  private readonly unsubscribePolicy?: () => void
  private readonly readDisk: typeof boundedDiskSnapshot
  private readonly expiryTimer: ReturnType<typeof setInterval>
  private closing?: Promise<void>

  constructor(private readonly options: HostActionsOptions) {
    mkdirSync(options.dataDir, { recursive: true })
    this.db = new Database(path.join(options.dataDir, "host-actions.sqlite"), { create: true })
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, retry_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL); CREATE INDEX IF NOT EXISTS operations_status ON operations(status); CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL)")
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 60_000
    this.policy = options.policy ?? { capture: () => { throw new Error("Host admission policy unavailable") }, allows: () => false }
    this.unsubscribePolicy = this.policy.onRevoked?.((chatId, reason) => this.revokeChat(chatId, reason))
    this.readDisk = options.readSnapshot ?? boundedDiskSnapshot
    // Live native admission cannot be restored after a server restart. Preserve ambiguity.
    for (const op of this.pending()) {
      if (op.receipt.status === "accepted") this.stop(op, "Server restarted; native admission cannot be resumed")
    }
    this.expiryTimer = setInterval(() => this.expire(), 1000)
    this.expiryTimer.unref()
  }

  bind(connection: object, capabilities: readonly string[], send: Client["send"], eligible: Client["eligible"], resumeToken?: string): HostActionClientBinding {
    if (!capabilities.includes(HOST_ACTION_CAPABILITY)) throw new Error("Readonly snapshot capability required")
    let client: Client
    if (resumeToken) {
      const row = this.db.query("SELECT id, token FROM clients WHERE token = ?").get(resumeToken) as { id: string; token: string } | null
      if (!row) throw new Error("Invalid host client resume token")
      client = this.clients.get(row.id) ?? { clientId: row.id, resumeToken: row.token, capable: true }
      if (client.connection && client.connection !== connection) throw new Error("Host client is still bound to a live window")
    } else {
      client = { clientId: randomUUID(), resumeToken: randomUUID(), capable: true }
      this.db.query("INSERT INTO clients VALUES (?, ?)").run(client.clientId, client.resumeToken)
    }
    // Replace a socket's previous binding only after validating the requested identity.
    this.disconnect(connection)
    Object.assign(client, { connection, send, eligible, capable: true })
    this.clients.set(client.clientId, client)
    return { clientId: client.clientId, resumeToken: client.resumeToken }
  }
  disconnect(connection: object) {
    for (const client of this.clients.values()) if (client.connection === connection) {
      client.connection = undefined; client.send = undefined; client.eligible = undefined
    }
  }
  clientId(connection: object): string | undefined {
    return [...this.clients.values()].find(client => client.connection === connection)?.clientId
  }
  originatingClient(connection: object): string | undefined {
    const client = [...this.clients.values()].find(client => client.connection === connection)
    // Authentication/binding establishes origin, even before a new chat has an id.
    // Subscription eligibility is checked for each actual delivery and retrieval.
    return client?.capable ? client.clientId : undefined
  }

  captureAdmission(scope: HostAdmissionScope): HostAdmissionLease | undefined {
    if (this.closing) return undefined
    this.revokeChat(scope.chatId, "A new turn superseded this admission")
    try {
      const root = realpathSync(scope.workspaceRoot)
      const rootStat = statSync(root)
      if (!rootStat.isDirectory()) return undefined
      const generation = (this.generations.get(scope.chatId) ?? 0) + 1
      this.generations.set(scope.chatId, generation)
      const capturedScope = Object.freeze({ ...scope, workspaceRoot: root,
        ...(scope.policyScope ? { policyScope: Object.freeze({ ...scope.policyScope }) } : {}) })
      const revisions = this.policy.capture(capturedScope)
      if (![revisions.policyRevision, revisions.capabilityRevision].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined
      const controller = new AbortController()
      const workspaceIdentity = `${rootStat.dev}:${rootStat.ino}`
      const lease: HostAdmissionLease = Object.freeze({ ...capturedScope, ...revisions, workspaceIdentity, leaseId: randomUUID(), generation, adapterInstanceId: randomUUID(), signal: controller.signal })
      this.leases.set(scope.chatId, { lease, controller })
      return lease
    } catch { return undefined }

  }
  revokeChat(chatId: string, reason = "Turn cancelled") {
    this.leases.get(chatId)?.controller.abort()
    this.leases.delete(chatId)
    for (const op of this.pending()) if (op.lease.chatId === chatId && op.receipt.status === "accepted") this.stop(op, reason)
  }
  private valid(lease: HostAdmissionLease): boolean {
    try {
      const info = statSync(lease.workspaceRoot)
      return this.leases.get(lease.chatId)?.lease === lease && !lease.signal.aborted
        && realpathSync(lease.workspaceRoot) === lease.workspaceRoot && `${info.dev}:${info.ino}` === lease.workspaceIdentity
        && this.policy.allows(lease) && (this.options.workspaceStillCurrent?.(lease) ?? true)
    } catch { return false }
  }
  private pathStillSafe(op: Operation): boolean {
    try {
      let current = op.lease.workspaceRoot
      for (const part of op.request.action.path.split("/")) {
        current = path.join(current, part)
        if (lstatSync(current).isSymbolicLink()) return false
      }
      return realpathSync(current) === current && statSync(current).isFile()
    } catch { return false }
  }
  private liveLease(op: Operation): HostAdmissionLease | undefined {
    const lease = this.leases.get(op.lease.chatId)?.lease
    return lease?.leaseId === op.lease.leaseId && this.valid(lease) ? lease : undefined
  }
  private pending(): Operation[] {
    return (this.db.query("SELECT payload FROM operations WHERE status = 'accepted'").all() as { payload: string }[]).map(row => JSON.parse(row.payload))
  }
  private get(id: string): Operation | undefined {
    const row = this.db.query("SELECT payload FROM operations WHERE id = ?").get(id) as { payload: string } | null
    return row ? JSON.parse(row.payload) : undefined
  }
  private save(op: Operation) {
    this.db.query("UPDATE operations SET payload = ?, status = ? WHERE id = ?").run(JSON.stringify(op), op.receipt.status, op.receipt.operationId)
  }
  private observeRetry(op: Operation, native: HostNativeToolContext) {
    if (!op.nativeObservations.some(observation => JSON.stringify(observation) === JSON.stringify(native))) {
      op.nativeObservations.push(native)
      this.save(op)
    }
  }
  private receipt(op: Operation): HostActionReceipt { return structuredClone(op.receipt) }
  private unavailable(reason: string): HostActionReceipt {
    return { operationId: "", status: "unavailable", delivery: "not-sent", cancellation: "none", reason }
  }
  private notify(op: Operation) {
    const client = this.clients.get(op.request.targetClientId)
    if (client?.eligible?.(op.lease.chatId)) client.send?.({ v: 1, type: "host.action.updated", chatId: op.lease.chatId, targetClientId: client.clientId, receipt: this.receipt(op) })
  }
  private stop(op: Operation, reason: string, expired = false) {
    const sent = op.receipt.delivery === "sent"
    op.receipt = { ...op.receipt, status: sent ? "unknown" : expired ? "expired" : "cancelled", delivery: "stopped", cancellation: expired ? op.receipt.cancellation : sent ? "requested" : "confirmed", reason }
    this.save(op)
    this.notify(op)
  }
  expire() {
    for (const op of this.pending()) if (op.receipt.status === "accepted" && this.now() >= op.request.expiresAt) this.stop(op, "Presentation deadline expired", true)
  }

  /** Capture trusted native fields and arguments synchronously, before the first await. */
  openFile(lease: HostAdmissionLease | undefined, native: HostNativeToolContext | undefined, raw: unknown, signal?: AbortSignal): Promise<HostActionReceipt> {
    if (!lease || !native?.engineInstanceId || !native.nativeSessionId || !native.nativeToolCallId) return Promise.resolve(this.unavailable("Trusted native tool correlation is unavailable"))
    if (!this.valid(lease) || signal?.aborted) return Promise.resolve(this.unavailable("Admission is stale or policy no longer allows it"))
    const bound = Object.freeze({ ...native })
    const parsed = openInput.safeParse(raw)
    if (!parsed.success) return Promise.resolve({ operationId: "", status: "rejected", delivery: "not-sent", cancellation: "none", reason: "Invalid open_file arguments" })
    const input = structuredClone(parsed.data)
    const key = JSON.stringify([lease.leaseId, lease.adapterInstanceId, lease.generation, bound.engineInstanceId, bound.nativeSessionId, input.idempotencyKey ? ["retry", input.idempotencyKey] : ["call", bound.nativeTurnId ?? null, bound.nativeToolCallId]])
    const fingerprint = JSON.stringify([input.workspaceRef ?? lease.workspaceRef, input.path, input.view, input.selection ?? null])
    const pending = this.inflight.get(key)
    if (pending) return pending.then(receipt => {
      const op = this.get(receipt.operationId)
      if (op?.fingerprint === fingerprint) this.observeRetry(op, bound)
      return !op || op.fingerprint === fingerprint ? receipt : { operationId: receipt.operationId, status: "rejected" as const, delivery: "not-sent" as const, cancellation: "none" as const, reason: "Retry key arguments changed" }
    })
    const prior = this.db.query("SELECT payload FROM operations WHERE retry_key = ?").get(key) as { payload: string } | null
    if (prior) {
      const op: Operation = JSON.parse(prior.payload)
      if (op.fingerprint === fingerprint) this.observeRetry(op, bound)
      return Promise.resolve(op.fingerprint === fingerprint ? this.receipt(op) : { operationId: op.receipt.operationId, status: "rejected", delivery: "not-sent", cancellation: "none", reason: "Retry key arguments changed" })
    }
    const task = this.admit(lease, bound, input, key, fingerprint, signal).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }
  private async admit(lease: HostAdmissionLease, native: HostNativeToolContext, input: z.infer<typeof openInput>, key: string, fingerprint: string, signal?: AbortSignal): Promise<HostActionReceipt> {
    if (signal?.aborted) return this.unavailable("Native tool call cancelled before admission")
    if (!this.valid(lease)) return this.unavailable("Admission is stale or policy no longer allows it")
    const client = lease.targetClientId ? this.clients.get(lease.targetClientId) : undefined
    if (!client?.connection || !client.capable || !client.eligible?.(lease.chatId)) return this.unavailable("No eligible originating chat client")
    if (input.workspaceRef && input.workspaceRef !== lease.workspaceRef) return { operationId: "", status: "rejected", delivery: "not-sent", cancellation: "none", reason: "Workspace is outside the admitted scope" }
    const operationId = randomUUID()
    const { signal: _, ...captured } = lease
    // Persist the admission before disk awaits so cancellation/restart has a real fact to stop.
    const emptySnapshot: HostFileSnapshot = { content: "", version: "", digest: "", origin: "snapshot", byteLength: 0, mediaType: "text/plain" }
    const { content: __, ...emptyVersion } = emptySnapshot
    const request: HostActionRequested = {
      v: 1, type: "host.action.requested", operationId, chatId: lease.chatId, turnId: lease.admittedTurnId,
      generation: lease.generation, targetClientId: client.clientId, expiresAt: this.now() + this.ttlMs,
      action: { kind: "open_file", workspaceRef: lease.workspaceRef, path: input.path, view: input.view, ...(input.selection ? { selection: input.selection } : {}) }, snapshot: emptyVersion,
    }
    let op: Operation = {
      receipt: { operationId, status: "accepted", delivery: "not-sent", cancellation: "none", target: { workspaceRef: lease.workspaceRef, path: input.path }, expiresAt: request.expiresAt },
      lease: captured, nativeObservations: [native], fingerprint, request, snapshot: emptySnapshot, snapshotRetrieved: false, ready: false,
    }
    this.db.query("INSERT INTO operations VALUES (?, ?, ?, ?)").run(operationId, key, JSON.stringify(op), op.receipt.status)
    const cancelCall = () => {
      const current = this.get(operationId)
      if (current?.receipt.status === "accepted") this.stop(current, "Native tool call cancelled")
    }
    signal?.addEventListener("abort", cancelCall, { once: true })
    try {
      const snapshot = await this.readDisk(lease.workspaceRoot, input.path, input.view, lease.workspaceIdentity)
      op = this.get(operationId)!
      if (op.receipt.status !== "accepted") return this.receipt(op)
      const lines = snapshot.content.split("\n").length
      if (input.selection && (input.selection.startLine > lines || (input.selection.endLine ?? input.selection.startLine) > lines || (input.selection.endLine ?? input.selection.startLine) < input.selection.startLine)) throw new Error("Selection outside snapshot lines")
      if (!this.valid(lease)) { this.stop(op, "Admission was revoked during snapshot read"); return this.receipt(op) }
      const { content: ___, ...version } = snapshot
      op.snapshot = snapshot
      op.request.snapshot = version
      op.ready = true
      this.save(op)
      this.deliver(op)
    } catch (error) {
      op = this.get(operationId)!
      if (op.receipt.status === "accepted") {
        op.receipt = { ...op.receipt, status: "rejected", reason: error instanceof Error ? error.message : "Snapshot unavailable" }
        this.save(op)
      }
    } finally { signal?.removeEventListener("abort", cancelCall) }
    return this.receipt(this.get(operationId)!)
  }
  private deliver(op: Operation) {
    if (op.receipt.status !== "accepted" || !op.ready) return
    if (this.now() >= op.request.expiresAt) { this.stop(op, "Presentation deadline expired", true); return }
    if (!this.liveLease(op) || !this.pathStillSafe(op)) { this.stop(op, "Admission or workspace path is no longer valid"); return }
    const client = this.clients.get(op.request.targetClientId)
    if (!client?.connection || !client.eligible?.(op.lease.chatId)) return
    // Persist BEFORE send: a crash/failure may leave unknown delivery, never falsely not-sent.
    op.receipt.delivery = "sent"
    this.save(op)
    client.send?.(op.request)
  }
  replay(connection: object) {
    const id = this.clientId(connection)
    if (!id) return
    for (const op of this.pending()) if (op.request.targetClientId === id) this.deliver(op)
  }
  private scoped(connection: object, operationId: string): Operation {
    const op = this.get(operationId)
    const id = this.clientId(connection)
    if (!op || !id || op.request.targetClientId !== id || !this.clients.get(id)?.eligible?.(op.lease.chatId)) throw new Error("Host operation unavailable for this client")
    return op
  }
  statusForClient(connection: object, operationId: string): HostActionReceipt {
    this.expire()
    return this.receipt(this.scoped(connection, operationId))
  }
  statusForTool(lease: HostAdmissionLease | undefined, operationId: string): HostActionReceipt {
    this.expire()
    const op = this.get(operationId)
    return lease && this.valid(lease) && op?.lease.leaseId === lease.leaseId
      ? this.receipt(op) : this.unavailable("Operation unavailable in this chat")
  }
  readSnapshot(connection: object, operationId: string): HostFileSnapshot {
    this.expire()
    const op = this.scoped(connection, operationId)
    if (op.receipt.status !== "accepted" || !op.ready || !this.liveLease(op) || !this.pathStillSafe(op) || this.now() >= op.request.expiresAt) {
      if (op.receipt.status === "accepted") this.stop(op, "Admission or workspace path is no longer valid")
      throw new Error("Host operation is no longer deliverable")
    }
    // Frozen bytes are returned; never re-read live/dirty content under the same version.
    op.snapshotRetrieved = true
    this.save(op)
    return structuredClone(op.snapshot)
  }
  presented(connection: object, input: { operationId: string; viewInstanceId: string; fileVersion: string; digest: string }): HostActionReceipt {
    this.expire()
    const op = this.scoped(connection, input.operationId)
    if (typeof input.viewInstanceId !== "string" || !input.viewInstanceId || input.viewInstanceId.length > 256
      || input.fileVersion !== op.snapshot.version || input.digest !== op.snapshot.digest
      || !op.snapshotRetrieved || op.receipt.delivery === "not-sent") throw new Error("Invalid snapshot presentation receipt")
    if (op.receipt.presented) return this.receipt(op)
    if (op.receipt.status === "accepted" && (!this.liveLease(op) || !this.pathStillSafe(op))) {
      this.stop(op, "Admission or workspace path changed before acknowledgement")
    }
    // Matching bytes already retrieved by this window can establish a historical
    // render fact after revocation. Preserve the stopped outcome and never
    // reactivate its lease, resend a request, or authorize another snapshot read.
    op.receipt = { ...op.receipt, status: op.receipt.status === "accepted" ? "presented" : op.receipt.status, observedContent: op.request.snapshot,
      presented: { at: this.now(), viewInstanceId: input.viewInstanceId, fileVersion: input.fileVersion, digest: input.digest } }
    this.save(op)
    this.notify(op)
    return this.receipt(op)
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    clearInterval(this.expiryTimer)
    this.unsubscribePolicy?.()
    for (const chatId of this.leases.keys()) this.revokeChat(chatId, "Host service stopped")
    this.clients.clear()
    this.closing = Promise.allSettled([...this.inflight.values()]).then(() => { this.db.close() })
    return this.closing
  }
}

/** Reuses the existing engines' native tool compiler; specs have no model-selectable identity. */
export const unavailableHostCall = (): MemoryToolResult => ({ text: JSON.stringify({ operationId: "", status: "unavailable", delivery: "not-sent", cancellation: "none", reason: "Trusted native host-action correlation unavailable" }), isError: true })
export function hostActionToolSpecs(): MemoryToolSpec[] {
  return [
    { name: HOST_ACTION_TOOL_NAMES.openFile, description: "Request a readonly workspace text/Markdown snapshot in the originating MemoSync window. accepted is not displayed; only presented confirms rendering. Does not read content into model context.", schema: openInput.shape, handler: unavailableHostCall },
    { name: HOST_ACTION_TOOL_NAMES.actionStatus, description: "Read the persisted status of a MemoSync host operation in this chat. Does not navigate or execute anything.", schema: { operationId: z.string().min(1).max(256) }, handler: unavailableHostCall },
  ]
}
export function isHostActionTool(name: string) { return Object.values(HOST_ACTION_TOOL_NAMES).includes(name as never) }
export async function dispatchHostAction(service: HostActionService | undefined, lease: HostAdmissionLease | undefined, name: string, input: Record<string, unknown>, native?: HostNativeToolContext, signal?: AbortSignal) {
  const receipt = !service || !native?.engineInstanceId || !native.nativeSessionId || !native.nativeToolCallId
    ? { operationId: "", status: "unavailable", reason: "Trusted native host-action correlation unavailable", delivery: "not-sent", cancellation: "none" }
    : name === HOST_ACTION_TOOL_NAMES.actionStatus
      ? service.statusForTool(lease, typeof input.operationId === "string" ? input.operationId : "")
      : await service.openFile(lease, native, input, signal)
  return { text: JSON.stringify(receipt), isError: name === HOST_ACTION_TOOL_NAMES.actionStatus
    ? receipt.status === "unavailable" : !["accepted", "presented"].includes(receipt.status) }
}
