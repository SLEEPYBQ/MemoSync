import { describe, expect, test } from "bun:test"
import type { ReactElement } from "react"
import { MemoryBoardOverlay } from "../study/StudyBoardGate"
import {
  GuideManualBoardOverlay,
  type GuideManualBoardOverlayProps,
} from "./GuideTour"

function renderOverlay(
  overrides: Partial<GuideManualBoardOverlayProps> = {},
): ReactElement<Record<string, unknown>> {
  return GuideManualBoardOverlay({
    request: { source: "chat_long_term", chatId: "guide-demo" },
    boardSnapshot: null,
    onBacklogChanged: () => undefined,
    onDismiss: () => undefined,
    ...overrides,
  }) as ReactElement<Record<string, unknown>>
}

function boardClose(overlay: ReactElement<Record<string, unknown>>): (() => void) | undefined {
  expect(overlay.type).toBe(MemoryBoardOverlay)
  return (overlay.props as { onClose?: () => void }).onClose
}

describe("Guide focused Memory Board close", () => {
  test("closing the optional Board returns to the same Candidate lesson", () => {
    const events: string[] = []
    const overlay = renderOverlay({
      onDismiss: () => events.push("closed"),
    })

    const close = boardClose(overlay)
    expect(typeof close).toBe("function")

    // MemoryBoardOverlay owns its visible Close; the Guide dismisses only the
    // optional overlay and leaves the Candidate lesson in place.
    close?.()

    expect(events).toEqual(["closed"])
  })
})
