// Deep-link targets inside the Memory Board (?focus=…) — the landing page's
// "Review candidates" card jumps straight to the candidate lane.
export type BoardFocus = "candidates"

export function parseBoardFocus(search: string): BoardFocus | null {
  const focus = new URLSearchParams(search).get("focus")
  return focus === "candidates" ? "candidates" : null
}
