import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { MemoryInterruptMessage } from "./MemoryInterruptMessage"
import { TurnInterruptContext } from "./shared"

function interruption(
  resolution?: Extract<HydratedTranscriptMessage, { kind: "memory_interrupt" }>["resolution"],
): Extract<HydratedTranscriptMessage, { kind: "memory_interrupt" }> {
  return {
    kind: "memory_interrupt",
    id: "interrupt-message",
    timestamp: "2026-08-19T00:00:00.000Z",
    interruptId: "interrupt-1",
    memoryId: "M-01",
    quote: "The generated fields had no visible labels.",
    prompt: "Implement the settings form",
    workingSet: [{ id: "M-01", cited: true }],
    resolution,
  }
}

test("pending recovery uses one composer-shaped form with optional one-run enforcement", () => {
  const html = renderToStaticMarkup(
    <TurnInterruptContext.Provider value={{ active: false, interrupt: () => {}, resume: async () => {} }}>
      <MemoryInterruptMessage message={interruption()} />
    </TurnInterruptContext.Provider>,
  )

  expect(html).toContain("Describe the problem or correction")
  expect(html).toContain("<form")
  expect(html).toContain('aria-label="Send and resume"')
  expect(html).toContain("rounded-full")
  expect(html).toContain("Enforce for this resumed run")
  expect(html).toContain("one run only")
  expect(html).toContain('type="checkbox"')
  expect(html).toContain("Working Memory")
  expect(html).toContain('aria-label="Remove M-01 from the resumed turn"')
  expect(html).not.toContain("The memory itself is wrong")
  expect(html).not.toContain("It was used wrongly")
  expect(html).not.toContain("Save correction")
  expect(html).not.toContain("Resume with this set")
  expect(html).toContain("border-border/70 bg-card")
  expect(html).not.toContain("border-destructive/40")
  expect(html).not.toContain("border-l-2")
})

test("the settled recovery receipt says when one-run enforcement was applied", () => {
  const html = renderToStaticMarkup(
    <MemoryInterruptMessage
      message={interruption({
        correction: "Keep a visible label associated with every field.",
        selectedIds: ["M-01"],
        enforced: true,
      })}
    />,
  )

  expect(html).toContain("one-run enforce applied")
  expect(html).toContain("correction sent; resumed")
})

test("a legacy classified receipt keeps its historical meaning", () => {
  const html = renderToStaticMarkup(
    <MemoryInterruptMessage
      message={interruption({
        action: "removed_only",
        selectedIds: [],
      })}
    />,
  )

  expect(html).toContain("working memory adjusted; resumed")
})

test("transcript hydration accepts new actionless and legacy classified resolutions", () => {
  const messages = processTranscriptMessages([
    {
      _id: "interrupt-message",
      createdAt: Date.parse("2026-08-19T00:00:00.000Z"),
      kind: "memory_interrupt",
      interruptId: "interrupt-1",
      memoryId: "M-01",
      prompt: "Implement the settings form",
      workingSet: [{ id: "M-01", cited: true }],
    },
    {
      _id: "resolution-message",
      createdAt: Date.parse("2026-08-19T00:01:00.000Z"),
      kind: "memory_interrupt_resolution",
      interruptId: "interrupt-1",
      correction: "Keep a visible label associated with every field.",
      selectedIds: ["M-01"],
      enforced: true,
    },
  ])

  expect(messages[0]).toMatchObject({
    kind: "memory_interrupt",
    resolution: {
      correction: "Keep a visible label associated with every field.",
      enforced: true,
      selectedIds: ["M-01"],
    },
  })

  const legacy = processTranscriptMessages([
    {
      _id: "legacy-interrupt",
      createdAt: Date.parse("2026-08-18T00:00:00.000Z"),
      kind: "memory_interrupt",
      interruptId: "legacy-1",
      memoryId: "M-02",
      prompt: "Continue the task",
      workingSet: [{ id: "M-02", cited: true }],
    },
    {
      _id: "legacy-resolution",
      createdAt: Date.parse("2026-08-18T00:01:00.000Z"),
      kind: "memory_interrupt_resolution",
      interruptId: "legacy-1",
      action: "removed_only",
      selectedIds: [],
    },
  ])
  expect(legacy[0]).toMatchObject({
    kind: "memory_interrupt",
    resolution: { action: "removed_only", selectedIds: [] },
  })
})
