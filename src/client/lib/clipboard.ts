/** Async Clipboard is absent on LAN HTTP and can reject in PWAs. Keep the
 * selection fallback in the click gesture, and report success only on a real copy.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined") {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // Try the legacy selection API when browser policy rejects async copy.
    }
  }
  if (typeof document === "undefined") return false
  const previousFocus = document.activeElement
  const helper = document.createElement("textarea")
  helper.value = text
  helper.setAttribute("readonly", "")
  Object.assign(helper.style, { position: "fixed", top: "0", left: "0", opacity: "0" })
  document.body.appendChild(helper)
  try {
    helper.focus()
    helper.select()
    helper.setSelectionRange(0, text.length)
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    helper.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true })
  }
}
