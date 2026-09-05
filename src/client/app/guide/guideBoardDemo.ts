import type {
  MemoryBoardActionContext,
  MemoryBoardCheckupActionContext,
  MemoryBoardReviewStatus,
  MemoryItem,
  MemoryScope,
} from "../../lib/memoriesApi"
import { DEMO_MEMORY_ITEMS } from "./guideScenes"

export interface GuideBoardDemo {
  blocking: true
  /** Enable the real production controls against the local Guide controller. */
  interactive?: boolean
  status: MemoryBoardReviewStatus
  memoryItems: MemoryItem[]
}

export interface GuideBoardDemoSnapshot {
  items: MemoryItem[]
  status: MemoryBoardReviewStatus
}

export interface GuideBoardTransferBody {
  content: string
  targetScope: MemoryScope
  targetProjectId?: string
  targetSessionId?: string
  boardResolution?: MemoryBoardActionContext
}

export interface GuideBoardDemoController {
  snapshot(): GuideBoardDemoSnapshot
  reset(demo: GuideBoardDemo): void
  subscribe(listener: (snapshot: GuideBoardDemoSnapshot) => void): () => void
  updateMemory(id: string, patch: Partial<MemoryItem>): MemoryItem
  removeMemory(id: string): void
  resolveTransfer(sourceId: string, body: GuideBoardTransferBody): MemoryItem
  declineTransfer(resolution?: MemoryBoardActionContext): void
  resolveCheckup(resolution?: MemoryBoardCheckupActionContext): void
}

const transferMessage = {
  kind: "memory_transfer" as const,
  transferId: "guide-board-transfer",
  turn: 1,
  pending: false,
  id: "guide-board-transfer-message",
  timestamp: "2026-08-18T09:00:00.000Z",
  suggestions: [{
    sourceId: "M-11",
    sourceContent: "Confirm destructive actions before executing them",
    sourceScope: "project" as const,
    sourceVersion: 1,
    sourceLabel: "Earlier project",
    rule: "Confirm destructive actions before executing them",
    content: "Ask for confirmation before emptying the cart",
    suggestedScope: "project" as const,
    landing: { route: "new" as const },
  }],
}

const checkupMessage = {
  kind: "memory_checkup" as const,
  checkupId: "guide-board-checkup",
  turn: 1,
  pending: false,
  id: "guide-board-checkup-message",
  timestamp: "2026-08-18T09:01:00.000Z",
  suggestions: [{
    kind: "staleness" as const,
    memoryId: "M-06",
    reason: "The cart page moved from pages/Cart.jsx to client/src/pages/CartPage.tsx.",
  }],
}

export const GUIDE_BOARD_PENDING_DEMO: GuideBoardDemo = {
  blocking: true,
  interactive: true,
  status: {
    reviewed: false,
    pending: { candidates: 2, transfers: 1, checkups: 1, total: 4 },
    backlog: {
      transfers: [{
        chatId: "guide-prior-chat",
        projectId: "guide-demo-shop",
        gateId: transferMessage.transferId,
        unresolved: 1,
        message: transferMessage,
      }],
      checkups: [{
        chatId: "guide-prior-chat",
        projectId: "guide-demo-shop",
        gateId: checkupMessage.checkupId,
        unresolved: 1,
        message: checkupMessage,
      }],
    },
  },
  memoryItems: DEMO_MEMORY_ITEMS,
}

/**
 * Guide-only Candidate journey seed. It deliberately has no Transfer or
 * Checkup backlog: after the one real Board projection, the Guide teaches
 * those production stations in the main-chat sequence.
 */
export const GUIDE_BOARD_CANDIDATE_DEMO: GuideBoardDemo = {
  blocking: true,
  interactive: true,
  status: {
    reviewed: false,
    pending: { candidates: 2, transfers: 0, checkups: 0, total: 2 },
    backlog: { transfers: [], checkups: [] },
  },
  memoryItems: DEMO_MEMORY_ITEMS,
}

