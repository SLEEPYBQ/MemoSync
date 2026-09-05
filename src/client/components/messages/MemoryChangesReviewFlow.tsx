import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Info, LibraryBig } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { MemoryItem } from "../../lib/memoriesApi"
import {
  createFocusedMemoryReviewController,
  useFocusedMemoryReview,
  useMemoryBoardLauncher,
  type FocusedMemoryReviewController,
  type FocusedMemoryReviewSnapshot,
} from "../../app/study/MemoryBoardLauncher"
import { Button } from "../ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { TranscriptChatContextProvider, useTranscriptChatContext } from "./render-context"
import { MemoryCheckupGate } from "./MemoryCheckupGate"
import { MemoryCandidateReviewStation, MemoryProposalsGate } from "./MemoryProposalsGate"
import { MemoryTransferGate } from "./MemoryTransferGate"

export type MemoryChangesReviewMessage = Extract<
  HydratedTranscriptMessage,
  { kind: "memory_proposals" | "memory_transfer" | "memory_checkup" }
>

interface Props {
  messages: MemoryChangesReviewMessage[]
  stale?: boolean
  onMemoryProposalsRespond?: (proposalsId: string, decision: "reviewed" | "skipped") => Promise<void> | void
  onMemoryCheckupRespond?: (checkupId: string, decision: "handled" | "skipped") => Promise<void> | void
  onMemoryTransferRespond?: (transferId: string, decision: "handled" | "skipped") => Promise<void> | void
  canReopenProposals?: boolean
  canReopenTransfer?: boolean
  canReopenCheckup?: boolean
  onMemoryPreparationReopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => Promise<void> | void
}

const noop = () => {}

export function resetFocusedReviewProgress(
  progress: FocusedMemoryReviewSnapshot["progress"],
  from: "proposals" | "checkup" | "transfer",
): FocusedMemoryReviewSnapshot["progress"] {
  if (from === "checkup") {
    return { ...progress, resolvedCheckupRows: new Map() }
  }
  return {
    settledTransferRows: new Map(),
    resolvedCheckupRows: new Map(),
  }
}

