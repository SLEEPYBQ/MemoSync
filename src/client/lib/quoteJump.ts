// Locate a trace quote inside the rendered transcript and flash it. Shared by
// the in-stream Trace fold ("where used") and the Timeline rail's violation
// rows — one definition of "jump to the sentence" for every monitoring surface.

export function normalizeQuoteText(s: string): string {
  return s.replace(/[*_`~#>[\]()]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

/**
 * The block (paragraph / list item / …) whose text contains the quote.
 * Block-level matching is robust to markdown re-rendering; exact character
 * ranges across re-rendered markdown are brittle.
 *
 * With an `origin` inside the transcript (the Trace fold), the nearest
 * matching block ABOVE the origin wins — that pins the jump to the right
 * turn. From outside the transcript (the side-panel timeline), the first
 * match wins; trace quotes are verbatim sentences, so collisions are rare.
 */
export function findQuoteBlock(quote: string, origin: HTMLElement | null): HTMLElement | null {
  const target = normalizeQuoteText(quote)
  if (target.length < 6) return null
  const root =
    origin?.closest<HTMLElement>("[data-transcript-list]") ??
    document.querySelector<HTMLElement>("[data-transcript-list]")
  if (!root) return null
  const anchored = Boolean(origin && root.contains(origin))
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("p, li, blockquote, pre, h1, h2, h3, h4"))

  const searchFor = (needle: string): HTMLElement | null => {
    let best: HTMLElement | null = null
    for (const el of blocks) {
      if (!normalizeQuoteText(el.textContent || "").includes(needle)) continue
      if (!anchored) return el
      if (origin!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) best = el
      else break
    }
    return best
  }

  const exact = searchFor(target)
  if (exact) return exact
  // A quote that spans multiple rendered blocks (markdown re-paragraphing)
  // matches no single block — fall back to its leading slice, which lives in
  // the FIRST of those blocks (where the jump should land anyway).
  if (target.length > 60) {
    const prefix = target.slice(0, 60)
    return searchFor(prefix)
  }
  return null
}

/**
 * Fallback jump target when the audit stored no quote: the block containing
 * the reply's own inline [M-NN] citation chip (self-reported rows always have
 * one). Nearest-above-origin wins, same anchoring rule as findQuoteBlock.
 */
export function findCitationBlock(memoryId: string, origin: HTMLElement | null): HTMLElement | null {
  const root =
    origin?.closest<HTMLElement>("[data-transcript-list]") ??
    document.querySelector<HTMLElement>("[data-transcript-list]")
  if (!root) return null
  const anchored = Boolean(origin && root.contains(origin))
  const label = `[${memoryId}]`
  let best: HTMLElement | null = null
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("span"))) {
    if ((el.textContent || "").trim() !== label) continue
    // Skip the chip inside the audit card itself (it precedes nothing useful).
    if (origin && origin.contains(el)) continue
    const block = el.closest<HTMLElement>("p, li, blockquote, pre, h1, h2, h3, h4") ?? el
    if (!anchored) return block
    if (origin!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) best = block
    else break
  }
  return best
}

/** Scroll a block into view and replay its highlight animation. */
export function flashQuoteBlock(el: HTMLElement, className = "citation-flash-block", ms = 1900): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.classList.remove(className)
  void el.offsetWidth // restart the animation if the same target is re-jumped
  el.classList.add(className)
  window.setTimeout(() => el.classList.remove(className), ms)
}