export const GUIDE_BOARD_CLEARED_DEMO: GuideBoardDemo = {
  blocking: true,
  interactive: true,
  status: {
    reviewed: false,
    pending: { candidates: 0, transfers: 0, checkups: 0, total: 0 },
    backlog: { transfers: [], checkups: [] },
  },
  memoryItems: DEMO_MEMORY_ITEMS.filter((item) => item.status !== "candidate"),
}

function cloneDemo(demo: GuideBoardDemo): GuideBoardDemoSnapshot {
  return {
    items: demo.memoryItems.map((item) => ({ ...item, relations: item.relations?.map((relation) => ({ ...relation })) })),
    status: structuredClone(demo.status),
  }
}

function withCounts(snapshot: GuideBoardDemoSnapshot): GuideBoardDemoSnapshot {
  const candidates = snapshot.items.filter((item) => item.status === "candidate").length
  const transfers = snapshot.status.backlog.transfers.reduce((total, gate) => total + gate.unresolved, 0)
  const checkups = snapshot.status.backlog.checkups.reduce((total, gate) => total + gate.unresolved, 0)
  return {
    items: snapshot.items,
    status: {
      ...snapshot.status,
      reviewed: false,
      pending: { candidates, transfers, checkups, total: candidates + transfers + checkups },
    },
  }
}

/**
 * Tutorial-only in-memory backend for the real Board controls. The production
 * components still issue their normal HTTP requests; the Guide fetch shim
 * routes only its declared fixtures here and never reaches participant data.
 */
export function createGuideBoardDemoController(initial: GuideBoardDemo): GuideBoardDemoController {
  let current = withCounts(cloneDemo(initial))
  const listeners = new Set<(snapshot: GuideBoardDemoSnapshot) => void>()

  const snapshot = () => structuredClone(current)
  const publish = () => {
    current = withCounts(current)
    const next = snapshot()
    for (const listener of listeners) listener(next)
  }
  const removeBacklogGate = (kind: "transfers" | "checkups", gateId?: string) => {
    if (!gateId) return
    current.status.backlog[kind] = current.status.backlog[kind].filter((gate) => gate.gateId !== gateId)
  }

  return {
    snapshot,
    reset(demo) {
      current = withCounts(cloneDemo(demo))
      publish()
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot())
      return () => listeners.delete(listener)
    },
    updateMemory(id, patch) {
      const index = current.items.findIndex((item) => item.id === id)
      if (index === -1) throw new Error(`Unknown Guide memory ${id}`)
      const updated = { ...current.items[index]!, ...patch, updatedAt: new Date().toISOString() }
      current.items = current.items.map((item, itemIndex) => itemIndex === index ? updated : item)
      publish()
      return structuredClone(updated)
    },
    removeMemory(id) {
      current.items = current.items.filter((item) => item.id !== id)
      publish()
    },
    resolveTransfer(sourceId, body) {
      const template = current.items.find((item) => item.id === "M-03") ?? current.items[0]
      if (!template) throw new Error("Guide memory fixture is empty")
      const created: MemoryItem = {
        ...template,
        id: "M-12",
        content: body.content,
        scope: body.targetScope,
        status: "active",
        projectId: body.targetScope === "project" ? body.targetProjectId : undefined,
        sessionId: body.targetScope === "session" ? body.targetSessionId : undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        usageCount: 0,
        reinforcedCount: 0,
        version: 1,
        citedInCurrentSession: 0,
        relations: [{ type: "derived_from", targetId: sourceId }],
      }
      current.items = [...current.items.filter((item) => item.id !== created.id), created]
      removeBacklogGate("transfers", body.boardResolution?.gateId)
      publish()
      return structuredClone(created)
    },
    declineTransfer(resolution) {
      removeBacklogGate("transfers", resolution?.gateId)
      publish()
    },
    resolveCheckup(resolution) {
      removeBacklogGate("checkups", resolution?.gateId)
      publish()
    },
  }
}
