// Composer "/" autocomplete over the slash commands the engine reported in
// its system_init (custom commands + skills are executed by the engine when
// the prompt starts with /name — this popup only helps discover/complete).
export interface SlashCommandMatch {
  query: string
  matches: string[]
}

export function matchSlashCommands(value: string, commands: string[]): SlashCommandMatch | null {
  if (commands.length === 0) return null
  if (!value.startsWith("/")) return null
  if (/[\s\n]/.test(value)) return null
  const query = value.slice(1).toLowerCase()
  const prefix: string[] = []
  const substring: string[] = []
  for (const command of commands) {
    const lower = command.toLowerCase()
    if (lower.startsWith(query)) prefix.push(command)
    else if (query && lower.includes(query)) substring.push(command)
  }
  // No cap — hiding commands reads as "not supported"; the popup scrolls.
  const matches = [...prefix, ...substring]
  return matches.length ? { query, matches } : null
}

/** Tallest the popup gets — matches the previous fixed max-h-72 (288px). */
export const SLASH_POPUP_MAX_HEIGHT_PX = 288
/** The popup floats 8px (mb-2) above its anchor. */
export const SLASH_POPUP_ANCHOR_GAP_PX = 8
/** Breathing room kept clear of the viewport top. */
export const SLASH_POPUP_VIEWPORT_MARGIN_PX = 12
/** Below this the list is unusable — accept slight clipping instead. */
export const SLASH_POPUP_MIN_HEIGHT_PX = 96

// The popup opens upward; cap its height to the space actually above the
// composer so it never clips off the viewport top (the landing page centers
// the composer, unlike the chat page's bottom dock).
export function slashPopupMaxHeightPx(anchorTopPx: number): number {
  const available = Math.floor(anchorTopPx - SLASH_POPUP_ANCHOR_GAP_PX - SLASH_POPUP_VIEWPORT_MARGIN_PX)
  return Math.max(SLASH_POPUP_MIN_HEIGHT_PX, Math.min(SLASH_POPUP_MAX_HEIGHT_PX, available))
}
