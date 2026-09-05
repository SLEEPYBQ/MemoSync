import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { MemoryItem } from "../../lib/memoriesApi"
import {
  createFocusedMemoryReviewController,
  MemoryBoardLauncherProvider,
} from "../../app/study/MemoryBoardLauncher"
import {
  FocusedMemoryChangesReview,
  MemoryChangesReviewFlow,
  remainingCandidateReviewItems,
  resetFocusedReviewProgress,
} from "./MemoryChangesReviewFlow"

type ReviewMessage = Extract<
  HydratedTranscriptMessage,
  { kind: "memory_proposals" | "memory_transfer" | "memory_checkup" }
>

describe("FocusedMemoryChangesReview", () => {
  test("merges only the remaining Candidate cohort without duplicating the current transcript gate", () => {
    const timestamp = "2026-08-19T00:00:00.000Z"
    const review = {
      reviewId: "turn-4-review",
      chatContext: { chatId: "chat-1" },
      messages: [{
        kind: "memory_proposals",
        id: "proposal-row",
        proposalsId: "proposal-gate",
        timestamp,
        candidates: [{ id: "M-current" }],
      }],
      stale: false,
      progress: { settledTransferRows: new Map(), resolvedCheckupRows: new Map() },
      onTransferSettled: () => undefined,
      onCheckupResolved: () => undefined,
    } as unknown as Parameters<typeof remainingCandidateReviewItems>[0]
    const item = (id: string, status: MemoryItem["status"]) => ({
      id,
      content: id,
      scope: "personal",
      status,
    } as MemoryItem)

    expect(remainingCandidateReviewItems(review, [
      item("M-current", "candidate"),
      item("M-other", "candidate"),
      item("M-accepted", "active"),
      item("M-dismissed", "discarded"),
      item("M-born-active", "active"),
    ], new Set(["M-current", "M-other", "M-accepted", "M-dismissed"])).map((candidate) => candidate.id)).toEqual([
      "M-other",
      "M-accepted",
      "M-dismissed",
    ])
  })

  test("clears same-id row receipts before Transfer is reviewed again", () => {
    const progress = {
      settledTransferRows: new Map([["M-09", "saved as M-12"]]),
      resolvedCheckupRows: new Map([["M-03", "archived"]]),
    }

    const reopened = resetFocusedReviewProgress(progress, "transfer")

    expect(reopened.settledTransferRows.size).toBe(0)
    expect(reopened.resolvedCheckupRows.size).toBe(0)
  })

  test("keeps the one Memory Board entry on a settled in-chat review", () => {
    const message = {
      kind: "memory_proposals",
      id: "settled-proposals",
      proposalsId: "settled-proposals-gate",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 3,
      candidates: [],
      decision: "empty",
    } as unknown as ReviewMessage

    const html = renderToStaticMarkup(
      <MemoryBoardLauncherProvider onOpenMemoryBoard={() => undefined}>
        <MemoryChangesReviewFlow messages={[message]} />
      </MemoryBoardLauncherProvider>,
    )

    expect(html).toContain("Go to Memory Board")
    expect(html).toContain("canonical saved memories")
    expect(html).not.toContain("Full memory library")
    expect(html).not.toContain("Current turn review")
  })

  test("renders an opening-Board review as a settled non-interactive chat receipt", () => {
    const message = {
      kind: "memory_proposals",
      id: "opening-proposals",
      proposalsId: "opening-proposals-gate",
      openingReviewId: "opening-review-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 1,
      candidates: [],
      decision: "empty",
    } as unknown as ReviewMessage

    const html = renderToStaticMarkup(
      <MemoryBoardLauncherProvider onOpenMemoryBoard={() => undefined}>
        <MemoryChangesReviewFlow messages={[message]} />
      </MemoryBoardLauncherProvider>,
    )

    expect(html).toContain("reviewed in the Memory Board")
    expect(html).toContain('data-opening-board-review-receipt="true"')
    expect(html).not.toContain("Review again")
    expect(html).not.toContain("Go to Memory Board")
    expect(html).not.toContain("Memory Candidate")
  })

  test("keeps an unfinished opening review interactive in its owner chat", () => {
    const message = {
      kind: "memory_checkup",
      id: "opening-checkup",
      checkupId: "opening-checkup-gate",
      openingReviewId: "opening-review-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      turn: 1,
      suggestions: [{ kind: "staleness", memoryId: "M-03", reason: "Review before use" }],
    } as unknown as ReviewMessage

    const html = renderToStaticMarkup(
      <MemoryBoardLauncherProvider onOpenMemoryBoard={() => undefined}>
        <MemoryChangesReviewFlow
          messages={[message]}
          onMemoryCheckupRespond={() => undefined}
        />
      </MemoryBoardLauncherProvider>,
    )

    expect(html).toContain('data-focused-memory-review="chat"')
    expect(html).toContain("Review Suggested Changes to Existing Memories")
    expect(html).toContain("Go to Memory Board")
    expect(html).not.toContain('data-opening-board-review-receipt="true"')
  })

  test("expands the same three active stations with their shared row progress", () => {
    const timestamp = "2026-08-19T00:00:00.000Z"
    const messages = [
      {
        kind: "memory_proposals",
        id: "proposal-row",
        proposalsId: "proposal-gate",
        timestamp,
        turn: 4,
        candidates: [{ id: "M-11" }],
      },
      {
        kind: "memory_transfer",
        id: "transfer-row",
        transferId: "transfer-gate",
        timestamp,
        turn: 4,
        suggestions: [{
          sourceId: "M-09",
          sourceContent: "Vite needs --host in Docker",
          sourceScope: "project",
          sourceVersion: 7,
          sourceLabel: "Alpha Shop",
          rule: "Bind a reachable interface in containers",
          content: "Bind 0.0.0.0 for this project",
          suggestedScope: "project",
          landing: { route: "new" },
        }],
      },
      {
        kind: "memory_checkup",
        id: "checkup-row",
        checkupId: "checkup-gate",
        timestamp,
        turn: 4,
        suggestions: [{ kind: "staleness", memoryId: "M-03", reason: "temporary note expired" }],
      },
    ] as unknown as ReviewMessage[]
    const controller = createFocusedMemoryReviewController({
      reviewId: "turn-4-review",
      chatContext: { chatId: "chat-038-s1", projectId: "project-038" },
      messages,
      stale: false,
      onMemoryProposalsRespond: () => undefined,
      onMemoryTransferRespond: () => undefined,
      onMemoryCheckupRespond: () => undefined,
      progress: {
        settledTransferRows: new Map([["M-09", "saved as M-12"]]),
        resolvedCheckupRows: new Map([["M-03", "archived"]]),
      },
      onTransferSettled: () => undefined,
      onCheckupResolved: () => undefined,
    })

    const html = renderToStaticMarkup(<FocusedMemoryChangesReview controller={controller} />)

    expect(html).toContain("Memory Board review")
    expect(html).toContain("Step 1")
    expect(html).toContain("Review New Memory Candidates")
    expect(html).toContain("Step 2")
    expect(html).toContain("Transfer Suggestions")
    expect(html).toContain("Step 3")
    expect(html).toContain("Review Suggested Changes to Existing Memories")
    expect(html).toContain("saved as M-12")
    expect(html).toContain("archived")
    expect(html).toContain("Working Memory remains separate")
    expect(html).not.toContain("Working Memory for This Turn")
    expect(html).not.toContain("Go to Memory Board")
    expect(html.match(/data-memory-control-surface="board"/g)).toHaveLength(3)
  })
})
