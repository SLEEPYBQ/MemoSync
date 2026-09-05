export const GUIDE_FLOW_PHASES = [
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
] as const

export type GuideFlowPhase = (typeof GUIDE_FLOW_PHASES)[number]

export interface GuideFirstPrompt {
  readonly text: string
  readonly status: "held" | "released"
}

export interface GuideBoardPendingInput {
  readonly candidates: number
  readonly transfers: number
  readonly checkups: number
}

export interface GuideBoardPending extends GuideBoardPendingInput {
  readonly total: number
}

export interface GuideFlowState {
  readonly phase: GuideFlowPhase
  readonly firstPrompt: GuideFirstPrompt | null
  readonly boardPending: GuideBoardPending
}

export type GuideFlowEvent =
  | { readonly type: "new_chat" }
  | { readonly type: "first_prompt_sent"; readonly prompt: string }
  | { readonly type: "board_review_opened"; readonly pending: GuideBoardPendingInput }
  | { readonly type: "board_pending_changed"; readonly pending: GuideBoardPendingInput }
  | { readonly type: "board_review_completed" }
  | { readonly type: "long_term_review_completed" }
  | { readonly type: "working_memory_confirmed" }
  | { readonly type: "memory_interrupted" }
  | { readonly type: "recovery_opened" }
  | { readonly type: "turn_resumed" }
  | { readonly type: "turn_audited" }
  | { readonly type: "session_finished" }

const EMPTY_BOARD_PENDING: GuideBoardPending = {
  candidates: 0,
  transfers: 0,
  checkups: 0,
  total: 0,
}

function withTotal(pending: GuideBoardPendingInput): GuideBoardPending {
  return {
    ...pending,
    total: pending.candidates + pending.transfers + pending.checkups,
  }
}

export function createGuideFlowState(): GuideFlowState {
  return {
    phase: "session_setup",
    firstPrompt: null,
    boardPending: EMPTY_BOARD_PENDING,
  }
}

export function reduceGuideFlow(
  state: GuideFlowState,
  event: GuideFlowEvent,
): GuideFlowState {
  if (state.phase === "session_setup" && event.type === "new_chat") {
    return { ...state, phase: "empty_chat" }
  }

  if (state.phase === "empty_chat" && event.type === "first_prompt_sent") {
    return {
      ...state,
      phase: "first_prompt_held",
      firstPrompt: { text: event.prompt, status: "held" },
    }
  }

  if (state.phase === "first_prompt_held" && event.type === "board_review_opened") {
    return {
      ...state,
      phase: "board_review",
      boardPending: withTotal(event.pending),
    }
  }

  if (state.phase === "board_review" && event.type === "board_pending_changed") {
    return { ...state, boardPending: withTotal(event.pending) }
  }

  if (
    state.phase === "board_review"
    && event.type === "board_review_completed"
    && state.boardPending.total === 0
    && state.firstPrompt
    && state.firstPrompt.status === "held"
  ) {
    return {
      ...state,
      firstPrompt: { ...state.firstPrompt, status: "released" },
    }
  }

  if (
    state.phase === "board_review"
    && event.type === "long_term_review_completed"
    && state.firstPrompt?.status === "released"
  ) {
    return { ...state, phase: "working_memory" }
  }

  if (state.phase === "working_memory" && event.type === "working_memory_confirmed") {
    return { ...state, phase: "running" }
  }

  if (state.phase === "running" && event.type === "memory_interrupted") {
    return { ...state, phase: "interrupted" }
  }

  if (state.phase === "interrupted" && event.type === "recovery_opened") {
    return { ...state, phase: "recovery" }
  }

  if (state.phase === "recovery" && event.type === "turn_resumed") {
    return { ...state, phase: "resumed" }
  }

  if (
    (state.phase === "running" || state.phase === "resumed")
    && event.type === "turn_audited"
  ) {
    return { ...state, phase: "audited" }
  }

  if (state.phase === "audited" && event.type === "session_finished") {
    return { ...state, phase: "finished" }
  }

  return state
}

export function clampGuideStepIndex(index: number, stepCount: number): number {
  const count = Number.isFinite(stepCount) ? Math.max(0, Math.trunc(stepCount)) : 0
  if (count === 0 || Number.isNaN(index) || index === Number.NEGATIVE_INFINITY) return 0
  if (index === Number.POSITIVE_INFINITY) return count - 1
  return Math.min(count - 1, Math.max(0, Math.trunc(index)))
}

export function advanceGuideStepIndex(current: number, stepCount: number): number {
  return clampGuideStepIndex(current + 1, stepCount)
}
