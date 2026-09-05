import type {
  ExpectedMemoryUse,
  MemoryPreviewDecision,
  TranscriptEntry,
} from "../../../shared/types"
import type { GuideScene } from "./guideScenes"

/**
 * A Guide-only overlay on top of a scripted scene. It records actions from
 * the mounted production controls without starting a participant turn or
 * writing to the participant transcript.
 */
export interface GuideLocalTurnState {
  entries: TranscriptEntry[]
  running: boolean | null
  runningStatus: string | null
  restoredPrompt: string | null
  sequence: number
}

export type GuideLocalTurnAction =
  | {
      type: "submit"
      content: string
      createdAt: number
      steered?: boolean
    }
  | {
      type: "stop"
      createdAt: number
    }
  | {
      type: "preview_decision"
      previewId: string
      decision: MemoryPreviewDecision
      selectedIds?: string[]
      expectedUses?: ExpectedMemoryUse[]
      prompt?: string
      createdAt: number
    }
  | {
      type: "proposals_decision"
      proposalsId: string
      decision: "reviewed" | "skipped"
      createdAt: number
    }
  | {
      type: "transfer_decision"
      transferId: string
      decision: "handled" | "skipped"
      createdAt: number
    }
  | {
      type: "checkup_decision"
      checkupId: string
      decision: "handled" | "skipped"
      createdAt: number
    }

type WithoutTranscriptStamp<T> = T extends TranscriptEntry ? Omit<T, "_id" | "createdAt"> : never
type UnstampedTranscriptEntry = WithoutTranscriptStamp<TranscriptEntry>

export function createGuideLocalTurnState(): GuideLocalTurnState {
  return {
    entries: [],
    running: null,
    runningStatus: null,
    restoredPrompt: null,
    sequence: 0,
  }
}

function appendEntry(
  state: GuideLocalTurnState,
  entry: UnstampedTranscriptEntry,
  createdAt: number,
): GuideLocalTurnState {
  const sequence = state.sequence + 1
  return {
    ...state,
    entries: [
      ...state.entries,
      {
        ...entry,
        _id: `guide-local-${sequence}`,
        createdAt,
      } as TranscriptEntry,
    ],
    sequence,
  }
}

export function reduceGuideLocalTurn(
  state: GuideLocalTurnState,
  action: GuideLocalTurnAction,
): GuideLocalTurnState {
  if (action.type === "submit") {
    if (!action.content.trim()) return state
    return {
      ...appendEntry(
        state,
        {
          kind: "user_prompt",
          content: action.content,
          attachments: [],
          steered: action.steered,
        },
        action.createdAt,
      ),
      running: true,
      runningStatus: "starting",
      restoredPrompt: null,
    }
  }

  if (action.type === "stop") {
    return {
      ...appendEntry(state, { kind: "interrupted" }, action.createdAt),
      running: false,
      runningStatus: null,
    }
  }

  if (action.type === "proposals_decision") {
    return appendEntry(
      state,
      {
        kind: "memory_proposals_decision",
        proposalsId: action.proposalsId,
        decision: action.decision,
      },
      action.createdAt,
    )
  }

  if (action.type === "transfer_decision") {
    return appendEntry(
      state,
      {
        kind: "memory_transfer_decision",
        transferId: action.transferId,
        decision: action.decision,
      },
      action.createdAt,
    )
  }

  if (action.type === "checkup_decision") {
    return appendEntry(
      state,
      {
        kind: "memory_checkup_decision",
        checkupId: action.checkupId,
        decision: action.decision,
      },
      action.createdAt,
    )
  }

  const decisionEntry = {
    kind: "memory_preview_decision" as const,
    previewId: action.previewId,
    decision: action.decision,
    ...(action.decision === "go_on" && action.selectedIds
      ? { selectedIds: [...action.selectedIds] }
      : {}),
    ...(action.expectedUses ? { expectedUses: [...action.expectedUses] } : {}),
  }
  const dismissed = action.decision === "dismiss"
  return {
    ...appendEntry(state, decisionEntry, action.createdAt),
    running: !dismissed,
    runningStatus: dismissed ? null : "starting",
    restoredPrompt: dismissed ? (action.prompt ?? null) : null,
  }
}

export function applyGuideLocalTurn(
  scriptedScene: GuideScene,
  state: GuideLocalTurnState,
): GuideScene {
  if (state.entries.length === 0 && state.running === null) return scriptedScene

  if (state.running === false) {
    return {
      entries: [...scriptedScene.entries, ...state.entries],
    }
  }

  return {
    ...scriptedScene,
    entries: [...scriptedScene.entries, ...state.entries],
    ...(state.running === true
      ? { statusLabel: state.runningStatus ?? scriptedScene.statusLabel ?? "starting" }
      : {}),
  }
}
