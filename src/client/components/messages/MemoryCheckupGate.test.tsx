import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { buildBoardCheckupActionContext, MemoryCheckupGate } from "./MemoryCheckupGate"

type CheckupMessage = Extract<HydratedTranscriptMessage, { kind: "memory_checkup" }>

describe("MemoryCheckupGate", () => {
  test("renders row progress shared with an expanded Memory Board surface", () => {
    const message = {
      kind: "memory_checkup",
      id: "shared-checkup",
      checkupId: "checkup-shared",
      timestamp: "2026-08-19T00:00:00.000Z",
      suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "temporary note expired" }],
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate
        message={message}
        onRespond={() => {}}
        resolvedRows={new Map([["M-01", "archived"]])}
      />,
    )

    expect(html).toContain("1 of 1 handled")
    expect(html).toContain("archived")
    expect(html).not.toContain(">Archive<")
  })

  test("states that Review again rechecks without undoing saved Checkup actions", () => {
    const message = {
      kind: "memory_checkup",
      id: "settled-checkup",
      checkupId: "checkup-settled",
      timestamp: "2026-08-19T00:00:00.000Z",
      suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "temporary note expired" }],
      decision: "handled",
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate message={message} onRespond={() => {}} canReopen onReopen={() => {}} />,
    )

    expect(html).toContain("Review again")
    expect(html).toContain("rechecks the current saved state")
    expect(html).toContain("Previous saved actions remain")
    expect(html).not.toContain("Undo")
  })

  test("orients a Board conflict identity to the exact top-level archive action pair", () => {
    const suggestion = {
      kind: "conflict",
      memoryId: "M-03",
      otherMemoryId: "M-04",
      reason: "Cannot both apply",
    } as const
    const boardResolution = { taskId: "038-S1", chatId: "chat-prior", gateId: "checkup-1" }

    expect(buildBoardCheckupActionContext({
      boardResolution,
      suggestion,
      memoryId: "M-04",
      otherMemoryId: "M-03",
    })).toEqual({
      ...boardResolution,
      suggestionKind: "conflict",
      memoryId: "M-04",
      otherMemoryId: "M-03",
    })
  })

  test("keeps historical complete empty results on the green clear path", () => {
    const message = {
      kind: "memory_checkup",
      id: "complete-checkup",
      checkupId: "checkup-complete",
      timestamp: "2026-08-16T00:00:00.000Z",
      suggestions: [],
      decision: "empty",
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate message={message} onRespond={() => {}} />,
    )

    expect(html).toContain("Nothing needs attention")
    expect(html).not.toContain("Checkup incomplete")
  })

  test("renders an amber failed receipt instead of a green clear when a lane did not finish", () => {
    const message = {
      kind: "memory_checkup",
      id: "failed-checkup",
      checkupId: "checkup-failed",
      timestamp: "2026-08-17T00:00:00.000Z",
      suggestions: [],
      failedKinds: ["conflict"],
      decision: "failed",
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate message={message} onRespond={() => {}} />,
    )

    expect(html).toContain("Checkup incomplete")
    expect(html).toContain("Conflicts")
    expect(html).not.toContain("Nothing needs attention")
    expect(html).not.toContain("text-emerald")
  })

  test("keeps successful suggestions while warning about lanes that did not finish", () => {
    const message = {
      kind: "memory_checkup",
      id: "partial-checkup",
      checkupId: "checkup-partial",
      timestamp: "2026-08-17T00:00:00.000Z",
      suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "temporary note expired" }],
      failedKinds: ["redundancy"],
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate message={message} onRespond={() => {}} />,
    )

    expect(html).toContain("Staleness")
    expect(html).toContain("Some checks did not finish")
    expect(html).toContain("Redundancy")
    expect(html).toContain("continue")
  })

  test("keeps the incomplete warning after partial suggestions are handled", () => {
    const message = {
      kind: "memory_checkup",
      id: "handled-partial-checkup",
      checkupId: "checkup-handled-partial",
      timestamp: "2026-08-17T00:00:00.000Z",
      suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "temporary note expired" }],
      failedKinds: ["redundancy"],
      decision: "handled",
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate message={message} onRespond={() => {}} />,
    )

    expect(html).toContain("1 suggestion, handled")
    expect(html).toContain("Checkup incomplete")
    expect(html).toContain("Redundancy unchecked")
    expect(html).not.toContain("Nothing needs attention")
  })

  test("legacy promotion rows are passive receipts rather than widening controls", () => {
    const message = {
      kind: "memory_checkup",
      id: "legacy-checkup",
      checkupId: "checkup-1",
      timestamp: "2026-08-16T00:00:00.000Z",
      suggestions: [
        {
          kind: "promotion",
          memoryId: "M-01",
          promoteTo: "project",
          reason: "Previously suggested for a wider scope",
        },
      ],
    } as unknown as CheckupMessage

    const html = renderToStaticMarkup(
      <MemoryCheckupGate message={message} onRespond={() => {}} />,
    )

    expect(html).toContain("Automatic scope-widening flow is retired; no further action is available in this card.")
    expect(html).not.toContain("no memory change was made")
    expect(html).toContain("Continue")
    expect(html).not.toContain("Promote to")
    expect(html).not.toContain("Not now")
  })
})
