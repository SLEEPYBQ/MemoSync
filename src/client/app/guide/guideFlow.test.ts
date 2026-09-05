import { describe, expect, test } from "bun:test"
import {
  GUIDE_FLOW_PHASES,
  advanceGuideStepIndex,
  clampGuideStepIndex,
  createGuideFlowState,
  reduceGuideFlow,
} from "./guideFlow"

describe("Guide flow", () => {
  test("System use starts at session setup before New Chat creates an empty chat", () => {
    const initial = createGuideFlowState()
    const emptyChat = reduceGuideFlow(initial, { type: "new_chat" })

    expect(initial.phase).toBe("session_setup")
    expect(emptyChat.phase).toBe("empty_chat")
  })

  test("sending the first prompt holds its exact local text before the Board opens", () => {
    const prompt = "  Build the cart flow.\nKeep the existing API shape.  "
    const emptyChat = reduceGuideFlow(createGuideFlowState(), { type: "new_chat" })

    const held = reduceGuideFlow(emptyChat, { type: "first_prompt_sent", prompt })

    expect(held.phase).toBe("first_prompt_held")
    expect(held.firstPrompt).toEqual({ text: prompt, status: "held" })
  })

  test("Board review tracks pending work until every long-term item is cleared", () => {
    const emptyChat = reduceGuideFlow(createGuideFlowState(), { type: "new_chat" })
    const held = reduceGuideFlow(emptyChat, {
      type: "first_prompt_sent",
      prompt: "Build the cart flow.",
    })
    const review = reduceGuideFlow(held, {
      type: "board_review_opened",
      pending: { candidates: 2, transfers: 1, checkups: 1 },
    })

    const partlyCleared = reduceGuideFlow(review, {
      type: "board_pending_changed",
      pending: { candidates: 0, transfers: 1, checkups: 0 },
    })
    const cleared = reduceGuideFlow(partlyCleared, {
      type: "board_pending_changed",
      pending: { candidates: 0, transfers: 0, checkups: 0 },
    })

    expect(review.phase).toBe("board_review")
    expect(review.boardPending.total).toBe(4)
    expect(partlyCleared.boardPending.total).toBe(1)
    expect(cleared.boardPending).toEqual({
      candidates: 0,
      transfers: 0,
      checkups: 0,
      total: 0,
    })
  })

  test("Board releases the prompt once, then Long-term review finishes before separate Working Memory", () => {
    const prompt = "Build the cart flow exactly as specified."
    const emptyChat = reduceGuideFlow(createGuideFlowState(), { type: "new_chat" })
    const held = reduceGuideFlow(emptyChat, { type: "first_prompt_sent", prompt })
    const review = reduceGuideFlow(held, {
      type: "board_review_opened",
      pending: { candidates: 1, transfers: 0, checkups: 0 },
    })

    const refused = reduceGuideFlow(review, { type: "board_review_completed" })
    expect(refused).toBe(review)
    expect(refused.firstPrompt).toEqual({ text: prompt, status: "held" })

    const cleared = reduceGuideFlow(refused, {
      type: "board_pending_changed",
      pending: { candidates: 0, transfers: 0, checkups: 0 },
    })
    const released = reduceGuideFlow(cleared, { type: "board_review_completed" })
    const duplicateRelease = reduceGuideFlow(released, { type: "board_review_completed" })

    expect(released.phase).toBe("board_review")
    expect(released.firstPrompt).toEqual({ text: prompt, status: "released" })
    expect(duplicateRelease).toBe(released)

    const workingMemory = reduceGuideFlow(released, { type: "long_term_review_completed" })
    expect(workingMemory.phase).toBe("working_memory")
  })

  test("publishes the stable 12-phase journey through interrupt, recovery, resume, audit, and finish", () => {
    expect(GUIDE_FLOW_PHASES).toEqual([
      "task_brief",
      "session_setup",
      "empty_chat",
      "first_prompt_held",
      "board_review",
      "working_memory",
      "running",
      "interrupted",
      "recovery",
      "resumed",
      "audited",
      "finished",
    ])

    let state = createGuideFlowState()
    state = reduceGuideFlow(state, { type: "new_chat" })
    state = reduceGuideFlow(state, { type: "first_prompt_sent", prompt: "Build it." })
    state = reduceGuideFlow(state, {
      type: "board_review_opened",
      pending: { candidates: 0, transfers: 0, checkups: 0 },
    })
    state = reduceGuideFlow(state, { type: "board_review_completed" })
    state = reduceGuideFlow(state, { type: "long_term_review_completed" })
    state = reduceGuideFlow(state, { type: "working_memory_confirmed" })
    expect(state.phase).toBe("running")

    state = reduceGuideFlow(state, { type: "memory_interrupted" })
    expect(state.phase).toBe("interrupted")
    state = reduceGuideFlow(state, { type: "recovery_opened" })
    expect(state.phase).toBe("recovery")
    state = reduceGuideFlow(state, { type: "turn_resumed" })
    expect(state.phase).toBe("resumed")
    state = reduceGuideFlow(state, { type: "turn_audited" })
    expect(state.phase).toBe("audited")
    state = reduceGuideFlow(state, { type: "session_finished" })
    expect(state.phase).toBe("finished")
    expect(state.firstPrompt?.text).toBe("Build it.")
  })

  test("clamps direct and repeated Next navigation to a valid Guide step", () => {
    expect(clampGuideStepIndex(-3, 4)).toBe(0)
    expect(clampGuideStepIndex(99, 4)).toBe(3)
    expect(clampGuideStepIndex(Number.NaN, 4)).toBe(0)
    expect(clampGuideStepIndex(2, 0)).toBe(0)
    expect(advanceGuideStepIndex(0, 3)).toBe(1)
    expect(advanceGuideStepIndex(2, 3)).toBe(2)
  })
})
