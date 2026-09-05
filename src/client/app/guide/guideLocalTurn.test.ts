import { describe, expect, test } from "bun:test"
import type { ExpectedMemoryUse } from "../../../shared/types"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { dispatchPreviewDemoDecision, type PreviewDemoDecision } from "../../components/messages/render-context"
import { buildMemoSyncScenes } from "./guideScenes"
import {
  applyGuideLocalTurn,
  createGuideLocalTurnState,
  reduceGuideLocalTurn,
} from "./guideLocalTurn"

describe("Guide local turn controller", () => {
  test("Enter appends a local participant message and starts the demo turn", () => {
    const scripted = buildMemoSyncScenes().final
    const state = reduceGuideLocalTurn(createGuideLocalTurnState(), {
      type: "submit",
      content: "Please also cover the empty-cart case.",
      createdAt: 1_800_000_000_000,
    })

    const scene = applyGuideLocalTurn(scripted, state)
    expect(scene.entries.at(-1)).toMatchObject({
      kind: "user_prompt",
      content: "Please also cover the empty-cart case.",
    })
    expect(scene.statusLabel).toBe("starting")
    expect(state.running).toBe(true)
    expect(processTranscriptMessages(scene.entries).at(-1)).toMatchObject({
      kind: "user_prompt",
      content: "Please also cover the empty-cart case.",
    })
  })

  test("Stop appends the production interruption receipt and clears the running footer", () => {
    const scripted = buildMemoSyncScenes().replying
    const state = reduceGuideLocalTurn(createGuideLocalTurnState(), {
      type: "stop",
      createdAt: 1_800_000_000_100,
    })

    const scene = applyGuideLocalTurn(scripted, state)
    expect(scene.entries.at(-1)).toMatchObject({ kind: "interrupted" })
    expect(scene.statusLabel).toBeUndefined()
    expect(scene.streamingText).toBeUndefined()
    expect(state.running).toBe(false)
    expect(processTranscriptMessages(scene.entries).at(-1)?.kind).toBe("interrupted")
  })

  test("Start folds a real preview decision into the local scene and begins running", () => {
    const scripted = buildMemoSyncScenes().previewOpen
    const expectedUses: ExpectedMemoryUse[] = [
      { id: "M-02", expectedUse: "Use CartContext.clearCart." },
    ]
    const state = reduceGuideLocalTurn(createGuideLocalTurnState(), {
      type: "preview_decision",
      previewId: "v1",
      decision: "go_on",
      selectedIds: ["M-02"],
      expectedUses,
      prompt: "Add a Clear cart button.",
      createdAt: 1_800_000_000_200,
    })

    const scene = applyGuideLocalTurn(scripted, state)
    const preview = processTranscriptMessages(scene.entries).find((message) => message.kind === "memory_preview")
    expect(preview).toMatchObject({
      kind: "memory_preview",
      decision: "go_on",
      decisionSelectedIds: ["M-02"],
      decisionExpectedUses: expectedUses,
    })
    expect(scene.statusLabel).toBe("starting")
    expect(state.restoredPrompt).toBeNull()
  })

  test("Dismiss folds the decision, stops locally, and returns the task to the composer", () => {
    const scripted = buildMemoSyncScenes().previewOpen
    const state = reduceGuideLocalTurn(createGuideLocalTurnState(), {
      type: "preview_decision",
      previewId: "v1",
      decision: "dismiss",
      prompt: "Add a Clear cart button.",
      createdAt: 1_800_000_000_300,
    })

    const scene = applyGuideLocalTurn(scripted, state)
    const preview = processTranscriptMessages(scene.entries).find((message) => message.kind === "memory_preview")
    expect(preview).toMatchObject({ kind: "memory_preview", decision: "dismiss" })
    expect(scene.statusLabel).toBeUndefined()
    expect(state.running).toBe(false)
    expect(state.restoredPrompt).toBe("Add a Clear cart button.")
  })

  test("Long-term Continue actions settle the real local gate sequence", () => {
    let state = createGuideLocalTurnState()
    state = reduceGuideLocalTurn(state, {
      type: "proposals_decision",
      proposalsId: "p1",
      decision: "reviewed",
      createdAt: 1_800_000_000_400,
    })
    state = reduceGuideLocalTurn(state, {
      type: "transfer_decision",
      transferId: "t1",
      decision: "handled",
      createdAt: 1_800_000_000_500,
    })
    state = reduceGuideLocalTurn(state, {
      type: "checkup_decision",
      checkupId: "c1",
      decision: "handled",
      createdAt: 1_800_000_000_600,
    })

    expect(state.entries.map((entry) => entry.kind)).toEqual([
      "memory_proposals_decision",
      "memory_transfer_decision",
      "memory_checkup_decision",
    ])
  })

  test("the production preview demo bridge reports the chosen set without transport", () => {
    const reports: PreviewDemoDecision[] = []
    const report: PreviewDemoDecision = {
      previewId: "v1",
      decision: "go_on",
      selectedIds: ["M-02"],
      expectedUses: [{ id: "M-02", expectedUse: "Use CartContext.clearCart." }],
      prompt: "Add a Clear cart button.",
    }

    expect(dispatchPreviewDemoDecision({ reviseReply: "local", onDecision: (decision) => reports.push(decision) }, report)).toBe(true)
    expect(reports).toEqual([report])
    expect(dispatchPreviewDemoDecision(undefined, report)).toBe(false)
  })
})
