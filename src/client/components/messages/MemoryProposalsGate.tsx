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
  reviewed: "reviewed",
  skipped: "skipped for now",
  cancelled: "cancelled with the turn",
  expired: "expired (server restarted)",
  empty: "nothing new",
}

export const MEMORY_PROPOSALS_HELP_COPY =
  "These are changes this conversation proposed to your saved memory. Accept saves a change to the Visible Memory Pool. Before Claude starts, the Working Memory review decides whether that saved memory is focused for this turn."

export const PERMANENT_CANDIDATE_DISMISSAL_COPY =
  "Dismissed candidate permanently removed. Its sensitive draft is not retained and cannot be restored."

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
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Inbox className="h-3 w-3" /> Step 1 · Reviewing New Memory Candidates</span>
        <div className="mt-3">
          <MemoryReviewSkeleton
            label="Reviewing memory candidates"
            status="checking this prompt for memory candidates…"
          />
        </div>
      </div>
    )
  }

  if (renderOptions.readonly) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Step 1 · Review New Memory Candidates — {total} {total === 1 ? "candidate" : "candidates"} omitted from this
        export for privacy.
      </div>
    )
  }

  // The step ran and found nothing: still SAY so — silence read as "did
  // Step 1 even run?" (user feedback 2026-08-07).
  if (message.decision === "empty" || total === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Step 1 · Review New Memory Candidates</span>
        <span className="ml-1">✓ No new memory candidates were proposed.</span>
      </div>
    )
  }

  // Settled gate: one quiet summary line — history, not a control surface.
  if (message.decision) {
    const mayReopen = canReopen && onReopen && (message.decision === "reviewed" || message.decision === "skipped")
    return (
      <MemoryReviewStepSummary
        title="Step 1 · Review New Memory Candidates"
        outcome={<>✓ {total} {total === 1 ? "candidate" : "candidates"}, {DECISION_LABELS[message.decision]}.</>}
        consequence="Changes will regenerate Step 2 and Working Memory for this turn."
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
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm" data-memory-control-surface={surface}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><Inbox className="h-3 w-3" /> Step 1</span>
        <span className="text-sm font-medium text-foreground">Review New Memory Candidates</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label="About memory candidates"
              className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="text-xs leading-5 text-muted-foreground">
            {MEMORY_PROPOSALS_HELP_COPY}
          </HoverCardContent>
        </HoverCard>
        <span className="ml-auto text-xs text-muted-foreground">
          {handled} of {total} handled
        </span>
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
              <div key={candidate.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {PERMANENT_CANDIDATE_DISMISSAL_COPY}
              </div>
            )
          }
          if (status === "error") {
            return (
              <div key={candidate.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Proposed change unavailable. Refresh to try again.
              </div>
            )
          }
          if (status !== "ready" || !refreshAttempted) {
            return (
              <div key={candidate.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading proposed change…
              </div>
            )
          }
          return (
            <div key={candidate.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {PERMANENT_CANDIDATE_DISMISSAL_COPY}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {stale ? (
          <p className="text-xs text-muted-foreground">This gate belongs to an earlier turn and is no longer active.</p>
        ) : (
          <Button variant="juicy" size="xs" disabled={submitting} onClick={() => void settle(pendingCount === 0 ? "reviewed" : "skipped")}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            {pendingCount === 0 ? "Continue" : `Skip ${pendingCount} remaining & continue`}
          </Button>
        )}
      </div>
    </div>
  )
}
