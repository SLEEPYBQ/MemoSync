import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { HostActionRequested, HostFileSnapshot } from "../../shared/host-actions"
import { HostFileWorkbench } from "./hostFileWorkbench"

function fixture() {
  const content = "# Frozen README\nThe admitted disk version.\n"
  const digest = createHash("sha256").update(content).digest("hex")
  const snapshot: HostFileSnapshot = { content, version: digest, digest, origin: "snapshot", byteLength: Buffer.byteLength(content), mediaType: "text/markdown" }
  const request: HostActionRequested = {
    v: 1, type: "host.action.requested", operationId: "open-1", chatId: "chat-1", turnId: "turn-1", generation: 1,
    targetClientId: "client-1", expiresAt: Date.now() + 60_000,
    action: { kind: "open_file", workspaceRef: "project-1", path: "README.md", view: "preview" },
    snapshot: { version: digest, digest, origin: "snapshot", byteLength: snapshot.byteLength, mediaType: "text/markdown" },
  }
  let navigations = 0
  const workbench = new HostFileWorkbench("chat-1", "project-1", () => { navigations++ }, () => true)
  return { workbench, snapshot, request, navigations: () => navigations }
}
function admitted(workbench: HostFileWorkbench): Promise<void> {
  if (workbench.getSnapshot().tabs.length) return Promise.resolve()
  return new Promise(resolve => {
    const off = workbench.subscribe(() => { if (workbench.getSnapshot().tabs.length) { off(); resolve() } })
  })
}

test("accepting exact bytes does not acknowledge a view before it actually renders", async () => {
  const f = fixture(), controller = new AbortController()
  let acknowledged = false
  const wait = admitted(f.workbench)
  const presentation = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal).then(receipt => { acknowledged = true; return receipt })
  await wait
  expect(acknowledged).toBe(false)
  expect(f.navigations()).toBe(1)
  f.snapshot.content = "later edit"
  expect(f.workbench.getSnapshot().tabs[0].snapshot.content).toContain("Frozen README")
  f.workbench.rendered(f.request.operationId)
  expect(await presentation).toMatchObject({ fileVersion: f.request.snapshot.version, digest: f.request.snapshot.digest })
  expect(acknowledged).toBe(true)
  f.workbench.dispose()
})

test("concurrent and completed retries reuse the receipt without stealing the active view", async () => {
  const f = fixture(), controller = new AbortController()
  const wait = admitted(f.workbench)
  const first = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal)
  const second = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal)
  await wait
  f.workbench.rendered(f.request.operationId)
  const receipt = await first
  expect(await second).toEqual(receipt)
  expect(f.workbench.getSnapshot().tabs).toHaveLength(1)
  f.workbench.showEditableFiles()
  expect(await f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal)).toEqual(receipt)
  expect(f.workbench.getSnapshot().activeId).toBeNull()
  expect(f.navigations()).toBe(1)
  f.workbench.dispose()
})

test("an aborted asynchronous read never navigates", async () => {
  const f = fixture(), controller = new AbortController()
  const result = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal).catch(error => error)
  controller.abort()
  expect(await result).toBeInstanceOf(Error)
  expect(f.navigations()).toBe(0)
  expect(f.workbench.getSnapshot().tabs).toHaveLength(0)
  f.workbench.dispose()
})

test("a disconnected pending view can be replayed after reconnect with a fresh signal", async () => {
  const f = fixture(), firstController = new AbortController()
  const wait = admitted(f.workbench)
  const first = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, firstController.signal).catch(error => error)
  await wait
  firstController.abort()
  expect(await first).toBeInstanceOf(Error)
  expect(f.workbench.getSnapshot().tabs).toHaveLength(0)
  const replayed = admitted(f.workbench)
  const second = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, new AbortController().signal)
  await replayed
  f.workbench.rendered(f.request.operationId)
  expect(await second).toMatchObject({ digest: f.snapshot.digest })
  f.workbench.dispose()
})

test("a stopped delivery cannot reopen an unpresented snapshot", async () => {
  const f = fixture(), controller = new AbortController()
  const wait = admitted(f.workbench)
  const first = f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal).catch(error => error)
  await wait
  f.workbench.stop(f.request.operationId)
  expect(await first).toBeInstanceOf(Error)
  await expect(f.workbench.presentReadonlySnapshot(f.request, f.snapshot, controller.signal)).rejects.toThrow("no longer current")
  expect(f.navigations()).toBe(1)
  f.workbench.dispose()
})

test("different content or workspace cannot masquerade as the admitted disk snapshot", async () => {
  const f = fixture(), signal = new AbortController().signal
  await expect(f.workbench.presentReadonlySnapshot(f.request, { ...f.snapshot, content: f.snapshot.content.replace("Frozen", "Edited") }, signal)).rejects.toThrow()
  await expect(f.workbench.presentReadonlySnapshot({ ...f.request, action: { ...f.request.action, workspaceRef: "another-project" } }, f.snapshot, signal)).rejects.toThrow()
  expect(f.navigations()).toBe(0)
  f.workbench.dispose()
})
