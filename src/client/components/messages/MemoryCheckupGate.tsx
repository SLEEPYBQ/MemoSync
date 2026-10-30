import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
// Step 2 (redesign 2026-08-07 §3): suggested changes to saved memories. Three
// parallel library checks (conflicts / redundancy / staleness) surface here,
// grouped by type with empty groups hidden. Promotion rows are legacy-only;
// old transcripts keep a passive receipt but no longer expose a scope-changing
// action. While the queries
// run the container renders as a skeleton with cycling status words; each
// suggestion row is a memory reference + the model's one-line reason + the
// type's fixed actions. Actions ride the existing attention-resolve API.
import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, ArrowRight, CheckCheck, Clock3, Copy, Info, ListChecks, Loader2 } from "lucide-react"
import type { HydratedTranscriptMessage, MemoryCheckupKind, MemoryCheckupSuggestionSnapshot } from "../../../shared/types"
import {
  memoriesApi,
  type MemoryControlSurface,
} from "../../lib/memoriesApi"
import { useMemoryStore } from "../../stores/memoryStore"
import { Button } from "../ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { RiseIn } from "../ui/motion-primitives"
import { MemoryCitationChip, useEnsureMemoriesLoaded } from "./shared"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"
import { MemoryReviewSkeleton } from "./MemoryReviewSkeleton"
import { MemoryReviewStepSummary } from "./MemoryReviewStepSummary"

type MemoryCheckupHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_checkup" }>

interface Props {
  message: MemoryCheckupHydratedMessage
  stale?: boolean
  onRespond: (checkupId: string, decision: "handled" | "skipped") => Promise<void> | void
  canReopen?: boolean
  onReopen?: () => Promise<void> | void
  /** Position in this turn's flow — 3 when a Transfer card sits before us, 2 otherwise. */
  stepNumber?: number
  surface?: MemoryControlSurface
  /** Session-start Board: every resurfaced row must be handled before leaving. */
  requireAllRows?: boolean
  /** Shared when the same active gate is expanded in the Memory Board. */
  resolvedRows?: ReadonlyMap<string, string>
  onSuggestionResolved?: (memoryId: string, outcome: string) => void
}

const STATUS_WORDS = () => [t("memory:checkingConflicts"), t("memory:checkingRedundancy"), t("memory:checkingStaleness")]

const GROUPS: Array<{ kind: MemoryCheckupSuggestionSnapshot["kind"]; title: string; icon: typeof AlertTriangle }> = [
  { kind: "conflict", get title() { return t("memory:conflicts") }, icon: AlertTriangle },
  { kind: "redundancy", get title() { return t("memory:redundancy") }, icon: Copy },
  { kind: "staleness", get title() { return t("memory:staleness") }, icon: Clock3 },
  { kind: "promotion", get title() { return t("memory:retiredSuggestions") }, icon: CheckCheck },
]

const DECISION_LABELS: Record<NonNullable<MemoryCheckupHydratedMessage["decision"]>, string> = {
  get handled() { return t("memory:handled") },
  get skipped() { return t("memory:skippedForNow") },
  get cancelled() { return t("memory:cancelledWithTheTurn") },
  get expired() { return t("memory:expiredServerRestarted") },
  get empty() { return t("memory:nothingNeededAttention") },
  get failed() { return t("memory:checkupIncomplete4") },
}

const FAILED_KIND_LABELS: Record<MemoryCheckupKind, string> = {
  get conflict() { return t("memory:conflicts") },
  get redundancy() { return t("memory:redundancy") },
  get staleness() { return t("memory:staleness") },
}

function failedKindsLabel(kinds: MemoryCheckupKind[]): string {
  return kinds.map((kind) => FAILED_KIND_LABELS[kind]).join(", ")
}

