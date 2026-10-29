import type { SubmitWhileRunning } from "./types"

export function shouldSteerSubmit(mode: SubmitWhileRunning, withModifier: boolean) {
  return (mode === "steer") !== withModifier
}

export function resolveModifiedEnter(composer: { text: string; attachmentCount: number }, hasQueuedMessage: boolean): "composer" | "send-oldest-queued" | "none" {
  if (composer.text.trim().length > 0 || composer.attachmentCount > 0) return "composer"
  return hasQueuedMessage ? "send-oldest-queued" : "none"
}

/** Resolve only submission keys; slash completion and other shortcuts keep their existing priority. */
export function resolveComposerEnter(args: {
  key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; nativeEvent: { isComposing?: boolean; keyCode?: number }
  disabled: boolean; touch: boolean; pendingUploads: boolean; running: boolean
  mode: SubmitWhileRunning; text: string; attachmentCount: number; hasQueuedMessage: boolean
}): "none" | "queue" | "steer" | "send-oldest-queued" {
  if (args.key !== "Enter" || args.shiftKey || args.disabled || (args.nativeEvent.isComposing === true || args.nativeEvent.keyCode === 229)) return "none"
  const modified = args.metaKey || args.ctrlKey
  if (args.touch && !modified) return "none"
  if (modified && resolveModifiedEnter(args, args.hasQueuedMessage) === "send-oldest-queued") return "send-oldest-queued"
  if (args.pendingUploads || (!args.text.trim() && !args.attachmentCount)) return "none"
  return args.running && shouldSteerSubmit(args.mode, modified) ? "steer" : "queue"
}
