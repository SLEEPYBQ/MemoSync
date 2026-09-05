import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { TranscriptRenderOptionsProvider } from "./render-context"
import {
  buildCandidateActivationScopePatch,
  buildCandidateDraftPatch,
  MemoryCandidatesMessage,
  runCandidateMutation,
} from "./MemoryCandidatesMessage"

test("manual candidate edits explicitly clear a removed sensitive detail", () => {
  expect(buildCandidateDraftPatch(" sanitized ", "   ")).toEqual({
    content: "sanitized",
    detail: "",
  })
})

test("generic Board review accepts a Candidate into its canonical saved binding without chat context", () => {
  expect(buildCandidateActivationScopePatch({
    scope: "project",
    candidateProjectId: "project-saved",
  })).toEqual({ patch: { status: "active", scope: "project", projectId: "project-saved" } })

  expect(buildCandidateActivationScopePatch({
    scope: "session",
    candidateSessionId: "chat-saved",
  })).toEqual({ patch: { status: "active", scope: "session", sessionId: "chat-saved" } })
})

test("publishes a canonical Candidate change immediately after the mutation succeeds", async () => {
  const order: string[] = []

  const result = await runCandidateMutation(
    async () => {
      order.push("mutated")
      return "saved"
    },
    async () => { order.push("refreshed") },
  )

  expect(result).toBe("saved")
  expect(order).toEqual(["mutated", "refreshed"])
})

test("standalone transcripts omit candidate drafts without contacting the live memory API", () => {
  const message: Extract<HydratedTranscriptMessage, { kind: "memory_candidates" }> = {
    kind: "memory_candidates",
    id: "candidate-message-1",
    timestamp: "2026-07-14T00:00:00.000Z",
    candidates: [{
      id: "M-01",
      // Legacy transcripts may contain these fields. The readonly renderer
      // must not expose them in a share/export.
      content: "sk-legacy-secret",
      detail: "person@example.com",
      type: "fact",
      scope: "personal",
      abstractionLevel: "concrete",
      sensitive: true,
    }],
  }

  const html = renderToStaticMarkup(
    <TranscriptRenderOptionsProvider value={{ readonly: true }}>
      <MemoryCandidatesMessage message={message} />
    </TranscriptRenderOptionsProvider>,
  )

  expect(html).toContain("omitted from this export for privacy")
  expect(html).not.toContain("sk-legacy-secret")
  expect(html).not.toContain("person@example.com")
})