export function MemoryCheckupGate({
  message,
  stale,
  onRespond,
  canReopen = false,
  onReopen,
  stepNumber = 2,
  surface = "chat_gate",
  requireAllRows = false,
  resolvedRows,
  onSuggestionResolved,
}: Props) {
  useI18n()
  const renderOptions = useTranscriptRenderOptions()
  useEnsureMemoriesLoaded()
  const suggestions = useMemo(() => message.suggestions ?? [], [message.suggestions])
  const failedKinds = useMemo(() => message.failedKinds ?? [], [message.failedKinds])
  const [localResolvedRows, setLocalResolvedRows] = useState<Map<string, string>>(() => new Map())
  const [submitting, setSubmitting] = useState(false)
  const [reopening, setReopening] = useState(false)
  const effectiveResolvedRows = resolvedRows ?? localResolvedRows

  // Reopening Step 1 or Step 2 invalidates the previous checkup result. Clear
  // local row state as soon as the reset marker folds into this component so
  // newly generated suggestions can never inherit an old "handled" status.
  useEffect(() => {
    if (message.pending || message.waiting) setLocalResolvedRows(new Map())
  }, [message.pending, message.waiting])

  if (renderOptions.readonly) {
    if (!suggestions.length && !failedKinds.length) return null
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        {t("memory:stepNumber", { step: stepNumber })} {t("memory:reviewSuggestedChangesToExistingMemories")}{suggestions.length} {t("memory:omittedFromThisExport")}{failedKinds.length ? t("memory:incompleteChecks", { v0: failedKindsLabel(failedKinds) }) : ""}
      </div>
    )
  }

  // Skeleton: queries in flight. The wireframe rows pulse; the words cycle.
  if (message.pending && message.suggestions === undefined) {
    return <CheckupSkeleton stepNumber={stepNumber} />
  }

  if (message.waiting) {
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        <span className="text-sm font-semibold text-foreground">{t("memory:stepNumber", { step: stepNumber })} {t("memory:reviewSuggestedChangesToExistingMemories2")}</span>
        <span className="ml-1">{t("memory:waitingForTheEarlierStepsThisReviewWillRegenerateWhen")}</span>
      </div>
    )
  }

  if (message.suggestions !== undefined && suggestions.length === 0 && failedKinds.length > 0) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info/8 px-3 py-2 text-sm text-info-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <span className="font-medium">{t("memory:stepNumber", { step: stepNumber })} {t("memory:checkupIncomplete2")}</span>
          <span className="ml-1">{failedKindsLabel(failedKinds)} {t("memory:couldNotFinishNoClearVerdictWasRecordedTheseChecks")}</span>
        </div>
      </div>
    )
  }

  if (message.suggestions !== undefined && suggestions.length === 0 && (!message.decision || message.decision === "empty")) {
    return (
      <div className="flex flex-wrap items-center gap-2 memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        <CheckCheck className="h-4 w-4 shrink-0 text-success-foreground dark:text-success-foreground" />
        <span className="text-sm font-semibold text-foreground">{t("memory:stepNumber", { step: stepNumber })} {t("memory:reviewSuggestedChangesToExistingMemories2")}</span>
        <span className="basis-full @lg:basis-auto">{t("memory:nothingNeedsAttention2")}</span>
      </div>
    )
  }

  if (message.decision) {
    const mayReopen = canReopen && onReopen && (message.decision === "handled" || message.decision === "skipped")
    return (
      <MemoryReviewStepSummary
        title={t("memory:stepValue0ReviewSuggestedChangesToExistingMemories", { v0: stepNumber })}
        outcome={
          <>
            ✓ {t("memory:suggestionReceipt", { count: suggestions.length, decision: DECISION_LABELS[message.decision] })}
            {failedKinds.length ? <> {t("memory:checkupIncomplete3")}{failedKindsLabel(failedKinds)} {t("memory:uncheckedTheseChecksWillRetryNextTurn")}</> : null}
          </>
        }
        consequence={t("memory:reviewAgainCheckup")}
        reopening={reopening}
        onReopen={mayReopen ? async () => {
          setReopening(true)
          try {
            setLocalResolvedRows(new Map())
            await onReopen()
          } finally {
            setReopening(false)
          }
        } : undefined}
      />
    )
  }

  const pendingCount = suggestions.filter((s) => s.kind !== "promotion" && !effectiveResolvedRows.has(s.memoryId)).length

  async function settle(decision: "handled" | "skipped") {
    setSubmitting(true)
    try {
      await onRespond(message.checkupId, decision)
    } finally {
      setSubmitting(false)
    }
  }

  let riseIndex = -1
  return (
    <div className={MEMORY_CARD} data-memory-control-surface={surface}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><ListChecks className="h-4 w-4" /> {t("memory:stepNumber", { step: stepNumber })}</span>
        <span className="text-sm font-semibold text-foreground">{t("memory:reviewSuggestedChangesToExistingMemories3")}</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label={t("memory:aboutTheLibraryCheckup")}
              className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="text-xs leading-5 text-muted-foreground">
            {t("memory:possibleFixesToMemoriesAlreadyInYourLibraryConflictsNear")}</HoverCardContent>
        </HoverCard>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("memory:handledProgress", { handled: suggestions.length - pendingCount, total: suggestions.length })}</span>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {failedKinds.length ? (
          <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info/8 px-3 py-2 text-sm text-info-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("memory:someChecksDidNotFinish")}{failedKindsLabel(failedKinds)}{t("memory:theCompletedSuggestionsBelowRemainReviewableFailedChecksWillRetry")}</span>
          </div>
        ) : null}
        {GROUPS.map(({ kind, title, icon: Icon }) => {
          const group = suggestions.filter((s) => s.kind === kind)
          if (group.length === 0) return null
          return (
            <div key={kind}>
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Icon className="h-3 w-3" /> {title} · {group.length}
              </p>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {group.map((suggestion) => {
                  riseIndex += 1
                  return (
                    <RiseIn key={`${suggestion.kind}-${suggestion.memoryId}`} freshAt={message.timestamp} delay={riseIndex * 0.1}>
                      <CheckupSuggestionRow
                        suggestion={suggestion}
                        surface={surface}
                        resolvedOutcome={effectiveResolvedRows.get(suggestion.memoryId)}
                        onResolved={(outcome) => {
                          if (onSuggestionResolved) {
                            onSuggestionResolved(suggestion.memoryId, outcome)
                            return
                          }
                          setLocalResolvedRows((current) => new Map(current).set(suggestion.memoryId, outcome))
                        }}
                      />
                    </RiseIn>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end">
        {stale ? (
          <p className="text-xs text-muted-foreground">{t("memory:thisGateBelongsToAnEarlierTurnAndIsNo")}</p>
        ) : (
          <Button
            variant="default"
            size="xs"
            disabled={submitting || (requireAllRows && pendingCount > 0)}
            onClick={() => void settle(pendingCount === 0 ? "handled" : "skipped")}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            {pendingCount === 0
              ? t("common:continue")
              : requireAllRows
                ? t("memory:reviewValue0Remaining", { v0: pendingCount })
                : t("memory:skipValue0RemainingContinue", { v0: pendingCount })}
          </Button>
        )}
      </div>
    </div>
  )
}

function CheckupSkeleton({ stepNumber = 2 }: { stepNumber?: number }) {
  useI18n()
  const [wordIndex, setWordIndex] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setWordIndex((i) => (i + 1) % STATUS_WORDS().length), 1400)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className={MEMORY_CARD}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium"><ListChecks className="h-4 w-4" /> {t("memory:stepNumber", { step: stepNumber })} {t("memory:reviewingSavedMemories")}</span>
      </div>
      <div className="mt-3">
        <MemoryReviewSkeleton
          label={t("memory:reviewingSuggestedChangesToSavedMemories")}
          status={STATUS_WORDS()[wordIndex]!}
        />
      </div>
    </div>
  )
}

/**
 * One suggestion row: memory reference (hover = the canonical read-only card)
 * + the model's reason + this type's fixed actions. The row is the host — the
 * buttons live here, never on the memory card itself.
 */
function CheckupSuggestionRow({
  suggestion,
  resolvedOutcome,
  onResolved,
  surface,
}: {
  suggestion: MemoryCheckupSuggestionSnapshot
  resolvedOutcome?: string
  onResolved: (outcome: string) => void
  surface: MemoryControlSurface
}) {
  useI18n()
  const { chatId } = useTranscriptChatContext()
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(label: string, run: () => Promise<unknown>, doneText: string) {
    setBusy(label)
    setError(null)
    try {
      await run()
      await loadAll()
      onResolved(doneText)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:actionFailed"))
    } finally {
      setBusy(null)
    }
  }

  const id = suggestion.memoryId
  const other = suggestion.otherMemoryId
  if (suggestion.kind === "promotion") {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <MemoryCitationChip id={id} /> {t("memory:automaticScopeWideningFlowIsRetiredNoFurtherActionIs")}</div>
    )
  }

  if (resolvedOutcome) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <MemoryCitationChip id={id} /> — {translateUiText(resolvedOutcome)}
      </div>
    )
  }

  const actionButton = (label: string, doneText: string, run: () => Promise<unknown>) => (
    <Button key={label} variant="ghost" size="xs" disabled={busy !== null} onClick={() => void act(label, run, doneText)}>
      {busy === label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {label}
    </Button>
  )

  let actions: React.ReactNode = null
  switch (suggestion.kind) {
    case "conflict":
      actions = other ? (
        <>
          {actionButton(t("memory:keepValue0", { v0: id }), t("memory:keptValue0ArchivedValue1", { v0: id, v1: other }), () =>
            memoriesApi.resolveAttention("conflict", other, "archive", chatId, id, surface),
          )}
          {actionButton(t("memory:keepValue0", { v0: other }), t("memory:keptValue0ArchivedValue1", { v0: other, v1: id }), () =>
            memoriesApi.resolveAttention("conflict", id, "archive", chatId, other, surface),
          )}
        </>
      ) : null
      break
    case "redundancy":
      actions = other ? (
        <>
          {actionButton(t("memory:merge"), t("memory:mergeProposalDraftedReviewItInStep1NextTurn"), () =>
            memoriesApi.resolveAttention("redundant", id, "merge", chatId, other, surface),
          )}
          {actionButton(t("memory:keepBoth"), t("memory:keptBothWonTBeFlaggedAgain"), () =>
            memoriesApi.resolveAttention("redundant", id, "keep", chatId, other, surface),
          )}
        </>
      ) : null
      break
    case "staleness":
      actions = (
        <>
          {actionButton(t("common:archive"), "archived", () => memoriesApi.resolveAttention("stale", id, "archive", chatId, undefined, surface))}
          {actionButton(t("memory:keep"), t("memory:keptExpiryClockReset"), () => memoriesApi.resolveAttention("stale", id, "keep", chatId, undefined, surface))}
        </>
      )
      break
  }

  return (
    <div className="rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <MemoryCitationChip id={id} />
        {other ? (
          <>
            <span className="text-xs text-muted-foreground">↔</span>
            <MemoryCitationChip id={other} />
          </>
        ) : null}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{suggestion.reason}</p>
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
      {error ? <p className="mt-1 text-xs text-destructive">{translateUiText(error)}</p> : null}
    </div>
  )
}
