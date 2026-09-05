import { describe, it, expect } from "bun:test"
import { buildViolatedCitationsByMessageId, violatedCitationsSignature } from "./violatedCitations"
import type { HydratedTranscriptMessage } from "../../shared/types"

const base = { messageId: undefined, timestamp: "2026-07-16T00:00:00.000Z" }

function user(id: string): HydratedTranscriptMessage {
  return { ...base, id, kind: "user_prompt", content: "u" } as HydratedTranscriptMessage
}

function reply(id: string): HydratedTranscriptMessage {
  return { ...base, id, kind: "assistant_text", text: "per [M-01] and [M-07]" } as HydratedTranscriptMessage
}

function traceOf(
  id: string,
  labels: Array<{ id: string; label: "operational" | "violated" | "injected_without_effect" }>,
): HydratedTranscriptMessage {
  return { ...base, id, kind: "memory_trace", labels } as HydratedTranscriptMessage
}

describe("buildViolatedCitationsByMessageId", () => {
  it("folds violated verdicts onto the replies of the SAME turn segment only", () => {
    const map = buildViolatedCitationsByMessageId([
      user("u1"),
      reply("a1"),
      reply("a2"),
      traceOf("t1", [
        { id: "M-01", label: "violated" },
        { id: "M-02", label: "operational" },
      ]),
      user("u2"),
      reply("a3"),
      traceOf("t2", [{ id: "M-02", label: "operational" }]),
    ])!

    expect([...map.get("a1")!]).toEqual(["M-01"])
    expect([...map.get("a2")!]).toEqual(["M-01"])
    // Turn 2 had no violation — its reply carries nothing.
    expect(map.has("a3")).toBe(false)
  })

  it("post-tool follow-up turns (no user_prompt between) blame only their own replies", () => {
    // Turn A ends at trace t1; turn B is a post-tool continuation — appended
    // with NO new user_prompt. t2's violation must not red-mark a1.
    const map = buildViolatedCitationsByMessageId([
      user("u1"),
      reply("a1"),
      traceOf("t1", [{ id: "M-01", label: "operational" }]),
      reply("b1"),
      traceOf("t2", [{ id: "M-01", label: "violated" }]),
    ])!

    expect(map.has("a1")).toBe(false)
    expect([...map.get("b1")!]).toEqual(["M-01"])
  })

  it("returns null when no turn violated anything (the common case stays cheap)", () => {
    expect(
      buildViolatedCitationsByMessageId([
        user("u1"),
        reply("a1"),
        traceOf("t1", [{ id: "M-01", label: "operational" }]),
      ]),
    ).toBeNull()
  })

  it("skips hidden messages and traces with no preceding reply", () => {
    const hiddenReply = { ...reply("a1"), hidden: true } as HydratedTranscriptMessage
    expect(
      buildViolatedCitationsByMessageId([
        user("u1"),
        hiddenReply,
        traceOf("t1", [{ id: "M-01", label: "violated" }]),
      ]),
    ).toBeNull()
  })

  it("signature is stable across rebuilds and changes when verdicts change", () => {
    const build = () =>
      buildViolatedCitationsByMessageId([
        user("u1"),
        reply("a1"),
        traceOf("t1", [{ id: "M-01", label: "violated" }]),
      ])
    expect(violatedCitationsSignature(build())).toBe(violatedCitationsSignature(build()))
    expect(violatedCitationsSignature(build())).not.toBe(violatedCitationsSignature(null))
  })
})
