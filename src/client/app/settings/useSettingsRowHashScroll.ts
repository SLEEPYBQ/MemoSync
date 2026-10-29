import { useEffect } from "react"

/** Kanna's row jump behavior, scoped to the settings scroller. */
export function useSettingsRowHashScroll(hash: string, ready: boolean, sectionId: string) {
  useEffect(() => {
    if (!ready || !hash) return
    let rowId: string
    try { rowId = decodeURIComponent(hash.replace(/^#/, "")) } catch { return }
    let frame = 0
    let timeout: number | undefined
    let highlighted: HTMLElement | null = null
    let attempts = 0
    function tryScroll() {
      const row = document.getElementById(rowId)
      if (!row?.hasAttribute("data-settings-row")) {
        if (++attempts < 20) frame = requestAnimationFrame(tryScroll)
        return
      }
      row.scrollIntoView({ block: "center" })
      highlighted = row
      row.classList.add("bg-muted", "transition-colors", "duration-700")
      timeout = window.setTimeout(() => row.classList.remove("bg-muted"), 900)
    }
    frame = requestAnimationFrame(tryScroll)
    return () => {
      cancelAnimationFrame(frame)
      if (timeout !== undefined) window.clearTimeout(timeout)
      highlighted?.classList.remove("bg-muted", "transition-colors", "duration-700")
    }
  }, [hash, ready, sectionId])
}
