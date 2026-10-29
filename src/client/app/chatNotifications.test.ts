import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getChatNotificationEvents } from "./chatNotifications"
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
