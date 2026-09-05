import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { buildAutomaticTransferCommitBody, MemoryTransferGate } from "./MemoryTransferGate"

type TransferMessage = Extract<HydratedTranscriptMessage, { kind: "memory_transfer" }>

describe("MemoryTransferGate", () => {
  test("renders row progress shared with an expanded Memory Board surface", () => {
    const message = {
      kind: "memory_transfer",
      id: "live-transfer",
      transferId: "transfer-live",
      timestamp: "2026-08-19T00:00:00.000Z",
      suggestions: [{
        sourceId: "M-09",
        sourceContent: "Vite needs --host in Docker",
        sourceScope: "project",
        sourceVersion: 7,
        sourceLabel: "Alpha Shop",
        rule: "Bind a reachable interface in containers",
        content: "Bind 0.0.0.0 for this project's container dev server",
        suggestedScope: "project",
        landing: { route: "new" },
      }],
    } as unknown as TransferMessage

    const html = renderToStaticMarkup(
      <MemoryTransferGate
        message={message}
        onRespond={() => {}}
        settledRows={new Map([["M-09", "saved as M-12"]])}
      />,
    )

    expect(html).toContain("1 of 1 handled")
    expect(html).toContain("saved as M-12")
    expect(html).not.toContain("Bring in")
  })

  test("states that Review again rechecks without undoing saved Transfer actions", () => {
    const message = {
      kind: "memory_transfer",
      id: "settled-transfer",
      transferId: "transfer-settled",
      timestamp: "2026-08-19T00:00:00.000Z",
      suggestions: [{
        sourceId: "M-09",
        sourceContent: "Use the repository formatter",
        sourceScope: "project",
        sourceVersion: 1,
        sourceLabel: "another project",
        rule: "Use the repository formatter",
        content: "Use this project's formatter",
        suggestedScope: "project",
        landing: { route: "new" },
      }],
      decision: "handled",
    } as unknown as TransferMessage

    const html = renderToStaticMarkup(
      <MemoryTransferGate message={message} onRespond={() => {}} canReopen onReopen={() => {}} />,
    )

    expect(html).toContain("Review again")
    expect(html).toContain("rechecks the current saved state")
    expect(html).toContain("Previous saved actions remain")
    expect(html).not.toContain("Undo")
  })

  test("automatic Bring in threads source and landing-target versions into the POST payload", () => {
    const body = buildAutomaticTransferCommitBody({
      suggestion: {
        sourceId: "M-09",
        sourceContent: "Vite needs --host in Docker",
        sourceScope: "project",
        sourceVersion: 7,
        sourceLabel: "Alpha Shop",
        rule: "Bind a reachable interface in containers",
        content: "Bind 0.0.0.0 for this project's container dev server",
        abstractionLevel: "contextual",
        suggestedScope: "project",
        landing: { route: "reinforces", targetId: "M-02", targetContent: "Use pnpm", targetVersion: 3 },
      },
      scope: "project",
      projectId: "project-1",
      chatId: "chat-1",
      content: "Bind 0.0.0.0 for this project's container dev server",
    })

    expect(body.sourceVersion).toBe(7)
    expect(body.landingTargetVersion).toBe(3)
    expect(body.landingTargetId).toBe("M-02")
    expect(body.targetProjectId).toBe("project-1")
    expect(body.targetSessionId).toBeUndefined()
  })

  test("legacy widening rows are passive receipts and cannot block an open review", () => {
    const message = {
      kind: "memory_transfer",
      id: "legacy-transfer",
      transferId: "transfer-1",
      timestamp: "2026-08-16T00:00:00.000Z",
      suggestions: [
        {
          sourceId: "M-01",
          sourceContent: "This project pins Node 20",
          sourceScope: "session",
          sourceVersion: 1,
          sourceLabel: "this conversation",
          widening: true,
          rule: "Keep the project on its pinned Node version",
          suggestedScope: "project",
        },
      ],
    } as unknown as TransferMessage

    const html = renderToStaticMarkup(
      <MemoryTransferGate message={message} onRespond={() => {}} />,
    )

    expect(html).toContain("Automatic scope-widening flow is retired; no further action is available in this card.")
    expect(html).not.toContain("no memory change was made")
    expect(html).toContain("Continue")
    expect(html).not.toContain("Widen scope")
    expect(html).not.toContain("Promote")
  })
})
