export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denial can still allow the user-initiated legacy copy.
  }

  if (typeof document === "undefined" || !document.body) return false

  const activeElement = document.activeElement
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const input = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
    ? activeElement
    : null
  const inputSelection = input
    ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
    : null
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.tabIndex = -1
  Object.assign(textarea.style, { position: "fixed", left: "-9999px", top: "0", fontSize: "16px" })

  try {
    const container = activeElement?.parentElement ?? document.body
    container.appendChild(textarea)
    textarea.select()
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea.remove()
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
    if (input && inputSelection?.start != null && inputSelection.end != null) {
      input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined)
    }
  }
}
