import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { MemoryRecordRail } from "./MemoryRecordRail"

describe("MemoryRecordRail", () => {
  test("labels a failed empty Checkup as incomplete instead of nothing needs attention", () => {
    const messages = [{
      kind: "memory_checkup",
      id: "checkup-row",
      checkupId: "checkup-failed",
      timestamp: "2026-08-17T00:00:00.000Z",
      turn: 1,
      suggestions: [],
      failedKinds: ["conflict"],
      decision: "failed",
    }] as HydratedTranscriptMessage[]

    const html = renderToStaticMarkup(<MemoryRecordRail chatId="chat-1" messages={messages} />)

    expect(html).toContain("checkup incomplete")
    expect(html).toContain("conflict unchecked")
    expect(html).not.toContain("nothing needs attention")
  })

  test("shows citations from in-flight Claude text before the final transcript row arrives", () => {
    const messages = [{
      kind: "memory_proposals",
      id: "candidate-row",
      proposalsId: "proposals-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 1,
      candidates: [{
        id: "M-03",
        content: "A pending candidate that is not working memory",
        scope: "project",
        projectId: "project-1",
        type: "fact",
        status: "candidate",
      }],
    }, {
      kind: "memory_preview",
      id: "preview-row",
      previewId: "preview-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 1,
      decision: "go_on",
      memories: [
        { id: "M-01", content: "First rule", scope: "project" },
        { id: "M-02", content: "Second rule", scope: "project" },
      ],
    }] as HydratedTranscriptMessage[]

    const html = renderToStaticMarkup(
      <MemoryRecordRail
        chatId="chat-1"
        messages={messages}
        streamingText="Applying [M-02], then [M-01], and [M-02] again."
      />,
    )
    const reportedStart = html.indexOf("Reported Memory Use")
    const reportedHtml = html.slice(reportedStart)
    const candidateStart = html.indexOf("Memory Candidates")
    const workingMemoryStart = html.indexOf("Working Memory")
    const candidateHtml = html.slice(candidateStart, workingMemoryStart)

    expect(reportedStart).toBeGreaterThan(-1)
    expect(reportedHtml.indexOf("[M-02]")).toBeLessThan(reportedHtml.indexOf("[M-01]"))
    expect(reportedHtml).toContain("×2")
    expect(reportedHtml).toContain('data-memory-interrupt-source="current-turn"')
    expect(candidateHtml).toContain("Memory Candidates")
    expect(candidateHtml).not.toContain('data-memory-interrupt-source="current-turn"')
  })

  test("does not mark a completed Memory Record turn as interruptible", () => {
    const messages = [{
      kind: "memory_preview",
      id: "preview-row",
      previewId: "preview-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 1,
      decision: "go_on",
      memories: [{ id: "M-01", content: "First rule", scope: "project" }],
    }, {
      kind: "assistant_text",
      id: "answer-row",
      timestamp: "2026-08-19T00:00:01.000Z",
      text: "Applied [M-01].",
    }] as HydratedTranscriptMessage[]

    const html = renderToStaticMarkup(<MemoryRecordRail chatId="chat-1" messages={messages} />)

    expect(html).toContain("[M-01]")
    expect(html).not.toContain('data-memory-interrupt-source="current-turn"')
  })

  test("keeps the active turn interruptible between persisted text segments", () => {
    const messages = [{
      kind: "memory_preview",
      id: "preview-row",
      previewId: "preview-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 1,
      decision: "go_on",
      memories: [{ id: "M-21", content: "Use the existing server", scope: "project" }],
    }, {
      kind: "assistant_text",
      id: "answer-row",
      timestamp: "2026-08-19T00:00:01.000Z",
      text: "The server was started [M-21].",
    }] as HydratedTranscriptMessage[]

    const html = renderToStaticMarkup(
      <MemoryRecordRail chatId="chat-1" messages={messages} isTurnActive />,
    )

    expect(html).toContain('data-memory-interrupt-source="current-turn"')
    expect(html).toContain("running…")
  })
})
