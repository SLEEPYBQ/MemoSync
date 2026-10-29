import { en } from "../../i18n/resources"
import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
// Step 1 (redesign 2026-08-07 §3): Review New Memory Candidates. ONE
// container wrapping this conversation's pending change cards
// (new candidates + revision proposals — last turn's captures plus the fresh
// prompt parse), parked BEFORE the injection preview. The turn does not move
// until the user settles the gate: work every card, or skip the rest with an
// explicit click — the system never skips for them.
import { useEffect, useMemo, useState } from "react"
import { ArrowRight, Inbox, Info, Loader2 } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { MemoryControlSurface, MemoryItem } from "../../lib/memoriesApi"
import { useMemoryStore } from "../../stores/memoryStore"
import { Button } from "../ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { RiseIn } from "../ui/motion-primitives"
import { MemoryCandidateCard } from "./MemoryCandidatesMessage"
import { MemoryReviewSkeleton } from "./MemoryReviewSkeleton"
import { MemoryReviewStepSummary } from "./MemoryReviewStepSummary"
import { useEnsureMemoriesLoaded } from "./shared"
import { useTranscriptRenderOptions } from "./render-context"

type MemoryProposalsHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_proposals" }>

interface Props {
  message: MemoryProposalsHydratedMessage
  /** Read-only host or an orphaned gate — freeze the buttons. */
  stale?: boolean
  onRespond: (proposalsId: string, decision: "reviewed" | "skipped") => Promise<void> | void
  canReopen?: boolean
  onReopen?: () => Promise<void> | void
  onChanged?: () => Promise<void> | void
  surface?: MemoryControlSurface
}

const DECISION_LABELS: Record<NonNullable<MemoryProposalsHydratedMessage["decision"]>, string> = {
  get reviewed() { return t("memory:reviewed") },
  get skipped() { return t("memory:skippedForNow") },
  get cancelled() { return t("memory:cancelledWithTheTurn") },
  get expired() { return t("memory:expiredServerRestarted") },
  get empty() { return t("memory:nothingNew") },
}

export const MEMORY_PROPOSALS_HELP_COPY =
  en.memory.theseAreChangesThisConversationProposedToYourSavedMemory

export const PERMANENT_CANDIDATE_DISMISSAL_COPY =
  en.memory.dismissedCandidatePermanentlyRemovedItsSensitiveDraftIsNotRetained

export type CandidateReviewState = "candidate" | "accepted" | "discarded" | "optimistic-dismissed" | "missing"

/** Canonical store state always outranks a transient dismissal receipt held by
 * another mounted surface. */
export function candidateReviewState(
  item: MemoryItem | undefined,
  optimisticallyDismissed: boolean,
): CandidateReviewState {
  if (item?.status === "candidate") return "candidate"
  if (item?.status === "active" || item?.status === "archived") return "accepted"
  if (item?.status === "discarded") return "discarded"
  return optimisticallyDismissed ? "optimistic-dismissed" : "missing"
}

/** One production Candidate station shared by transcript gates and the Board's
 * generic pending-candidate entrance. Canonical MemoryItem.status decides each
 * row; callers never maintain a parallel accepted/dismissed state. */
export function MemoryCandidateReviewStation({
  candidates,
  freshAt,
  surface,
  allowRestore = false,
  onCandidateDismissed,
  onChanged,
}: {
  candidates: MemoryItem[]
  freshAt?: string | number
  surface: MemoryControlSurface
  allowRestore?: boolean
  onCandidateDismissed?: (memoryId: string) => void
  onChanged?: () => Promise<void> | void
}) {
  useI18n()
  return (
    <div className="flex flex-col gap-1.5">
      {candidates.map((candidate, index) => (
        <RiseIn key={candidate.id} freshAt={freshAt} delay={index * 0.12}>
          <MemoryCandidateCard
            candidate={candidate}
            freshAt={freshAt}
            surface={surface}
            allowRestore={allowRestore}
            onDismissed={() => onCandidateDismissed?.(candidate.id)}
            onChanged={onChanged}
          />
        </RiseIn>
      ))}
    </div>
  )
}

