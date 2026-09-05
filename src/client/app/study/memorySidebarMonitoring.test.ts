import { expect, test } from "bun:test"
import { memorySidebarOpenMonitoring } from "./memorySidebarMonitoring"

test("only a participant opening a memory sidebar produces a raw Monitoring open", () => {
  expect(memorySidebarOpenMonitoring("system", "summary_panel_open", "chat-1")).toBeNull()
  expect(memorySidebarOpenMonitoring("participant", "summary_panel_open", "chat-1")).toEqual({
    surface: "summary_panel_open",
    sessionId: "chat-1",
    interaction: "open",
  })
})

test("the MemoSync sidebar follows the same initiator rule", () => {
  expect(memorySidebarOpenMonitoring("system", "timeline", "chat-1")).toBeNull()
  expect(memorySidebarOpenMonitoring("participant", "timeline", "chat-1")).toEqual({
    surface: "timeline",
    sessionId: "chat-1",
    interaction: "open",
  })
})
