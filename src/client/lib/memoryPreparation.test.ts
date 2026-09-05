import { describe, expect, test } from "bun:test"
import { hasOpenMemoryPreparationStep } from "./memoryPreparation"
import { processTranscriptMessages } from "./parseTranscript"

// Raw entries shaped like a real turn: user prompt, empty Step 1, empty
// Step 2 checkup, decided preview. Mirrors transcript f941655f (2026-08-11),
// where an unsettled empty checkup suppressed the streaming footer for the
// whole turn.
let n = 0
const base = () => ({ _id: `e${++n}`, createdAt: 1_786_440_763_000 + n * 1000 })

function emptyPreparationTurn({ checkupDecided }: { checkupDecided: boolean }) {
  const entries: Parameters<typeof processTranscriptMessages>[0] = [
    { ...base(), kind: "user_prompt", content: "task", attachments: [] },
    { ...base(), kind: "memory_proposals", proposalsId: "p1", turn: 1, pending: true, candidates: [] },
    { ...base(), kind: "memory_proposals_result", proposalsId: "p1", candidates: [] },
    { ...base(), kind: "memory_proposals_decision", proposalsId: "p1", decision: "empty" },
    { ...base(), kind: "memory_checkup", checkupId: "c1", turn: 1, pending: true },
    { ...base(), kind: "memory_checkup_result", checkupId: "c1", suggestions: [] },
    { ...base(), kind: "memory_preview", previewId: "v1", turn: 1, task: "task", memories: [] },
    { ...base(), kind: "memory_preview_decision", previewId: "v1", decision: "without_memory", expectedUses: [] },
  ] as Parameters<typeof processTranscriptMessages>[0]
  if (checkupDecided) {
    entries.splice(6, 0, {
      ...base(),
      kind: "memory_checkup_decision",
      checkupId: "c1",
      decision: "empty",
    } as (typeof entries)[number])
  }
  return processTranscriptMessages(entries)
}

describe("hasOpenMemoryPreparationStep", () => {
  test("a settled empty-checkup turn keeps the streaming footer visible", () => {
    expect(hasOpenMemoryPreparationStep(emptyPreparationTurn({ checkupDecided: true }))).toBe(false)
  })

  test("a settled failed Checkup also releases the streaming footer", () => {
    const messages = processTranscriptMessages([
      { ...base(), kind: "user_prompt", content: "task", attachments: [] },
      { ...base(), kind: "memory_checkup", checkupId: "c-failed", turn: 1, pending: true },
      { ...base(), kind: "memory_checkup_result", checkupId: "c-failed", suggestions: [], failedKinds: ["conflict"] },
      { ...base(), kind: "memory_checkup_decision", checkupId: "c-failed", decision: "failed" },
    ])

    expect(hasOpenMemoryPreparationStep(messages)).toBe(false)
  })

  test("legacy turns without a checkup decision still read as open (why the server must settle)", () => {
    expect(hasOpenMemoryPreparationStep(emptyPreparationTurn({ checkupDecided: false }))).toBe(true)
  })

  test("an undecided preview gate keeps the footer hidden", () => {
    const withOpenPreview = processTranscriptMessages([
      { ...base(), kind: "user_prompt", content: "task", attachments: [] },
      { ...base(), kind: "memory_preview", previewId: "v2", turn: 1, task: "task", memories: [] },
    ] as Parameters<typeof processTranscriptMessages>[0])
    expect(hasOpenMemoryPreparationStep(withOpenPreview)).toBe(true)
  })

  test("only the latest turn counts — an old open step does not gate the next turn", () => {
    const previousTurn = emptyPreparationTurn({ checkupDecided: false })
    const nextTurn = processTranscriptMessages([
      { ...base(), kind: "user_prompt", content: "again", attachments: [] },
    ] as Parameters<typeof processTranscriptMessages>[0])
    expect(hasOpenMemoryPreparationStep([...previousTurn, ...nextTurn])).toBe(false)
  })
})
