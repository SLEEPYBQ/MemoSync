import { expect, test } from "bun:test";
import { memorySidebarOpenMonitoring } from "./memorySidebarMonitoring";

test("the MemoSync sidebar follows the same initiator rule", () => {
  expect(memorySidebarOpenMonitoring("system", "timeline", "chat-1")).toBeNull()
  expect(memorySidebarOpenMonitoring("participant", "timeline", "chat-1")).toEqual({
    surface: "timeline",
    sessionId: "chat-1",
    interaction: "open",
  })
})
