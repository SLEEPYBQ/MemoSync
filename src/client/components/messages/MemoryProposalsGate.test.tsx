import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { MemoryItem } from "../../lib/memoriesApi"
import {
  candidateReviewState,
  MemoryCandidateReviewStation,
  MemoryProposalsGate,
  PERMANENT_CANDIDATE_DISMISSAL_COPY,
} from "./MemoryProposalsGate"

type ProposalsMessage = Extract<HydratedTranscriptMessage, { kind: "memory_proposals" }>

describe("MemoryProposalsGate", () => {
  test("lets canonical Candidate status override a stale dismissed receipt from another surface", () => {
    const candidate = {
      id: "M-11",
      content: "Run the repository lint command",
      scope: "personal",
      status: "candidate",
      type: "constraint",
      abstractionLevel: "contextual",
      sensitive: false,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      usageCount: 0,
      reinforcedCount: 0,
      version: 1,
      citedInCurrentSession: 0,
    } as MemoryItem
    expect(candidateReviewState(candidate, true)).toBe("candidate")
    expect(candidateReviewState({ ...candidate, status: "discarded" }, false)).toBe("discarded")
    expect(candidateReviewState(undefined, true)).toBe("optimistic-dismissed")
  })

  test("uses the settled summary's Review again as the only gate-level re-entry", () => {
    const message = {
      kind: "memory_proposals",
      id: "shared-proposals",
      proposalsId: "proposals-shared",
      timestamp: "2026-08-19T00:00:00.000Z",
      candidates: [{ id: "M-11" }],
      decision: "reviewed",
    } as unknown as ProposalsMessage

    const html = renderToStaticMarkup(
      <MemoryProposalsGate
        message={message}
        onRespond={() => {}}
        canReopen
        onReopen={() => {}}
      />,
    )

    expect(html).toContain("Review again")
    expect(html).not.toContain("Restore for review")
  })

  test("explains that a hard-dismissed Candidate is not recoverable without retaining its content", () => {
    expect(PERMANENT_CANDIDATE_DISMISSAL_COPY).toContain("permanently removed")
    expect(PERMANENT_CANDIDATE_DISMISSAL_COPY).toContain("cannot be restored")
    expect(PERMANENT_CANDIDATE_DISMISSAL_COPY).not.toContain("content:")
  })

  test("keeps accepted and soft-dismissed Candidate decisions reviewable in the shared station", () => {
    const item = (id: string, status: MemoryItem["status"]) => ({
      id,
      content: `Candidate ${id}`,
      scope: "personal",
      status,
      type: "constraint",
      abstractionLevel: "contextual",
      sensitive: false,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      usageCount: 0,
      reinforcedCount: 0,
      version: 1,
      citedInCurrentSession: 0,
    } as MemoryItem)

    const html = renderToStaticMarkup(
      <MemoryCandidateReviewStation
        candidates={[item("M-accepted", "active"), item("M-dismissed", "discarded")]}
        surface="board"
        allowRestore
      />,
    )

    expect(html).toContain("saved as M-accepted")
    expect(html).toContain("Restore for review")
  })
})
