// Adapted from pingdotgg/t3code (MIT License): apps/mobile/src/features/threads/composerSendPresentation.ts
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES/MIT-T3Code.

export type ActiveTurnComposerAction = "queue" | "steer"
export type FollowUpBehavior = ActiveTurnComposerAction

export interface ComposerSendPresentation {
  readonly label: string
  readonly icon: "arrow.up" | "tray.and.arrow.up" | "checkmark" | "list.number" | "arrow.turn.left.up"
  readonly action: ActiveTurnComposerAction | null
  readonly alternate: ActiveTurnComposerAction | null
  readonly offersFollowUpChoice: boolean
}

const ACTION_LABEL: Record<ActiveTurnComposerAction, string> = {
  queue: "Queue",
  steer: "Steer",
}

function alternateComposerDispatchAction(action: ActiveTurnComposerAction): ActiveTurnComposerAction {
  return action === "queue" ? "steer" : "queue"
}

/**
 * Tiny send-button state machine, kept close to T3's: idle sends; an active
 * turn queues by default or steers when the user chooses that follow-up mode.
 */
export function resolveComposerSendPresentation(input: {
  readonly editingQueuedMessage: boolean
  readonly running: boolean
  readonly canSteer: boolean
  readonly followUpBehavior: FollowUpBehavior
  readonly deliveryDeferred: boolean
}): ComposerSendPresentation {
  if (input.editingQueuedMessage) {
    return {
      label: "Update queued message",
      icon: "checkmark",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    }
  }
  if (!input.running) {
    return {
      label: input.deliveryDeferred ? ACTION_LABEL.queue : "Send",
      icon: input.deliveryDeferred ? "tray.and.arrow.up" : "arrow.up",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    }
  }
  const action: ActiveTurnComposerAction = input.canSteer ? input.followUpBehavior : "queue"
  const alternate = alternateComposerDispatchAction(action)
  return {
    label: ACTION_LABEL[action],
    icon: action === "steer" ? "arrow.turn.left.up" : "list.number",
    action,
    alternate: input.canSteer ? alternate : null,
    offersFollowUpChoice: input.canSteer,
  }
}