function MemoryChangesReviewSurface({
  review,
  placement,
  onOpenBoard,
}: {
  review: FocusedMemoryReviewSnapshot
  placement: "chat" | "board"
  onOpenBoard?: () => void
}) {
  return (
    <section
      className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm"
      data-focused-memory-review={placement}
    >
      <header className="border-b border-border/70 bg-muted/20 px-4 py-3">
        {placement === "board" ? (
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300">
            Memory Board review
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Long-term Memory Management</h2>
            <HoverCard>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  aria-label="About this review"
                  className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </HoverCardTrigger>
              <HoverCardContent className="text-xs leading-5 text-muted-foreground">
                Everything that would change your memory this turn stops here first: new candidates, memories worth
                bringing in from elsewhere, and suggested fixes to what is already saved. The agent starts only
                after you decide.
              </HoverCardContent>
            </HoverCard>
          </div>
          {placement === "chat" && onOpenBoard ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
              onClick={onOpenBoard}
              data-go-to-memory-board="true"
              data-memory-board-source="chat_long_term"
            >
              <LibraryBig className="size-3.5" />
              Go to Memory Board
            </Button>
          ) : null}
        </div>
        <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">
          {placement === "board"
            ? "This is the same live review shown in chat. Row progress and saved changes stay synchronized. Working Memory remains separate and follows after these stations."
            : "Open the Memory Board to review these same rows and the canonical saved memories together. Working Memory remains the separate next step."}
        </p>
      </header>

      <div className="flex flex-col gap-3 bg-muted/10 p-3">
        {/* data-entry-id: jump anchors for the sidebar Memory Record — the
            three stations share one transcript row, so the row id alone
            cannot address them. */}
        <MemoryReviewStation review={review} placement={placement} station="proposals" />
        <MemoryReviewStation review={review} placement={placement} station="transfer" />
        <MemoryReviewStation review={review} placement={placement} station="checkup" />
      </div>
    </section>
  )
}

export type FocusedMemoryReviewStationName = "proposals" | "transfer" | "checkup"

function MemoryReviewStation({
  review,
  placement,
  station,
  onCandidateChanged,
}: {
  review: FocusedMemoryReviewSnapshot
  placement: "chat" | "board"
  station: FocusedMemoryReviewStationName
  onCandidateChanged?: () => Promise<void> | void
}) {
  const surface = placement === "board" ? "board" : "chat_gate"
  const message = review.messages.find((candidate) => candidate.kind === stationNameToKind(station))
  if (!message) return null

  if (message.kind === "memory_proposals") {
    return (
      <div data-entry-id={message.id}>
        <MemoryProposalsGate
          message={message}
          stale={review.stale || !review.onMemoryProposalsRespond}
          onRespond={async (proposalsId, decision) => {
            await review.onMemoryProposalsRespond?.(proposalsId, decision)
            await onCandidateChanged?.()
          }}
          canReopen={review.canReopenProposals}
          onReopen={async () => {
            await review.onMemoryPreparationReopen?.("proposals", message.proposalsId)
            await onCandidateChanged?.()
          }}
          onChanged={onCandidateChanged}
          surface={surface}
        />
      </div>
    )
  }
  if (message.kind === "memory_transfer") {
    return (
      <div data-entry-id={message.id}>
        <MemoryTransferGate
          message={message}
          stale={review.stale || !review.onMemoryTransferRespond}
          onRespond={review.onMemoryTransferRespond ?? noop}
          canReopen={review.canReopenTransfer}
          onReopen={() => review.onMemoryPreparationReopen?.("transfer", message.transferId)}
          stepNumber={2}
          settledRows={review.progress.settledTransferRows}
          onSuggestionSettled={review.onTransferSettled}
          surface={surface}
        />
      </div>
    )
  }
  return (
    <div data-entry-id={message.id}>
      <MemoryCheckupGate
        message={message}
        stale={review.stale || !review.onMemoryCheckupRespond}
        onRespond={review.onMemoryCheckupRespond ?? noop}
        canReopen={review.canReopenCheckup}
        onReopen={() => review.onMemoryPreparationReopen?.("checkup", message.checkupId)}
        stepNumber={3}
        resolvedRows={review.progress.resolvedCheckupRows}
        onSuggestionResolved={review.onCheckupResolved}
        surface={surface}
      />
    </div>
  )
}

function stationNameToKind(station: FocusedMemoryReviewStationName): MemoryChangesReviewMessage["kind"] {
  if (station === "proposals") return "memory_proposals"
  if (station === "transfer") return "memory_transfer"
  return "memory_checkup"
}

export function FocusedMemoryReviewStation({
  controller,
  station,
  onCandidateChanged,
}: {
  controller: FocusedMemoryReviewController
  station: FocusedMemoryReviewStationName
  onCandidateChanged?: () => Promise<void> | void
}) {
  const review = useFocusedMemoryReview(controller)
  return (
    <TranscriptChatContextProvider value={review.chatContext}>
      <MemoryReviewStation
        review={review}
        placement="board"
        station={station}
        onCandidateChanged={onCandidateChanged}
      />
    </TranscriptChatContextProvider>
  )
}

/** Candidate ids first observed while this Board instance is mounted. The
 * cohort makes a just-accepted or soft-dismissed row stay in Step 1 long
 * enough to expose its real inverse, without mistaking unrelated born-active
 * memories for Candidate decisions. */
export function extendCandidateReviewCohort(
  current: ReadonlySet<string>,
  items: MemoryItem[],
): ReadonlySet<string> {
  const next = new Set(current)
  for (const item of items) {
    if (item.status === "candidate") next.add(item.id)
  }
  if (next.size === current.size && [...next].every((id) => current.has(id))) return current
  return next
}

export function candidateReviewCohortItems(
  items: MemoryItem[],
  cohortIds: ReadonlySet<string>,
): MemoryItem[] {
  return items.filter((item) => item.status === "candidate" || cohortIds.has(item.id))
}

function focusedProposalIds(review: FocusedMemoryReviewSnapshot): Set<string> {
  const message = review.messages.find(
    (candidate): candidate is Extract<MemoryChangesReviewMessage, { kind: "memory_proposals" }> =>
      candidate.kind === "memory_proposals",
  )
  return new Set(message?.candidates.map((candidate) => candidate.id) ?? [])
}

export function remainingCandidateReviewItems(
  review: FocusedMemoryReviewSnapshot,
  items: MemoryItem[],
  cohortIds: ReadonlySet<string>,
): MemoryItem[] {
  const currentIds = focusedProposalIds(review)
  return candidateReviewCohortItems(items, cohortIds).filter((item) => !currentIds.has(item.id))
}

/** The focused chat keeps its real MemoryProposalsGate (including settled
 * summary and Review again). Other canonical Candidate rows join the same
 * Step 1 below it, de-duplicated by id. */
export function FocusedMemoryCandidateStep({
  controller,
  items,
  cohortIds,
  onChanged,
}: {
  controller: FocusedMemoryReviewController
  items: MemoryItem[]
  cohortIds: ReadonlySet<string>
  onChanged?: () => Promise<void> | void
}) {
  const review = useFocusedMemoryReview(controller)
  const currentProposal = review.messages.find((message) => message.kind === "memory_proposals")
  const remaining = remainingCandidateReviewItems(review, items, cohortIds)

  return (
    <TranscriptChatContextProvider value={review.chatContext}>
      {currentProposal ? (
        <MemoryReviewStation
          review={review}
          placement="board"
          station="proposals"
          onCandidateChanged={onChanged}
        />
      ) : null}
      {remaining.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm" data-remaining-candidate-review="true">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            {!currentProposal ? <span className="text-[11px] font-semibold text-muted-foreground">Step 1</span> : null}
            <h2 className="text-sm font-medium text-foreground">
              {currentProposal ? "Other Memory Candidates" : "Review New Memory Candidates"}
            </h2>
            <span className="ml-auto text-xs text-muted-foreground">{remaining.length} in this review</span>
          </div>
          <MemoryCandidateReviewStation
            candidates={remaining}
            surface="board"
            allowRestore
            onChanged={onChanged}
          />
        </div>
      ) : null}
      {!currentProposal && remaining.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Step 1 · Review New Memory Candidates</span>
          <span className="ml-1">✓ No pending memory candidates.</span>
        </div>
      ) : null}
    </TranscriptChatContextProvider>
  )
}

