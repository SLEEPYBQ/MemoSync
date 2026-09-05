import type { MemoryItem } from "../../lib/memoriesApi"
import { type MemoryHydrationStatus, useMemoryStore } from "../../stores/memoryStore"
import { DEMO_MEMORY_ITEMS } from "./guideScenes"

interface RealMemorySnapshot {
  items: MemoryItem[]
  status: MemoryHydrationStatus
  error: string | null
}

export interface GuideMemorySandboxController {
  (): void
  /** Swap the isolated collection shown by production Guide surfaces. */
  setItems(items: MemoryItem[]): void
}

/**
 * Isolate the real memory Zustand store while the guide renders production
 * memory components. The returned cleanup restores the latest real snapshot,
 * including a load that completed behind the guide.
 */
export function installGuideMemorySandbox(): GuideMemorySandboxController {
  const initial = useMemoryStore.getState()
  const realActions = {
    loadAll: initial.loadAll,
    upsertLocal: initial.upsertLocal,
    removeLocal: initial.removeLocal,
  }
  let latestReal: RealMemorySnapshot = {
    items: initial.items,
    status: initial.status,
    error: initial.error,
  }
  let realLoadInFlight = initial.status === "loading"
  let active = true
  let applyingDemo = false
  let demoItems = DEMO_MEMORY_ITEMS.map((item) => ({ ...item }))

  function upsertDemo(item: MemoryItem): void {
    const index = demoItems.findIndex((candidate) => candidate.id === item.id)
    demoItems = index === -1
      ? [...demoItems, item]
      : demoItems.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate)
    exposeDemo()
  }

  function removeDemo(id: string): void {
    demoItems = demoItems.filter((item) => item.id !== id)
    exposeDemo()
  }

  async function loadDemo(): Promise<void> {
    exposeDemo()
  }

  const exposeDemo = () => {
    if (!active) return
    const current = useMemoryStore.getState()
    if (current.items === demoItems && current.status === "ready" && current.error === null) return

    applyingDemo = true
    try {
      useMemoryStore.setState({
        items: demoItems,
        status: "ready",
        error: null,
        loadAll: loadDemo,
        upsertLocal: upsertDemo,
        removeLocal: removeDemo,
      })
    } finally {
      applyingDemo = false
    }
  }

  const unsubscribe = useMemoryStore.subscribe((state) => {
    if (!active || applyingDemo) return

    const hasExternalItems = state.items !== demoItems
    if (state.status === "loading") realLoadInFlight = true

    if (hasExternalItems || realLoadInFlight) {
      latestReal = {
        items: hasExternalItems ? state.items : latestReal.items,
        status: state.status,
        error: state.error,
      }
      if (state.status !== "loading") realLoadInFlight = false
    }

    exposeDemo()
  })

  exposeDemo()

  const cleanup = (() => {
    if (!active) return
    active = false
    unsubscribe()
    useMemoryStore.setState({ ...latestReal, ...realActions })
  }) as GuideMemorySandboxController
  cleanup.setItems = (items) => {
    if (!active) return
    demoItems = items.map((item) => ({ ...item }))
    exposeDemo()
  }
  return cleanup
}
