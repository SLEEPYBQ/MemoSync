import { afterEach, describe, expect, test } from "bun:test"
import { memoriesApi, type MemoryItem } from "../../lib/memoriesApi"
import { useMemoryStore } from "../../stores/memoryStore"
import { DEMO_MEMORY_ITEMS } from "./guideScenes"
import { installGuideMemorySandbox } from "./guideMemorySandbox"

const INITIAL_STATE = useMemoryStore.getInitialState()
const ORIGINAL_LIST = memoriesApi.list
let uninstall: ReturnType<typeof installGuideMemorySandbox> | null = null

function realMemory(id: string, content: string): MemoryItem {
  return {
    ...DEMO_MEMORY_ITEMS[0],
    id,
    content,
    updatedAt: "2026-08-15T00:00:00.000Z",
  }
}

function expectOnlyDemoMemories(): void {
  const state = useMemoryStore.getState()
  expect(state.items).toEqual(DEMO_MEMORY_ITEMS)
  expect(state.status).toBe("ready")
  expect(state.error).toBeNull()
}

afterEach(() => {
  uninstall?.()
  uninstall = null
  memoriesApi.list = ORIGINAL_LIST
  useMemoryStore.setState(INITIAL_STATE, true)
})

function deferredMemoryList(): {
  promise: Promise<MemoryItem[]>
  resolve: (items: MemoryItem[]) => void
} {
  let resolve!: (items: MemoryItem[]) => void
  const promise = new Promise<MemoryItem[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("installGuideMemorySandbox", () => {
  test("keeps a production Board Accept local update inside the demo and restores participant state", () => {
    const realItems = [realMemory("M-90", "Participant memory before the Guide")]
    useMemoryStore.setState({ items: realItems, status: "ready", error: null })
    const realActions = {
      loadAll: useMemoryStore.getState().loadAll,
      upsertLocal: useMemoryStore.getState().upsertLocal,
      removeLocal: useMemoryStore.getState().removeLocal,
    }

    uninstall = installGuideMemorySandbox()
    const accepted = { ...DEMO_MEMORY_ITEMS[0]!, content: "Accepted inside the Guide Board" }
    // The Guide-local HTTP controller publishes the accepted collection before
    // MemoryBoardPage applies the same item through its production local seam.
    uninstall.setItems(DEMO_MEMORY_ITEMS.map((item) => item.id === accepted.id ? accepted : item))
    // This is the observable local-store seam used by MemoryBoardPage after
    // its production Accept request succeeds.
    useMemoryStore.getState().upsertLocal(accepted)
    expect(useMemoryStore.getState().items.find((item) => item.id === accepted.id)?.content).toBe(
      "Accepted inside the Guide Board",
    )

    const cleanup = uninstall
    uninstall = null
    cleanup()

    const restored = useMemoryStore.getState()
    expect(restored.items).toBe(realItems)
    expect(restored.loadAll).toBe(realActions.loadAll)
    expect(restored.upsertLocal).toBe(realActions.upsertLocal)
    expect(restored.removeLocal).toBe(realActions.removeLocal)
  })

  test("keeps a production Board Dismiss local update inside the demo and restores participant state", () => {
    const realItems = [realMemory("M-91", "Participant memory before Dismiss practice")]
    useMemoryStore.setState({ items: realItems, status: "ready", error: null })

    uninstall = installGuideMemorySandbox()
    const dismissedId = "M-05"
    uninstall.setItems(DEMO_MEMORY_ITEMS.filter((item) => item.id !== dismissedId))
    // This is the observable local-store seam used by MemoryBoardPage after
    // its production Dismiss request succeeds.
    useMemoryStore.getState().removeLocal(dismissedId)
    expect(useMemoryStore.getState().items.some((item) => item.id === dismissedId)).toBe(false)

    const cleanup = uninstall
    uninstall = null
    cleanup()

    expect(useMemoryStore.getState().items).toBe(realItems)
  })

  test("keeps the production Board load inside the demo and restores participant state", async () => {
    const realItems = [realMemory("M-92", "Participant memory before Board load")]
    useMemoryStore.setState({ items: realItems, status: "ready", error: null })
    memoriesApi.list = async () => DEMO_MEMORY_ITEMS.map((item) => ({ ...item }))

    uninstall = installGuideMemorySandbox()
    await useMemoryStore.getState().loadAll()
    expectOnlyDemoMemories()

    const cleanup = uninstall
    uninstall = null
    cleanup()

    expect(useMemoryStore.getState().items).toBe(realItems)
  })

  test("restores the exact real collection when a demo id collides", () => {
    const realItems = [
      realMemory("M-01", "Participant's real M-01"),
      realMemory("M-91", "Participant's unrelated memory"),
    ]
    useMemoryStore.setState({ items: realItems, status: "error", error: "last real load failed" })

    uninstall = installGuideMemorySandbox()
    expectOnlyDemoMemories()

    const cleanup = uninstall
    uninstall = null
    cleanup()

    const restored = useMemoryStore.getState()
    expect(restored.items).toBe(realItems)
    expect(restored.items.find((item) => item.id === "M-01")?.content).toBe("Participant's real M-01")
    expect(restored.status).toBe("error")
    expect(restored.error).toBe("last real load failed")
  })

  test("captures a real load already in flight, while keeping only demo memories visible", async () => {
    const beforeLoad = [realMemory("M-10", "Older server snapshot")]
    const loadedItems = [
      realMemory("M-01", "Newest real M-01 from the server"),
      realMemory("M-11", "Newest server snapshot"),
    ]
    const request = deferredMemoryList()
    memoriesApi.list = () => request.promise
    useMemoryStore.setState({ items: beforeLoad, status: "ready", error: null })
    const load = useMemoryStore.getState().loadAll()
    expect(useMemoryStore.getState().status).toBe("loading")

    uninstall = installGuideMemorySandbox()
    expectOnlyDemoMemories()

    request.resolve(loadedItems)
    await load
    expectOnlyDemoMemories()

    const cleanup = uninstall
    uninstall = null
    cleanup()

    expect(useMemoryStore.getState().items).toBe(loadedItems)
    expect(useMemoryStore.getState().status).toBe("ready")
  })

  test("tracks a background real load through a pre-sandbox action and cleanup is idempotent", async () => {
    const originalItems = [realMemory("M-20", "Original real snapshot")]
    const loadedItems = [realMemory("M-21", "Later real snapshot")]
    const request = deferredMemoryList()
    memoriesApi.list = () => request.promise
    useMemoryStore.setState({ items: originalItems, status: "ready", error: null })
    const backgroundRealLoad = useMemoryStore.getState().loadAll

    uninstall = installGuideMemorySandbox()
    expectOnlyDemoMemories()

    const load = backgroundRealLoad()
    expectOnlyDemoMemories()
    request.resolve(loadedItems)
    await load
    expectOnlyDemoMemories()

    const cleanup = uninstall
    uninstall = null
    cleanup()
    cleanup()

    expect(useMemoryStore.getState().items).toBe(loadedItems)
    expect(useMemoryStore.getState().status).toBe("ready")
    expect(useMemoryStore.getState().error).toBeNull()
  })

  test("captures a direct background collection replacement", () => {
    const originalItems = [realMemory("M-30", "Original real snapshot")]
    const updatedItems = [realMemory("M-31", "Direct background update")]
    useMemoryStore.setState({ items: originalItems, status: "ready", error: null })

    uninstall = installGuideMemorySandbox()
    useMemoryStore.setState({ items: updatedItems, status: "ready", error: null })
    expectOnlyDemoMemories()

    const cleanup = uninstall
    uninstall = null
    cleanup()

    expect(useMemoryStore.getState().items).toBe(updatedItems)
  })

  test("switches between pending and cleared Board demo collections without replacing real memory", () => {
    const realItems = [realMemory("M-40", "Participant memory before the Guide")]
    useMemoryStore.setState({ items: realItems, status: "ready", error: null })

    uninstall = installGuideMemorySandbox()
    const clearedItems = DEMO_MEMORY_ITEMS.filter((item) => item.status !== "candidate")
    uninstall.setItems(clearedItems)

    expect(useMemoryStore.getState().items).toEqual(clearedItems)
    expect(useMemoryStore.getState().items.some((item) => item.status === "candidate")).toBe(false)

    const cleanup = uninstall
    uninstall = null
    cleanup()
    expect(useMemoryStore.getState().items).toBe(realItems)
  })
})
