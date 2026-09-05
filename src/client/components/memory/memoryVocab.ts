// Single source of truth for MemoSync's visual vocabulary: the per-card trace
// "health" dot and the board "freshness" marks, plus the plain-language meaning
// of every scope, type, dot, and freshness mark. The Board cards, the in-chat
// capture cards, and the MemoryLegend all read these same maps, so a swatch in
// the legend always matches the mark on the card. (The dot/freshness class maps
// used to live privately inside MemoryCard, where the legend could not reach
// them and the two could silently drift.) Meanings are kept accurate to how
// each mark is actually produced (capture.ts conflicts, the trace pass, and the
// board-visit diff in boardVisit.ts).
import type { MemoryScope, MemoryType } from "../../lib/memoriesApi"

// Mirrors MemoryTraceLabel in src/server/memory/types.ts (not re-exported to the
// client, so restated here as the client-facing verdict union).
export type TraceVerdict = "operational" | "injected_without_effect" | "violated" | "not_applicable"
export type Freshness = "new" | "changed"

// Latest trace verdict → health dot. Palette-native, no traffic lights:
// a filled neutral dot = it shaped a turn; the app's rose (destructive/logo
// family) = the last injection was contradicted; faint gray = along for the
// ride. Amber stays reserved for capture (cand-*), rose for violation.
export const TRACE_DOT_CLASSES: Record<TraceVerdict, string> = {
  operational: "bg-foreground/60",
  violated: "bg-destructive",
  injected_without_effect: "bg-muted-foreground/40",
  // Slate: had no object to apply to this turn (distinct from "changed nothing").
  not_applicable: "bg-slate-400/50",
}

// Touched since the user's last board visit — the meta-model diff marker.
export const FRESHNESS_CLASSES: Record<Freshness, string> = {
  new: "border-cand-border bg-cand-surface text-cand-fg",
  changed: "border-project-border bg-project-surface text-project-fg",
}

export const SCOPE_LEGEND: { scope: MemoryScope; meaning: string }[] = [
  { scope: "personal", meaning: "Applies across all your projects." },
  { scope: "project", meaning: "Applies only inside this project." },
  { scope: "session", meaning: "Applies only inside this one chat." },
]

export const TYPE_LEGEND: { type: MemoryType; meaning: string }[] = [
  { type: "constraint", meaning: "A rule the agent should not break." },
  { type: "preference", meaning: "How you like things done." },
  { type: "lesson", meaning: "Something learned the hard way." },
  { type: "fact", meaning: "Plain ground truth about your setup." },
]

export const TRACE_DOT_LEGEND: { verdict: TraceVerdict; label: string; meaning: string }[] = [
  { verdict: "operational", label: "shaped the reply", meaning: "The agent followed it in its last reply." },
  { verdict: "violated", label: "violated", meaning: "The agent acted against it last time." },
  { verdict: "injected_without_effect", label: "no visible effect", meaning: "Included, but no detectable influence on the reply." },
  { verdict: "not_applicable", label: "not applicable", meaning: "Nothing in that turn it could apply to." },
]

export const FRESHNESS_LEGEND: { freshness: Freshness; label: string; meaning: string }[] = [
  { freshness: "new", label: "new", meaning: "Added since your last visit here." },
  { freshness: "changed", label: "changed", meaning: "Edited since your last visit here." },
]
