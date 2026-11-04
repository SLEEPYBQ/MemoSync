import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { closeSync, readFileSync, statSync } from "node:fs"
import { openWorkspaceSnapshotFd } from "./host-snapshot-fd"
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HOST_ACTION_CAPABILITY, HOST_ACTION_TOOL_NAMES, type HostActionServerEvent, type HostNativeToolContext } from "../shared/host-actions"
import { HostActionService, MAX_HOST_SNAPSHOT_BYTES, boundedDiskSnapshot, dispatchHostAction, hostActionToolSpecs } from "./host-actions"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { resolve, promise }
}
const native: HostNativeToolContext = { engineInstanceId: "engine-1", nativeSessionId: "native-session-1", nativeTurnId: "native-turn-1", nativeToolCallId: "call-1" }
async function fixture(options: Partial<ConstructorParameters<typeof HostActionService>[0]> = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "memosync-host-actions-"))
  const root = await realpath(temp)
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  await writeFile(path.join(workspace, "README.md"), "# Frozen\nsecond line\n")
  const dataDir = path.join(root, "data")
  const service = new HostActionService({ dataDir, ...options })
  cleanups.push(() => service.close())
  const connection = {}
  const events: HostActionServerEvent[] = []
  let eligible = true
  const binding = service.bind(connection, [HOST_ACTION_CAPABILITY], event => { events.push(event); return true }, chatId => eligible && chatId === "chat-1")
  const scope = { chatId: "chat-1", admittedTurnId: "turn-1", workspaceRef: "project-1", workspaceRoot: workspace, targetClientId: binding.clientId }
  const lease = service.captureAdmission(scope)!
  const open = (args: Record<string, unknown> = { path: "README.md" }, call = native) => service.openFile(lease, call, args)
  const requests = () => events.filter(event => event.type === "host.action.requested")
  return { service, dataDir, workspace, root, connection, binding, scope, lease, open, events, requests, ineligible: () => { eligible = false } }
}

