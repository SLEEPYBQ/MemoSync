export interface ComposingKeyEventLike {
  isComposing?: boolean
  keyCode?: number
}

// IME composition: while the user is picking pinyin candidates, Enter/Escape
// belong to the IME, not to us. keyCode 229 covers the commit keydown that
// some browsers (Safari) fire after isComposing has already flipped false.
export function isImeComposingKeyEvent(event: ComposingKeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229
}
