import { afterEach, describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryTraceMessage } from "./MemoryTraceMessage"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "./render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("audit correction screenshots", new URL("./MemoryTraceMessage.browser.ts", import.meta.url))

afterEach(() => { useMemoryStore.getInitialState().items.length = 0 })

// Minimal memory_trace message; only the fields the component reads matter.
function msg(
  labels: Array<{ id: string; label: string; note?: string; quote?: string; toolId?: string; cause?: string; impact?: string; missing?: string }>,
  extra: Record<string, unknown> = {},
) {
  return { kind: "memory_trace", labels, ...extra } as unknown as Parameters<typeof MemoryTraceMessage>[0]["message"]
}

describe("MemoryTraceMessage", () => {
  test("corrections follow effective verdict sections and hide controls in readonly", () => {
    const render = (labels: unknown[], readonly = false) => renderToStaticMarkup(
      <TranscriptChatContextProvider value={{ chatId: "chat-1" }}>
        <TranscriptRenderOptionsProvider value={{ readonly }}><MemoryTraceMessage message={msg(labels as Parameters<typeof msg>[0], { turn: 1 })} /></TranscriptRenderOptionsProvider>
      </TranscriptChatContextProvider>,
    )
    const original = render([{ id: "M-1", label: "violated", cause: "not_followed" }])
    expect(original).toContain("Not right?")
    const away = render([{ id: "M-1", label: "violated", cause: "not_followed", userLabel: "not_applicable", userNote: "No image" }])
    expect(away).toContain("line-through")
    expect(away).toContain("You:")
    expect(away).toContain("No image")
    expect(away).toContain("1 corrected")
    expect(away).not.toContain("Enforce this next run")
    const toward = render([{ id: "M-1", label: "operational", userLabel: "violated" }])
    expect(toward).not.toContain("Enforce this next run")
    expect(toward).not.toContain("Draft a fix")
    expect(toward).toContain("Cause unclear. Review the memory and reply before taking action.")
    const grouped = render([
      { id: "M-1", label: "violated", userLabel: "not_applicable", userNote: "No image" },
      { id: "M-2", label: "operational", userLabel: "violated" },
    ])
    const sections = grouped.match(/<section\b[\s\S]*?<\/section>/g) ?? []
    expect(sections).toHaveLength(2)
    const violated = sections.find(section => section.includes(">Violated</span>"))
    const notApplicable = sections.find(section => section.includes(">Not applicable this turn</span>"))
    expect(violated).toContain("M-2")
    expect(violated).not.toContain("M-1")
    expect(notApplicable).toContain("M-1")
    expect(notApplicable).not.toContain("M-2")
    expect(grouped).toContain("1 violated")
    expect(grouped).toContain("1 not applicable")
    expect(grouped).not.toContain(">Shaped this turn</span>")
    const readonly = render([{ id: "M-1", label: "violated", userLabel: "operational" }], true)
    expect(readonly).toContain("You:")
    expect(readonly).not.toContain("Not right?")
    expect(readonly).not.toContain("Undo")
  })
  test("archived violated memories show undo instead of enforcement", () => {
    useMemoryStore.getInitialState().items.push({ id: "M-76", status: "archived", scope: "personal", content: "A synthetic rule", type: "constraint" } as MemoryItem)
    const html = renderToStaticMarkup(<TranscriptChatContextProvider value={{ chatId: "chat-1" }}>
      <MemoryTraceMessage message={msg([{ id: "M-76", label: "violated", cause: "not_followed", note: "Synthetic violation" }])} />
    </TranscriptChatContextProvider>)
    expect(html).toContain("Archived. It won&#x27;t be used again.")
    expect(html).toContain("Undo")
    expect(html).not.toContain("Enforce this next run")
  })

  test("active audit rows expose archive except in readonly transcripts", () => {
    useMemoryStore.getInitialState().items.push({ id: "M-76", status: "active", scope: "personal", content: "A synthetic rule", type: "constraint" } as MemoryItem)
    const message = msg([{ id: "M-76", label: "operational" }])
    expect(renderToStaticMarkup(<MemoryTraceMessage message={message} />)).toContain("Archive: stop using this memory in every chat")
    expect(renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{ readonly: true }}><MemoryTraceMessage message={message} /></TranscriptRenderOptionsProvider>)).not.toContain("Archive: stop using")
  })
  test("offers Where used for tool-only audit evidence with no inline citation", () => {
    const html = renderToStaticMarkup(<MemoryTraceMessage message={msg([{
      id: "M-31", label: "violated", note: "The tool changed the restricted file.", toolId: "call-edit-31", cause: "not_followed",
    }])} />)
    expect(html).toContain("where used")
    expect(html).toContain("audit-found")
    expect(html).toContain("reply or tool evidence")
  })
  test("expands all four verdict groups on initial render", () => {
    // Every verdict group starts expanded so the user sees all rows at once.
    const html = renderToStaticMarkup(
      createElement(MemoryTraceMessage, {
        message: msg([
          { id: "M-01", label: "violated", note: "pushed to main", cause: "not_followed" },
          { id: "M-02", label: "operational" },
          { id: "M-03", label: "not_applicable", missing: "no image in this turn" },
          { id: "M-04", label: "injected_without_effect" },
        ]),
      }),
    )
    expect(html).toContain("M-01")
    expect(html).toContain("M-02")
    expect(html).toContain("M-03")
    expect(html).toContain("M-04")
    // The NA row still names its missing object when expanded by default.
    expect(html).toContain("no image in this turn")
  })

  test("shows used/violated verdicts and the no-effect rows by default", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryTraceMessage, {
        message: msg([
          { id: "M-01", label: "operational" },
          { id: "M-02", label: "injected_without_effect" },
        ]),
      }),
    )
    // The operational verdict is visible without interaction (review feedback:
    // "was this used?" used to need an extra click).
    expect(html).toContain("shaped this turn")
    expect(html).toContain("M-01")
    // The no-effect group keeps its counted header, and its row is now
    // expanded on initial render too.
    expect(html).toContain("1 no visible effect")
    expect(html).toContain("M-02")
  })

  test("orders violated ahead of operational among the visible verdicts", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryTraceMessage, {
        message: msg([
          { id: "M-10", label: "injected_without_effect" },
          { id: "M-11", label: "operational" },
          { id: "M-12", label: "violated", note: "pushed to main" },
        ]),
      }),
    )
    const iViolated = html.indexOf("M-12")
    const iOperational = html.indexOf("M-11")
    expect(iViolated).toBeGreaterThanOrEqual(0)
    expect(iViolated).toBeLessThan(iOperational)
    // The no-effect memory renders after the shaped rows, expanded by default.
    expect(html).toContain("1 no visible effect")
    const iNoEffect = html.indexOf("M-10")
    expect(iNoEffect).toBeGreaterThan(iOperational)
  })

  test("keeps violated actions in a neutral card with a low-emphasis jump control", () => {
    const html = renderToStaticMarkup(
      <TranscriptChatContextProvider value={{ chatId: "chat-1", projectId: "project-1" }}>
        <MemoryTraceMessage
          message={msg([{
            id: "M-12",
            label: "violated",
            note: "The reply bypassed the required shared state.",
            quote: "set the array directly",
            cause: "not_followed",
            impact: "negative",
          }])}
        />
      </TranscriptChatContextProvider>,
    )

    expect(html).toContain("Enforce this next run")
    expect(html).toContain("where used")
    expect(html).not.toContain("Draft a fix")
    expect(html).not.toContain("hurt the outcome")
    expect(html).not.toContain("no negative impact")
    expect(html).not.toContain("border-l-2")
    expect(html).toContain("rounded-xl border border-transparent bg-card")
    expect(html).toStartWith('<div class="memory-ui memory-card @container min-w-0 rounded-xl border border-transparent bg-card')
    expect(html).toContain("justify-end")
    expect(html).not.toContain("bg-destructive px-2 py-1")
  })

  test("a conflicting memory offers a fix instead of unsafe enforcement", () => {
    const html = renderToStaticMarkup(
      <TranscriptChatContextProvider value={{ chatId: "chat-1", projectId: "project-1" }}>
        <MemoryTraceMessage
          message={msg([{
            id: "M-13",
            label: "violated",
            note: "The stored rule conflicts with the current task.",
            cause: "memory_conflict",
          }])}
        />
      </TranscriptChatContextProvider>,
    )

    expect(html).toContain("Draft a fix")
    expect(html).not.toContain("Enforce this next run")
  })

  test("a violation with no diagnosed cause offers no contradictory action", () => {
    const html = renderToStaticMarkup(
      <TranscriptChatContextProvider value={{ chatId: "chat-1", projectId: "project-1" }}>
        <MemoryTraceMessage
          message={msg([{
            id: "M-14",
            label: "violated",
            note: "The audit detected a violation but returned no valid cause.",
          }])}
        />
      </TranscriptChatContextProvider>,
    )

    expect(html).toContain("Cause unclear. Review the memory and reply before taking action.")
    expect(html).not.toContain("Enforce this next run")
    expect(html).not.toContain("Draft a fix")
  })

  test("shows an explicit unavailable marker for a failed pass", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryTraceMessage, {
        message: msg([], { status: "failed", errorClass: "TypeError" }),
      }),
    )
    expect(html).toContain("Memory audit unavailable for this turn.")
    expect(html).toContain('role="status"')
    expect(html).not.toContain("TypeError")
  })

  test("distinguishes a CAS discard from a provider failure", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryTraceMessage, {
        message: msg([], { status: "discarded", dropped: 1 }),
      }),
    )
    expect(html).toContain("memory changed before the verdict was saved")
  })
})