export function MemoryProposalsGate({
  message,
  stale,
  onRespond,
  canReopen = false,
  onReopen,
  onChanged,
  surface = "chat_gate",
}: Props) {
  useI18n()
  const renderOptions = useTranscriptRenderOptions()
  useEnsureMemoriesLoaded()
  const items = useMemoryStore((s) => s.items)
  const status = useMemoryStore((s) => s.status)
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [refreshAttempted, setRefreshAttempted] = useState(false)
  const [localDismissedIds, setLocalDismissedIds] = useState<Set<string>>(() => new Set())
  const [submitting, setSubmitting] = useState(false)
  const [reopening, setReopening] = useState(false)

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const hasMissing = message.candidates.some((c) => !itemsById.has(c.id))
  useEffect(() => {
    if (status !== "ready" || !hasMissing || refreshAttempted) return
    setRefreshAttempted(true)
    void loadAll()
  }, [hasMissing, loadAll, refreshAttempted, status])

  const total = message.candidates.length
  // Still-pending = live status 'candidate' (accepted/dismissed/archived all
  // count as handled; a locally dismissed id is handled even before refetch).
  const pendingCount = message.candidates.filter((c) => {
    const live = itemsById.get(c.id)
    return candidateReviewState(live, localDismissedIds.has(c.id)) === "candidate"
  }).length
  const handled = total - pendingCount

  if (message.pending && message.candidates.length === 0 && !message.decision) {
    return (
      <div className={MEMORY_CARD}>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Inbox className="h-4 w-4" /> {t("memory:step1ReviewingNewMemoryCandidates")}</span>
        <div className="mt-3">
          <MemoryReviewSkeleton
            label={t("memory:reviewingMemoryCandidates")}
            status={t("memory:checkingCandidates")}
          />
        </div>
      </div>
    )
  }

  if (renderOptions.readonly) {
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        {t("memory:step1ReviewNewMemoryCandidates2")}{t("memory:candidateCount", { count: total })} {t("memory:omittedFromThisExportForPrivacy")}</div>
    )
  }

  // The step ran and found nothing: still SAY so — silence read as "did
  // Step 1 even run?" (user feedback 2026-08-07).
  if (message.decision === "empty" || total === 0) {
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{t("memory:step1ReviewNewMemoryCandidates")}</span>
        <span className="ml-1">{t("memory:noNewMemoryCandidatesWereProposed")}</span>
      </div>
    )
  }

  // Settled gate: one quiet summary line — history, not a control surface.
  if (message.decision) {
    const mayReopen = canReopen && onReopen && (message.decision === "reviewed" || message.decision === "skipped")
    return (
      <MemoryReviewStepSummary
        title={t("memory:step1ReviewNewMemoryCandidates")}
        outcome={<>✓ {t("memory:candidateReceipt", { count: total, decision: DECISION_LABELS[message.decision] })}</>}
        consequence={t("memory:changesRegenerate")}
        reopening={reopening}
        onReopen={mayReopen ? async () => {
          setReopening(true)
          try {
            await onReopen()
          } finally {
            setReopening(false)
          }
        } : undefined}
      />
    )
  }

  async function settle(decision: "reviewed" | "skipped") {
    setSubmitting(true)
    try {
      await onRespond(message.proposalsId, decision)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={MEMORY_CARD} data-memory-control-surface={surface}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><Inbox className="h-4 w-4" /> {t("memory:step1")}</span>
        <span className="text-sm font-semibold text-foreground">{t("memory:reviewNewMemoryCandidates")}</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label={t("memory:aboutMemoryCandidates")}
              className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="text-xs leading-5 text-muted-foreground">
            {t("memory:theseAreChangesThisConversationProposedToYourSavedMemory")}
          </HoverCardContent>
        </HoverCard>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("memory:handledProgress", { handled, total })}</span>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {message.candidates.map((candidate) => {
          const live = itemsById.get(candidate.id)
          const reviewState = candidateReviewState(live, localDismissedIds.has(candidate.id))
          if (live) {
            return (
              <MemoryCandidateReviewStation
                key={candidate.id}
                candidates={[live]}
                freshAt={message.timestamp}
                surface={surface}
                allowRestore
                onCandidateDismissed={(memoryId) => setLocalDismissedIds((current) => new Set(current).add(memoryId))}
                onChanged={onChanged}
              />
            )
          }
          if (reviewState === "optimistic-dismissed") {
            return (
              <div key={candidate.id} className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
                {t("memory:dismissedCandidatePermanentlyRemovedItsSensitiveDraftIsNotRetained")}
              </div>
            )
          }
          if (status === "error") {
            return (
              <div key={candidate.id} className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
                {t("memory:proposedChangeUnavailableRefreshToTryAgain")}</div>
            )
          }
          if (status !== "ready" || !refreshAttempted) {
            return (
              <div key={candidate.id} className="flex items-center gap-2 memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("memory:loadingProposedChange")}</div>
            )
          }
          return (
            <div key={candidate.id} className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
              {t("memory:dismissedCandidatePermanentlyRemovedItsSensitiveDraftIsNotRetained")}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {stale ? (
          <p className="text-xs text-muted-foreground">{t("memory:thisGateBelongsToAnEarlierTurnAndIsNo")}</p>
        ) : (
          <Button variant="default" size="xs" disabled={submitting} onClick={() => void settle(pendingCount === 0 ? "reviewed" : "skipped")}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            {pendingCount === 0 ? t("common:continue") : t("memory:skipValue0RemainingContinue", { v0: pendingCount })}
          </Button>
        )}
      </div>
    </div>
  )
}
