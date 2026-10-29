import { t } from "../../i18n"
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

// Latest trace verdict → semantic status dot. Success marks a shaped turn;
// destructive marks a violation; the remaining outcomes stay neutral.
export const TRACE_DOT_CLASSES: Record<TraceVerdict, string> = {
  operational: "bg-success",
  violated: "bg-destructive",
  injected_without_effect: "bg-muted-foreground/40",
  // Neutral: had no object to apply to this turn (distinct from "changed nothing").
  not_applicable: "bg-muted-foreground/50",
}

// Touched since the user's last board visit — the meta-model diff marker.
export const FRESHNESS_CLASSES: Record<Freshness, string> = {
  new: "border-success/25 bg-success/8 text-success-foreground",
  changed: "border-info/25 bg-info/8 text-info-foreground",
}

export const SCOPE_LEGEND: { scope: MemoryScope; meaning: string }[] = [
  { scope: "personal", get meaning() { return t("memory:appliesAcrossAllYourProjects") } },
  { scope: "project", get meaning() { return t("memory:appliesOnlyInsideThisProject") } },
  { scope: "session", get meaning() { return t("memory:appliesOnlyInsideThisOneChat") } },
]

export const TYPE_LEGEND: { type: MemoryType; meaning: string }[] = [
  { type: "constraint", get meaning() { return t("memory:aRuleTheAgentShouldNotBreak") } },
  { type: "preference", get meaning() { return t("memory:howYouLikeThingsDone") } },
  { type: "lesson", get meaning() { return t("memory:somethingLearnedTheHardWay") } },
  { type: "fact", get meaning() { return t("memory:plainGroundTruthAboutYourSetup") } },
]

export const TRACE_DOT_LEGEND: { verdict: TraceVerdict; label: string; meaning: string }[] = [
  { verdict: "operational", get label() { return t("memory:shapedTheReply") }, get meaning() { return t("memory:theAgentFollowedItInItsLastReply") } },
  { verdict: "violated", get label() { return t("memory:violated") }, get meaning() { return t("memory:theAgentActedAgainstItLastTime") } },
  { verdict: "injected_without_effect", get label() { return t("memory:noVisibleEffect") }, get meaning() { return t("memory:includedButNoDetectableInfluenceOnTheReply") } },
  { verdict: "not_applicable", get label() { return t("memory:notApplicable") }, get meaning() { return t("memory:nothingInThatTurnItCouldApplyTo") } },
]

export const FRESHNESS_LEGEND: { freshness: Freshness; label: string; meaning: string }[] = [
  { freshness: "new", get label() { return t("memory:new") }, get meaning() { return t("memory:addedSinceYourLastVisitHere") } },
  { freshness: "changed", get label() { return t("memory:changed") }, get meaning() { return t("memory:editedSinceYourLastVisitHere") } },
]
