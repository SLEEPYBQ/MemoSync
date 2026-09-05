import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  createFocusedMemoryReviewRegistry,
  createFocusedMemoryReviewController,
  MemoryBoardLauncherProvider,
  reconcileMemoryBoardRequestWithActiveChat,
  resolveMemoryBoardLaunchRequest,
  useMemoryBoardLauncher,
  type FocusedMemoryReviewSnapshot,
  type MemoryBoardLaunchRequest,
} from "./MemoryBoardLauncher"

function LaunchProbe({ request }: { request: MemoryBoardLaunchRequest }) {
  const launcher = useMemoryBoardLauncher()
  launcher.openMemoryBoard(request)
  return <span>launcher ready</span>
}

describe("MemoryBoardLauncher", () => {
  test("publishes shared current-review row progress to every mounted surface", () => {
    const initial: FocusedMemoryReviewSnapshot = {
      reviewId: "turn-4-review",
      chatContext: { chatId: "chat-038-s1", projectId: "project-038" },
      messages: [],
      stale: false,
      progress: {
        settledTransferRows: new Map(),
        resolvedCheckupRows: new Map(),
      },
      onTransferSettled: () => undefined,
      onCheckupResolved: () => undefined,
    }
    const controller = createFocusedMemoryReviewController(initial)
    let publications = 0
    const unsubscribe = controller.subscribe(() => { publications += 1 })

    const settledTransferRows = new Map([["M-source", "saved as M-12"]])
    controller.update({
      ...initial,
      progress: { ...initial.progress, settledTransferRows },
    })

    expect(controller.getSnapshot().progress.settledTransferRows).toEqual(settledTransferRows)
    expect(publications).toBe(1)
    unsubscribe()
  })

  test("shares one exact opening review controller without leaking it to another chat or review", () => {
    const snapshot: FocusedMemoryReviewSnapshot = {
      reviewId: "opening-review-1",
      chatContext: { chatId: "chat-038-s1" },
      messages: [],
      stale: false,
      progress: { settledTransferRows: new Map(), resolvedCheckupRows: new Map() },
      onTransferSettled: () => undefined,
      onCheckupResolved: () => undefined,
    }
    const controller = createFocusedMemoryReviewController(snapshot)
    const registry = createFocusedMemoryReviewRegistry()
    const unregister = registry.register("chat-038-s1", "opening-review-1", controller)

    expect(registry.get("chat-038-s1", "opening-review-1")).toBe(controller)
    expect(registry.get("chat-038-s2", "opening-review-1")).toBeUndefined()
    expect(registry.get("chat-038-s1", "opening-review-2")).toBeUndefined()

    unregister()
    expect(registry.get("chat-038-s1", "opening-review-1")).toBeUndefined()
  })

  test("routes every production Board entry through one owner", () => {
    const opened: MemoryBoardLaunchRequest[] = []
    const request: MemoryBoardLaunchRequest = {
      source: "chat_long_term",
      chatId: "chat-038-s1",
    }

    renderToStaticMarkup(
      <MemoryBoardLauncherProvider onOpenMemoryBoard={(next) => opened.push(next)}>
        <LaunchProbe request={request} />
      </MemoryBoardLauncherProvider>,
    )

    expect(opened).toEqual([request])
  })

  test("binds an in-chat launch to the active chat owned by AppLayout", () => {
    expect(resolveMemoryBoardLaunchRequest(
      { source: "chat_long_term" },
      "active-chat-098-s2",
    )).toEqual({
      source: "chat_long_term",
      chatId: "active-chat-098-s2",
    })
  })

  test("fails closed when a Board launch has no active chat or targets a stale chat", () => {
    expect(resolveMemoryBoardLaunchRequest(
      { source: "study_sidebar" },
      null,
    )).toBeNull()
    expect(resolveMemoryBoardLaunchRequest(
      { source: "memory_record", chatId: "chat-a" },
      "chat-b",
    )).toBeNull()
    expect(resolveMemoryBoardLaunchRequest(
      { source: "chat_long_term", chatId: "chat-a" },
      null,
    )).toBeNull()
  })

  test("closes every chat-bound Board request when navigation leaves its owning chat", () => {
    const recordRequest = resolveMemoryBoardLaunchRequest(
      { source: "memory_record", chatId: "chat-a" },
      "chat-a",
    )
    const sidebarRequest = resolveMemoryBoardLaunchRequest(
      { source: "study_sidebar" },
      "chat-a",
    )

    expect(recordRequest).not.toBeNull()
    expect(sidebarRequest).not.toBeNull()
    expect(reconcileMemoryBoardRequestWithActiveChat(recordRequest, "chat-a")).toBe(recordRequest)
    expect(reconcileMemoryBoardRequestWithActiveChat(recordRequest, "chat-b")).toBeNull()
    expect(reconcileMemoryBoardRequestWithActiveChat(recordRequest, null)).toBeNull()
    expect(reconcileMemoryBoardRequestWithActiveChat(sidebarRequest, "chat-b")).toBeNull()
    expect(reconcileMemoryBoardRequestWithActiveChat(sidebarRequest, null)).toBeNull()
  })

  test("closes a focused review when navigation leaves its owning chat", () => {
    const snapshot: FocusedMemoryReviewSnapshot = {
      reviewId: "turn-4-review",
      chatContext: { chatId: "chat-a" },
      messages: [],
      stale: false,
      progress: {
        settledTransferRows: new Map(),
        resolvedCheckupRows: new Map(),
      },
      onTransferSettled: () => undefined,
      onCheckupResolved: () => undefined,
    }
    const focusedReview = createFocusedMemoryReviewController(snapshot)
    const request = resolveMemoryBoardLaunchRequest(
      { source: "chat_long_term", chatId: "chat-a", focusedReview },
      "chat-a",
    )

    expect(reconcileMemoryBoardRequestWithActiveChat(request, "chat-a")).toBe(request)
    expect(reconcileMemoryBoardRequestWithActiveChat(request, "chat-b")).toBeNull()
    expect(reconcileMemoryBoardRequestWithActiveChat(request, null)).toBeNull()
  })

  test("AppLayout mounts the sole production manual Board overlay owner", async () => {
    const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text()
    const overlaySource = await Bun.file(new URL("./StudyBoardGate.tsx", import.meta.url)).text()
    const recordSource = await Bun.file(
      new URL("../../components/memory-chat/SessionMemoriesPanel.tsx", import.meta.url),
    ).text()

    expect(appSource).toContain("<MemoryBoardLauncherProvider")
    expect(appSource.match(/<ManualMemoryBoardOverlay/g)).toHaveLength(1)
    expect(appSource).toContain("resolveMemoryBoardLaunchRequest(request, state.activeChatId)")
    expect(appSource).toContain("reconcileMemoryBoardRequestWithActiveChat(current, state.activeChatId)")
    expect(appSource).toContain("focusedReview={memoryBoardRequest.focusedReview}")
    expect(overlaySource).toContain("focusedReview={focusedReview}")
    expect(recordSource).not.toContain("<ManualMemoryBoardOverlay")
  })
})
