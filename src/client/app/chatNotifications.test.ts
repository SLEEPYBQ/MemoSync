import { describe, expect, mock, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getChatNotificationEvents, showChatNotificationEvents, type ChatNotificationEvent } from "./chatNotifications"
function chat(chatId: string, unread = false, waiting = false): SidebarChatRow {
  return { _id: chatId, _creationTime: 0, chatId, title: chatId, localPath: "/tmp/project", provider: "claude", hasAutomation: false, memoryDisabled: false, unread, status: waiting ? "waiting_for_user" : "idle" }
}
function data(chats: SidebarChatRow[]): SidebarData {
  return { projectGroups: [{ groupKey: "p", title: "Project", realTitle: "Project", localPath: "/tmp/project", chats, previewChats: [], olderChats: [], defaultCollapsed: false }] }
}
describe("per-chat notification events", () => {
  test("initial hydration and unchanged snapshots do not notify", () => {
    const snapshot = data([chat("c", true, true)])
    expect(getChatNotificationEvents(null, snapshot)).toEqual([])
    expect(getChatNotificationEvents(snapshot, snapshot)).toEqual([])
  })
  test("waiting and unread on one chat produce one event", () => {
    const events = getChatNotificationEvents(data([chat("c")]), data([chat("c", true, true)]))
    expect(events).toEqual([{ chatId: "c", projectTitle: "Project", chatTitle: "c", message: "Waiting for your response." }])
  })
  test("read-to-unread swaps notify even without a net count increase", () => {
    const events = getChatNotificationEvents(data([chat("a", true), chat("b")]), data([chat("a"), chat("b", true)]))
    expect(events.map((event) => event.chatId)).toEqual(["b"])
    expect(events[0]?.message).toBeNull()
  })
})

describe("notification event delivery", () => {
  const unreadEvents = () => getChatNotificationEvents(data([chat("c")]), data([chat("c", true)]))

  test("fetches one preview per unread event and uses it as the notification body", async () => {
    const loadPreview = mock(async (_chatId: string) => ({ lastAgentMessagePreview: "The fix is ready." }))
    const showNotification = mock((_event: ChatNotificationEvent & { message: string }) => {})
    await showChatNotificationEvents({ enabled: true, events: unreadEvents(), loadPreview, showNotification })
    expect(loadPreview.mock.calls).toEqual([["c"]])
    expect(showNotification.mock.calls).toEqual([[{ chatId: "c", projectTitle: "Project", chatTitle: "c", message: "The fix is ready." }]])
  })

  test("uses the existing fallback when the preview is null or the request fails", async () => {
    for (const loadPreview of [async () => null, async () => { throw new Error("Socket closed") }]) {
      const showNotification = mock((_event: ChatNotificationEvent & { message: string }) => {})
      await showChatNotificationEvents({ enabled: true, events: unreadEvents(), loadPreview, showNotification })
      expect(showNotification.mock.calls).toEqual([[{ chatId: "c", projectTitle: "Project", chatTitle: "c", message: "New chat activity." }]])
    }
  })

  test("disabled notifications neither fetch a preview nor show a notification", async () => {
    const loadPreview = mock(async () => null)
    const showNotification = mock((_event: ChatNotificationEvent & { message: string }) => {})
    await showChatNotificationEvents({ enabled: false, events: unreadEvents(), loadPreview, showNotification })
    expect(loadPreview).not.toHaveBeenCalled()
    expect(showNotification).not.toHaveBeenCalled()
  })

  test("waiting notifications display immediately without fetching or waiting for an unread preview", async () => {
    const events = getChatNotificationEvents(data([chat("c"), chat("waiting")]), data([chat("c", true), chat("waiting", true, true)]))
    let resolvePreview!: (preview: null) => void
    const loadPreview = mock((_chatId: string) => new Promise<null>((resolve) => { resolvePreview = resolve }))
    const showNotification = mock((_event: ChatNotificationEvent & { message: string }) => {})
    const delivery = showChatNotificationEvents({ enabled: true, events, loadPreview, showNotification })
    expect(loadPreview.mock.calls).toEqual([["c"]])
    expect(showNotification.mock.calls).toEqual([[{ chatId: "waiting", projectTitle: "Project", chatTitle: "waiting", message: "Waiting for your response." }]])
    resolvePreview(null)
    await delivery
    expect(showNotification).toHaveBeenCalledTimes(2)
  })
})
