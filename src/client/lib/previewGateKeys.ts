import { isImeComposingKeyEvent, type ComposingKeyEventLike } from "./imeKeys"

export interface PreviewGateKeyEventLike extends ComposingKeyEventLike {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  defaultPrevented?: boolean
}

export interface PreviewGateTargetLike {
  tagName: string
  isContentEditable?: boolean
  value?: string
}

export type PreviewGateKeyAction = "go_on" | "dismiss"

// Keyboard path for the per-turn gate (STUDY_PLAN §2.4): Enter = go on,
// Esc = dismiss. Only when the user isn't typing: inputs/contentEditable and
// a non-empty composer draft keep the protection, but the (usually focused,
// empty) composer right after a send lets Enter/Esc decide. IME composition
// keydowns never decide — Esc there cancels the pinyin candidate, not the turn.
export function previewGateKeyAction(
  event: PreviewGateKeyEventLike,
  target: PreviewGateTargetLike | null,
): PreviewGateKeyAction | null {
  if (isImeComposingKeyEvent(event)) return null
  // A key someone already claimed (composer Enter-to-send, dialog Escape) never
  // ALSO decides the gate. The value guard below can't catch the send case:
  // React flushes the composer clear before the event bubbles to window, so the
  // gate would read an empty textarea and double-act on the same keystroke.
  if (event.defaultPrevented) return null
  if (target && (target.tagName === "INPUT" || target.isContentEditable)) return null
  if (target && target.tagName === "TEXTAREA" && (target.value ?? "").trim() !== "") return null
  if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    // Enter while an interactive control is focused (a gate button the user
    // Tab'd to, a link) activates THAT control. The gate must not also read it
    // as "go on" and, via preventDefault, suppress the button the user actually
    // chose — that reversed keyboard users' decisions (BUG MSG-4).
    if (target && (target.tagName === "BUTTON" || target.tagName === "A" || target.tagName === "SELECT")) {
      return null
    }
    return "go_on"
  }
  if (event.key === "Escape") return "dismiss"
  return null
}