export function FocusedMemoryChangesReview({ controller }: { controller: FocusedMemoryReviewController }) {
  const review = useFocusedMemoryReview(controller)
  return (
    <TranscriptChatContextProvider value={review.chatContext}>
      <MemoryChangesReviewSurface review={review} placement="board" />
    </TranscriptChatContextProvider>
  )
}

/**
 * The first pre-turn component. It owns only changes to memory: candidate
 * proposals (Step 1), the Transfer card (memories from outside this
 * conversation's context, when current-task relevance finds any), and suggestions about
 * saved memories (Step 2). The injected-set preview is a different shared
 * object in the paper and remains a separate transcript component after this
 * one is settled.
 */
export function MemoryChangesReviewFlow({
  messages,
  stale = false,
  onMemoryProposalsRespond,
  onMemoryCheckupRespond,
  onMemoryTransferRespond,
  canReopenProposals = false,
  canReopenTransfer = false,
  canReopenCheckup = false,
  onMemoryPreparationReopen,
}: Props) {
  const boardLauncher = useMemoryBoardLauncher()
  const chatContext = useTranscriptChatContext()
  const [settledTransferRows, setSettledTransferRows] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [resolvedCheckupRows, setResolvedCheckupRows] = useState<ReadonlyMap<string, string>>(() => new Map())
  const transfer = messages.find(
    (message): message is Extract<MemoryChangesReviewMessage, { kind: "memory_transfer" }> =>
      message.kind === "memory_transfer",
  )
  const checkup = messages.find(
    (message): message is Extract<MemoryChangesReviewMessage, { kind: "memory_checkup" }> =>
      message.kind === "memory_checkup",
  )
  const onTransferSettled = useCallback((sourceId: string, outcome: string) => {
    setSettledTransferRows((current) => new Map(current).set(sourceId, outcome))
  }, [])
  const onCheckupResolved = useCallback((memoryId: string, outcome: string) => {
    setResolvedCheckupRows((current) => new Map(current).set(memoryId, outcome))
  }, [])
  const reopenMemoryPreparation = useCallback(async (
    from: "proposals" | "checkup" | "transfer",
    stageId: string,
  ) => {
    const reset = resetFocusedReviewProgress({ settledTransferRows, resolvedCheckupRows }, from)
    setSettledTransferRows(reset.settledTransferRows)
    setResolvedCheckupRows(reset.resolvedCheckupRows)
    await onMemoryPreparationReopen?.(from, stageId)
  }, [onMemoryPreparationReopen, resolvedCheckupRows, settledTransferRows])

  // Regenerated downstream stations must not inherit the previous result's
  // row receipts. The transcript's pending/waiting markers are the canonical
  // reset boundary used by the in-chat gates too.
  useEffect(() => {
    setSettledTransferRows(new Map())
  }, [transfer?.transferId])
  useEffect(() => {
    if (transfer?.pending) setSettledTransferRows(new Map())
  }, [transfer?.pending])
  useEffect(() => {
    setResolvedCheckupRows(new Map())
  }, [checkup?.checkupId])
  useEffect(() => {
    if (checkup?.pending || checkup?.waiting) setResolvedCheckupRows(new Map())
  }, [checkup?.pending, checkup?.waiting])

  const review = useMemo<FocusedMemoryReviewSnapshot>(() => ({
    reviewId: messages[0]?.id ?? "memory-review",
    chatContext,
    messages,
    stale,
    onMemoryProposalsRespond,
    onMemoryCheckupRespond,
    onMemoryTransferRespond,
    canReopenProposals,
    canReopenTransfer,
    canReopenCheckup,
    onMemoryPreparationReopen: reopenMemoryPreparation,
    progress: {
      settledTransferRows,
      resolvedCheckupRows,
    },
    onTransferSettled,
    onCheckupResolved,
  }), [
    canReopenCheckup,
    canReopenProposals,
    canReopenTransfer,
    chatContext,
    messages,
    onCheckupResolved,
    onMemoryCheckupRespond,
    reopenMemoryPreparation,
    onMemoryProposalsRespond,
    onMemoryTransferRespond,
    onTransferSettled,
    resolvedCheckupRows,
    settledTransferRows,
    stale,
  ])
  const controllerRef = useRef<FocusedMemoryReviewController | null>(null)
  if (!controllerRef.current) controllerRef.current = createFocusedMemoryReviewController(review)
  useEffect(() => controllerRef.current?.update(review), [review])

  const openingReviewId = messages.find((message) => message.openingReviewId)?.openingReviewId
  const reviewChatId = chatContext.chatId
  useEffect(() => {
    if (!openingReviewId || !reviewChatId) return
    return boardLauncher.focusedReviews.register(
      reviewChatId,
      openingReviewId,
      controllerRef.current!,
    )
  }, [boardLauncher.focusedReviews, openingReviewId, reviewChatId])

  const activeReview = !stale && (
    messages.some((message) => message.decision === undefined)
    || canReopenProposals
    || canReopenTransfer
    || canReopenCheckup
  )
  const openBoard = boardLauncher.available
    ? () => boardLauncher.openMemoryBoard({
        source: "chat_long_term",
        chatId: chatContext.chatId,
        focusedReview: activeReview ? controllerRef.current! : undefined,
      })
    : undefined

  if (openingReviewId && !activeReview) {
    return (
      <section
        className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
        data-opening-board-review-receipt="true"
      >
        <span className="font-medium text-foreground">Long-term Memory reviewed in the Memory Board.</span>{" "}
        Working Memory was selected separately for this message.
      </section>
    )
  }

  return (
    <MemoryChangesReviewSurface
      review={review}
      placement="chat"
      onOpenBoard={openBoard}
    />
  )
}