describe("HostActionService", () => {
  test("one persistent operation for concurrent/repeated retries; changed retry arguments reject", async () => {
    const f = await fixture()
    const [a, b] = await Promise.all([f.open(), f.open()])
    expect(a.operationId).not.toBe("")
    expect(b).toEqual(a)
    expect(await f.open()).toEqual(a)
    expect(f.requests()).toHaveLength(1)
    expect(a).toMatchObject({ status: "accepted", delivery: "sent" })
    const key = { path: "README.md", idempotencyKey: "show-it" }
    const c = await f.open(key, { ...native, nativeToolCallId: "call-2" })
    const d = await f.open(key, { ...native, nativeToolCallId: "call-3" })
    expect(c.operationId).toBe(d.operationId)
    const rejected = await f.open({ ...key, path: "other.md" }, { ...native, nativeToolCallId: "call-4" })
    expect(rejected.status).toBe("rejected")
    expect(f.requests()).toHaveLength(2)
  })

  test("requires the originating capable and subscribed client, never another open window", async () => {
    const f = await fixture()
    const other = {}
    f.service.bind(other, [HOST_ACTION_CAPABILITY], () => { throw new Error("wrong client delivery") }, () => true)
    f.service.disconnect(f.connection)
    expect((await f.open()).status).toBe("unavailable")
    const noOrigin = f.service.captureAdmission({ ...f.scope, targetClientId: undefined })!
    expect((await f.service.openFile(noOrigin, native, { path: "README.md" })).status).toBe("unavailable")
    expect(f.requests()).toHaveLength(0)
  })

  test("snapshot retrieval and presentation are scoped to the actual bound socket", async () => {
    const f = await fixture()
    const receipt = await f.open()
    const other = {}
    f.service.bind(other, [HOST_ACTION_CAPABILITY], () => true, () => true)
    expect(() => f.service.readSnapshot(other, receipt.operationId)).toThrow("unavailable")
    const request = f.requests()[0]!
    const ack = { operationId: receipt.operationId, viewInstanceId: "readonly-tab", fileVersion: request.snapshot.version, digest: request.snapshot.digest }
    expect(() => f.service.presented(f.connection, ack)).toThrow("Invalid")
    const snapshot = f.service.readSnapshot(f.connection, receipt.operationId)
    expect(snapshot.content).toBe("# Frozen\nsecond line\n")
    expect(() => f.service.presented(other, ack)).toThrow("unavailable")
    expect(() => f.service.presented(f.connection, { ...ack, digest: "wrong-version" })).toThrow("Invalid")
    const presented = f.service.presented(f.connection, ack)
    expect(presented).toMatchObject({ status: "presented", observedContent: request.snapshot, presented: { viewInstanceId: "readonly-tab" } })
    expect(f.service.presented(f.connection, ack)).toEqual(presented)
    expect(f.requests()).toHaveLength(1)
  })

  test("immutable snapshot survives live file changes; BOM bytes have an exact digest", async () => {
    const f = await fixture()
    const original = "﻿# Original\n"
    await writeFile(path.join(f.workspace, "README.md"), original)
    const receipt = await f.open()
    await writeFile(path.join(f.workspace, "README.md"), "new disk content")
    const snapshot = f.service.readSnapshot(f.connection, receipt.operationId)
    expect(snapshot.content).toBe(original)
    const hash = `sha256:${createHash("sha256").update(Buffer.from(snapshot.content)).digest("hex")}`
    expect(snapshot.digest).toBe(hash)
    expect(snapshot.version).toBe(hash)
    expect(snapshot.byteLength).toBe(Buffer.byteLength(original))
  })

  test("cancel before send persists confirmed cancellation and prevents delivery", async () => {
    const entered = deferred(), release = deferred()
    const f = await fixture({ readSnapshot: async (...args) => { entered.resolve(); await release.promise; return boundedDiskSnapshot(...args) } })
    const pending = f.open()
    await entered.promise
    f.service.revokeChat("chat-1")
    release.resolve()
    const receipt = await pending
    expect(receipt).toMatchObject({ status: "cancelled", delivery: "stopped", cancellation: "confirmed" })
    expect(receipt.operationId).not.toBe("")
    expect(f.service.statusForClient(f.connection, receipt.operationId)).toEqual(receipt)
    expect(f.requests()).toHaveLength(0)
  })

  test("native call cancellation during disk work stops the persisted operation", async () => {
    const entered = deferred(), release = deferred()
    const f = await fixture({ readSnapshot: async (...args) => { entered.resolve(); await release.promise; return boundedDiskSnapshot(...args) } })
    const controller = new AbortController()
    const pending = f.service.openFile(f.lease, native, { path: "README.md" }, controller.signal)
    await entered.promise
    controller.abort()
    release.resolve()
    expect(await pending).toMatchObject({ status: "cancelled", delivery: "stopped", cancellation: "confirmed" })
    expect(f.requests()).toHaveLength(0)
  })

  test("cancel after send leaves outcome unknown; late exact ACK records only the old fact", async () => {
    const f = await fixture()
    const receipt = await f.open()
    const snapshot = f.service.readSnapshot(f.connection, receipt.operationId)
    f.service.revokeChat("chat-1")
    expect(f.service.statusForClient(f.connection, receipt.operationId)).toMatchObject({ status: "unknown", delivery: "stopped", cancellation: "requested" })
    const fresh = f.service.captureAdmission({ ...f.scope, admittedTurnId: "turn-2" })!
    f.service.replay(f.connection)
    expect(f.requests()).toHaveLength(1)
    const late = f.service.presented(f.connection, { operationId: receipt.operationId, viewInstanceId: "old-tab", fileVersion: snapshot.version, digest: snapshot.digest })
    expect(late).toMatchObject({ status: "presented", delivery: "stopped", cancellation: "requested" })
    expect(f.requests()).toHaveLength(1)
    const newReceipt = await f.service.openFile(fresh, { ...native, nativeToolCallId: "new-call" }, { path: "README.md" })
    expect(newReceipt.operationId).not.toBe(receipt.operationId)
    expect(f.requests()[1]?.turnId).toBe("turn-2")
  })

  test("a stale generation cannot commit after disk awaits or read a pending snapshot", async () => {
    const entered = deferred(), release = deferred()
    const f = await fixture({ readSnapshot: async (...args) => { entered.resolve(); await release.promise; return boundedDiskSnapshot(...args) } })
    const pending = f.open()
    await entered.promise
    const next = f.service.captureAdmission({ ...f.scope, admittedTurnId: "turn-2" })!
    release.resolve()
    const old = await pending
    expect(old.status).toBe("cancelled")
    expect(next.generation).toBeGreaterThan(f.lease.generation)
    expect(f.requests()).toHaveLength(0)
    expect(() => f.service.readSnapshot(f.connection, old.operationId)).toThrow("no longer deliverable")
  })

  test("reconnect replays only pending unexpired operations for the same private window token", async () => {
    let now = 100
    const f = await fixture({ now: () => now, ttlMs: 50 })
    const receipt = await f.open()
    f.service.disconnect(f.connection)
    const wrongWindow = {}
    f.service.bind(wrongWindow, [HOST_ACTION_CAPABILITY], () => { throw new Error("wrong replay") }, () => true)
    f.service.replay(wrongWindow)
    const resumed = {}, events: HostActionServerEvent[] = []
    let eligible = false
    const binding = f.service.bind(resumed, [HOST_ACTION_CAPABILITY], event => { events.push(event); return true }, () => eligible, f.binding.resumeToken)
    expect(binding.clientId).toBe(f.binding.clientId)
    f.service.replay(resumed)
    expect(events).toHaveLength(0)
    eligible = true
    f.service.replay(resumed)
    expect(events.filter(e => e.type === "host.action.requested")).toHaveLength(1)
    expect(() => f.service.readSnapshot(f.connection, receipt.operationId)).toThrow("unavailable")
    const snapshot = f.service.readSnapshot(resumed, receipt.operationId)
    now = 151
    f.service.replay(resumed)
    expect(f.service.statusForClient(resumed, receipt.operationId)).toMatchObject({ status: "unknown", delivery: "stopped" })
    expect(f.service.presented(resumed, { operationId: receipt.operationId, viewInstanceId: "late-after-expiry", fileVersion: snapshot.version, digest: snapshot.digest })).toMatchObject({ status: "presented", delivery: "stopped" })
    expect(events.filter(e => e.type === "host.action.requested")).toHaveLength(1)
  })

  test("expiry before send is expired; expiry after send does not claim non-occurrence", async () => {
    let now = 100
    const entered = deferred(), release = deferred()
    const f = await fixture({ now: () => now, ttlMs: 20, readSnapshot: async (...args) => { entered.resolve(); await release.promise; return boundedDiskSnapshot(...args) } })
    const pending = f.open()
    await entered.promise
    now = 121
    f.service.expire()
    release.resolve()
    expect(await pending).toMatchObject({ status: "expired", delivery: "stopped" })
    expect(f.requests()).toHaveLength(0)
  })

  test("policy revisions are immutable and checked after asynchronous reads", async () => {
    let revision = 4
    const entered = deferred(), release = deferred()
    const f = await fixture({
      policy: { capture: () => ({ policyRevision: revision, capabilityRevision: 9 }), allows: lease => lease.policyRevision === revision },
      readSnapshot: async (...args) => { entered.resolve(); await release.promise; return boundedDiskSnapshot(...args) },
    })
    const pending = f.open()
    await entered.promise
    revision = 5
    release.resolve()
    expect((await pending).status).toBe("cancelled")
    expect(f.lease.policyRevision).toBe(4)
    expect(Object.isFrozen(f.lease)).toBe(true)
    expect(f.requests()).toHaveLength(0)
  })

  test("rejects symlink escape and a path swapped after snapshot creation", async () => {
    const f = await fixture()
    const outside = path.join(f.root, "outside.txt")
    await writeFile(outside, "private outside")
    await symlink(outside, path.join(f.workspace, "escape.txt"))
    expect((await f.open({ path: "escape.txt" })).status).toBe("rejected")
    const receipt = await f.open({ path: "README.md" }, { ...native, nativeToolCallId: "safe-call" })
    await rename(path.join(f.workspace, "README.md"), path.join(f.workspace, "old.md"))
    await symlink(outside, path.join(f.workspace, "README.md"))
    expect(() => f.service.readSnapshot(f.connection, receipt.operationId)).toThrow("no longer deliverable")
    expect(f.service.statusForClient(f.connection, receipt.operationId).status).toBe("unknown")
  })

  test("a directory swapped to a symlink while snapshot work is paused cannot deliver", async () => {
    const entered = deferred(), release = deferred()
    const f = await fixture({ readSnapshot: async (...args) => {
      const snapshot = await boundedDiskSnapshot(...args)
      entered.resolve(); await release.promise
      return snapshot
    } })
    await mkdir(path.join(f.workspace, "docs"))
    await writeFile(path.join(f.workspace, "docs", "a.md"), "inside")
    await mkdir(path.join(f.root, "outside"))
    await writeFile(path.join(f.root, "outside", "a.md"), "outside")
    const pending = f.open({ path: "docs/a.md" })
    await entered.promise
    await rename(path.join(f.workspace, "docs"), path.join(f.workspace, "docs-old"))
    await symlink(path.join(f.root, "outside"), path.join(f.workspace, "docs"))
    release.resolve()
    expect((await pending).status).toBe("cancelled")
    expect(f.requests()).toHaveLength(0)
  })

  test("descriptor traversal rejects links and pins the original file across directory replacement", async () => {
    const f = await fixture()
    await mkdir(path.join(f.workspace, "docs"))
    await writeFile(path.join(f.workspace, "docs", "a.md"), "inside")
    await mkdir(path.join(f.root, "outside"))
    await writeFile(path.join(f.root, "outside", "a.md"), "outside")
    const info = statSync(f.workspace)
    const identity = `${info.dev}:${info.ino}`
    const fd = openWorkspaceSnapshotFd(f.workspace, "docs/a.md", identity)
    try {
      await rename(path.join(f.workspace, "docs"), path.join(f.workspace, "docs-old"))
      await symlink(path.join(f.root, "outside"), path.join(f.workspace, "docs"))
      expect(readFileSync(fd, "utf8")).toBe("inside")
      expect(() => openWorkspaceSnapshotFd(f.workspace, "docs/a.md", identity)).toThrow("symlinked")
      expect(() => openWorkspaceSnapshotFd(f.workspace, "../outside/a.md", identity)).toThrow("Invalid")
      expect(() => openWorkspaceSnapshotFd(f.workspace, "README.md", "wrong-identity")).toThrow("identity changed")
    } finally { closeSync(fd) }
  })

  test("persistent receipts survive service restart, but native admission is never invented", async () => {
    const f = await fixture()
    const receipt = await f.open()
    const snapshot = f.service.readSnapshot(f.connection, receipt.operationId)
    await f.service.close()
    const restarted = new HostActionService({ dataDir: f.dataDir })
    cleanups.push(() => restarted.close())
    const connection = {}, events: HostActionServerEvent[] = []
    restarted.bind(connection, [HOST_ACTION_CAPABILITY], event => { events.push(event); return true }, () => true, f.binding.resumeToken)
    restarted.replay(connection)
    expect(events).toHaveLength(0)
    expect(restarted.statusForClient(connection, receipt.operationId).status).toBe("unknown")
    expect(await restarted.openFile(f.lease, native, { path: "README.md" })).toMatchObject({ operationId: receipt.operationId, status: "unknown" })
    expect(restarted.presented(connection, { operationId: receipt.operationId, viewInstanceId: "rendered-before-restart", fileVersion: snapshot.version, digest: snapshot.digest }).status).toBe("presented")
    expect(events.filter(e => e.type === "host.action.requested")).toHaveLength(0)
  })

  test("status is read-only and chat-scoped; untrusted native correlation always fails unavailable", async () => {
    const f = await fixture()
    const receipt = await f.open()
    const result = await dispatchHostAction(f.service, f.lease, HOST_ACTION_TOOL_NAMES.actionStatus, { operationId: receipt.operationId }, native)
    expect(JSON.parse(result.text).operationId).toBe(receipt.operationId)
    expect(f.requests()).toHaveLength(1)
    const otherChat = f.service.captureAdmission({ ...f.scope, chatId: "chat-other" })!
    expect(f.service.statusForTool(otherChat, receipt.operationId).status).toBe("unavailable")
    expect(JSON.parse((await dispatchHostAction(f.service, f.lease, HOST_ACTION_TOOL_NAMES.openFile, { path: "README.md" })).text).status).toBe("unavailable")
    for (const spec of hostActionToolSpecs()) expect(JSON.parse((await spec.handler({}, {})).text).status).toBe("unavailable")
    expect(f.requests()).toHaveLength(1)
  })

  test("bounded text only: reject URLs, traversal, binaries, oversized files, unsafe views and selections", async () => {
    const f = await fixture()
    await writeFile(path.join(f.workspace, "binary"), Buffer.from([0, 1, 255]))
    await writeFile(path.join(f.workspace, "invalid-utf8"), Buffer.from([0xff]))
    await writeFile(path.join(f.workspace, "large"), Buffer.alloc(MAX_HOST_SNAPSHOT_BYTES + 1, 65))
    const inputs = [
      { path: "https://example.com/a" }, { path: "../outside" }, { path: "/etc/passwd" },
      { path: "binary" }, { path: "invalid-utf8" }, { path: "large" },
      { path: "README.md", workspaceRef: "other-workspace" },
      { path: "README.md", view: "diff" }, { path: "binary", view: "preview" },
      { path: "README.md", selection: { startLine: 999 } },
      { path: "README.md", selection: { startLine: 2, endLine: 1 } },
      { path: "README.md", targetClientId: "model-chosen" },
    ]
    for (const [i, args] of inputs.entries()) expect((await f.open(args, { ...native, nativeToolCallId: `invalid-${i}` })).status).toBe("rejected")
    expect(f.requests()).toHaveLength(0)
  })
})
