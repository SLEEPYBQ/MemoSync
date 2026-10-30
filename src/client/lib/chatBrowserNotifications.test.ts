import { afterEach, describe, expect, test } from "bun:test"
import { getChatBrowserNotificationDescription, requestChatBrowserNotificationPermission, shouldShowChatBrowserNotification, showChatBrowserNotification, truncateChatBrowserNotificationMessage } from "./chatBrowserNotifications"
import { resolveChatBrowserNotificationPreferenceAfterPermission } from "../app/settings/shared"
const originalNotification = globalThis.Notification
afterEach(() => { globalThis.Notification = originalNotification })
describe("browser notifications", () => {
  test("matches sound focus preferences", () => {
    for (const doc of [{ visibilityState: "visible" as const, hasFocus: () => true }, { visibilityState: "hidden" as const, hasFocus: () => false }, { visibilityState: "visible" as const, hasFocus: () => false }]) {
      expect(shouldShowChatBrowserNotification("never", doc)).toBe(false)
      expect(shouldShowChatBrowserNotification("always", doc)).toBe(true)
      expect(shouldShowChatBrowserNotification("unfocused", doc)).toBe(!doc.hasFocus())
    }
  })
  test("only granted permissions persist opt-in", () => {
    for (const permission of ["granted", "denied", "default", "unsupported"] as const) {
      expect(resolveChatBrowserNotificationPreferenceAfterPermission("never", permission)).toBe("never")
      expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", permission)).toBe(permission === "granted" ? "always" : "never")
      expect(resolveChatBrowserNotificationPreferenceAfterPermission("unfocused", permission)).toBe(permission === "granted" ? "unfocused" : "never")
    }
  })
  test("unsupported and denied browsers explain how to fix permissions", async () => {
    Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: undefined })
    expect(await requestChatBrowserNotificationPermission()).toBe("unsupported")
    expect(showChatBrowserNotification({ projectTitle: "P", chatTitle: "C", message: "m" })).toBe(false)
    expect(getChatBrowserNotificationDescription("unsupported")).toContain("HTTPS")
    expect(getChatBrowserNotificationDescription("denied")).toContain("browser site settings")
  })
  test("asks once, creates payload, and clicking closes then opens the chat", async () => {
    const calls: string[] = []
    class FakeNotification {
      static permission = "default"
      static requestPermission = async () => { calls.push("permission"); return "granted" }
      static latest: FakeNotification
      onclick?: () => void
      constructor(public title: string, public options: NotificationOptions) { FakeNotification.latest = this }
      close() { calls.push("close") }
    }
    Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: FakeNotification })
    expect(await requestChatBrowserNotificationPermission()).toBe("granted")
    expect(calls).toEqual(["permission"])
    FakeNotification.permission = "denied"
    expect(await requestChatBrowserNotificationPermission()).toBe("denied")
    FakeNotification.permission = "granted"
    expect(await requestChatBrowserNotificationPermission()).toBe("granted")
    expect(calls).toEqual(["permission"])
    expect(showChatBrowserNotification({ projectTitle: "Project", chatTitle: "Chat", message: "Hi\nthere", onClick: () => calls.push("focus+navigate") })).toBe(true)
    expect(FakeNotification.latest.title).toBe("Project - Chat")
    expect(FakeNotification.latest.options.body).toBe("Hi there")
    FakeNotification.latest.onclick?.()
    expect(calls).toEqual(["permission", "close", "focus+navigate"])
  })
  test("normalizes empty and long message bodies", () => {
    expect(truncateChatBrowserNotificationMessage(" \n ")).toBe("New chat activity.")
    expect(truncateChatBrowserNotificationMessage("a".repeat(300)).length).toBe(180)
  })
})
