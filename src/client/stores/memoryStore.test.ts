import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { memoriesApi, type MemoryItem } from "../lib/memoriesApi"
import { useMemoryStore } from "./memoryStore"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function memory(id: string, content = `memory-${id}`) {
  return {
    id,
    content,
    detail: null,
    scope: "global",
    type: "fact",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    usageCount: 0,
    events: [],
  } as unknown as MemoryItem
}

let restoreList: (() => void) | undefined

afterEach(() => {
  restoreList?.()
  restoreList = undefined
  useMemoryStore.setState({ items: [], status: "idle", error: null })
})

describe("memoryStore load races", () => {
  test("lets a later fresh GET supersede a confirmed local edit while ignoring the earlier GET", async () => {
    const older = deferred<MemoryItem[]>()
    const newer = deferred<MemoryItem[]>()
    const listSpy = spyOn(memoriesApi, "list")
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    restoreList = () => listSpy.mockRestore()

    const olderLoad = useMemoryStore.getState().loadAll()
    useMemoryStore.getState().upsertLocal(memory("updated", "confirmed local edit"))
    const newerLoad = useMemoryStore.getState().loadAll()
    newer.resolve([memory("updated", "newer server version")])
    await newerLoad
    older.resolve([memory("updated", "old server version")])
    await olderLoad

    expect(useMemoryStore.getState()).toMatchObject({
      items: [memory("updated", "newer server version")],
      status: "ready",
      error: null,
    })
  })

  test("overlays local upserts and tombstones made while a GET is pending", async () => {
    const request = deferred<MemoryItem[]>()
    const listSpy = spyOn(memoriesApi, "list").mockImplementation(() => request.promise)
    restoreList = () => listSpy.mockRestore()
    const loading = useMemoryStore.getState().loadAll()

    useMemoryStore.getState().upsertLocal(memory("updated", "local version"))
    useMemoryStore.getState().removeLocal("removed")

    request.resolve([
      memory("updated", "stale server version"),
      memory("removed"),
      memory("server-only"),
    ])
    await loading

    expect(useMemoryStore.getState()).toMatchObject({
      items: [memory("updated", "local version"), memory("server-only")],
      status: "ready",
      error: null,
    })
  })

  test("does not let an older successful GET settle a newer load's loading state", async () => {
    const older = deferred<MemoryItem[]>()
    const newer = deferred<MemoryItem[]>()
    const listSpy = spyOn(memoriesApi, "list")
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    restoreList = () => listSpy.mockRestore()

    const olderLoad = useMemoryStore.getState().loadAll()
    const newerLoad = useMemoryStore.getState().loadAll()
    const requestCount = listSpy.mock.calls.length
    older.resolve([memory("stale")])
    await olderLoad

    const stateWhileNewestPending = useMemoryStore.getState()
    expect(requestCount).toBe(2)
    expect(stateWhileNewestPending).toMatchObject({ items: [], status: "loading", error: null })

    newer.reject(new Error("latest request failed"))
    await newerLoad
    expect(useMemoryStore.getState()).toMatchObject({
      items: [],
      status: "error",
      error: "latest request failed",
    })
  })

  test("ignores an older failed GET after the newest request succeeds", async () => {
    const older = deferred<MemoryItem[]>()
    const newer = deferred<MemoryItem[]>()
    const listSpy = spyOn(memoriesApi, "list")
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    restoreList = () => listSpy.mockRestore()

    const olderLoad = useMemoryStore.getState().loadAll()
    const newerLoad = useMemoryStore.getState().loadAll()
    const requestCount = listSpy.mock.calls.length
    if (requestCount === 1) {
      older.resolve([memory("stale")])
      await olderLoad
    }
    expect(requestCount).toBe(2)

    newer.resolve([memory("newest")])
    await newerLoad
    older.reject(new Error("stale request failed"))
    await olderLoad

    expect(useMemoryStore.getState()).toMatchObject({
      items: [memory("newest")],
      status: "ready",
      error: null,
    })
  })
})
