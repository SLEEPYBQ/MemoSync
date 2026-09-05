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
  type MemoryBoardActionContext,
  type MemoryBoardCheckupActionContext,
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
  boardResolution?: MemoryBoardActionContext
  /** Session-start Board: every resurfaced row must be handled before leaving. */
  requireAllRows?: boolean
  /** Shared when the same active gate is expanded in the Memory Board. */
  resolvedRows?: ReadonlyMap<string, string>
  onSuggestionResolved?: (memoryId: string, outcome: string) => void
}

const STATUS_WORDS = ["checking conflicts…", "checking redundancy…", "checking staleness…"]

const GROUPS: Array<{ kind: MemoryCheckupSuggestionSnapshot["kind"]; title: string; icon: typeof AlertTriangle }> = [
  { kind: "conflict", title: "Conflicts", icon: AlertTriangle },
  { kind: "redundancy", title: "Redundancy", icon: Copy },
  { kind: "staleness", title: "Staleness", icon: Clock3 },
  { kind: "promotion", title: "Retired suggestions", icon: CheckCheck },
]

export function buildBoardCheckupActionContext(input: {
  boardResolution?: MemoryBoardActionContext
  suggestion: MemoryCheckupSuggestionSnapshot
  memoryId: string
  otherMemoryId?: string
}): MemoryBoardCheckupActionContext | undefined {
  if (!input.boardResolution || input.suggestion.kind === "promotion") return undefined
  return {
    ...input.boardResolution,
    suggestionKind: input.suggestion.kind,
    memoryId: input.memoryId,
    otherMemoryId: input.otherMemoryId,
  }
}

const DECISION_LABELS: Record<NonNullable<MemoryCheckupHydratedMessage["decision"]>, string> = {
  handled: "handled",
  skipped: "skipped for now",
  cancelled: "cancelled with the turn",
  expired: "expired (server restarted)",
  empty: "nothing needed attention",
  failed: "checkup incomplete",
}

const FAILED_KIND_LABELS: Record<MemoryCheckupKind, string> = {
  conflict: "Conflicts",
  redundancy: "Redundancy",
  staleness: "Staleness",
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
  boardResolution,
  requireAllRows = false,
  resolvedRows,
  onSuggestionResolved,
}: Props) {
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
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Step {stepNumber} · Review Suggested Changes to Existing Memories — {suggestions.length} omitted from this export.
        {failedKinds.length ? ` Incomplete checks: ${failedKindsLabel(failedKinds)}.` : ""}
      </div>
    )
  }

  // Skeleton: queries in flight. The wireframe rows pulse; the words cycle.
  if (message.pending && message.suggestions === undefined) {
    return <CheckupSkeleton stepNumber={stepNumber} />
  }

  if (message.waiting) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Step {stepNumber} · Review Suggested Changes to Existing Memories</span>
        <span className="ml-1">Waiting for the earlier steps. This review will regenerate when you continue.</span>
      </div>
    )
  }

  if (message.suggestions !== undefined && suggestions.length === 0 && failedKinds.length > 0) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/20 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <span className="font-medium">Step {stepNumber} · Checkup incomplete</span>
          <span className="ml-1">{failedKindsLabel(failedKinds)} could not finish. No clear verdict was recorded; these checks will retry next turn.</span>
        </div>
      </div>
    )
  }

  if (message.suggestions !== undefined && suggestions.length === 0 && (!message.decision || message.decision === "empty")) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <CheckCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        <span className="font-medium text-foreground">Step {stepNumber} · Review Suggested Changes to Existing Memories</span>
        <span>✓ Nothing needs attention.</span>
      </div>
    )
  }

  if (message.decision) {
    const mayReopen = canReopen && onReopen && (message.decision === "handled" || message.decision === "skipped")
    return (
      <MemoryReviewStepSummary
        title={`Step ${stepNumber} · Review Suggested Changes to Existing Memories`}
        outcome={
          <>
            ✓ {suggestions.length} {suggestions.length === 1 ? "suggestion" : "suggestions"}, {DECISION_LABELS[message.decision]}.
            {failedKinds.length ? <> Checkup incomplete: {failedKindsLabel(failedKinds)} unchecked; these checks will retry next turn.</> : null}
          </>
        }
        consequence="Review again rechecks the current saved state. Previous saved actions remain. Any new changes regenerate Working Memory."
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
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm" data-memory-control-surface={surface}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><ListChecks className="h-3 w-3" /> Step {stepNumber}</span>
        <span className="text-sm font-medium text-foreground">Review Suggested Changes to Existing Memories</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label="About the library checkup"
              className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="text-xs leading-5 text-muted-foreground">
            Possible fixes to memories already in your library — conflicts, near-duplicates, things that may
            have expired. Review each reason, or skip and they will wait.
          </HoverCardContent>
        </HoverCard>
        <span className="ml-auto text-xs text-muted-foreground">
          {suggestions.length - pendingCount} of {suggestions.length} handled
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {failedKinds.length ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/20 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Some checks did not finish: {failedKindsLabel(failedKinds)}. The completed suggestions below remain reviewable; failed checks will retry next turn.</span>
          </div>
        ) : null}
        {GROUPS.map(({ kind, title, icon: Icon }) => {
          const group = suggestions.filter((s) => s.kind === kind)
          if (group.length === 0) return null
          return (
            <div key={kind}>
              <p className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
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
                        boardResolution={boardResolution}
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

      <div className="mt-3 flex items-center justify-end">
        {stale ? (
          <p className="text-xs text-muted-foreground">This gate belongs to an earlier turn and is no longer active.</p>
        ) : (
          <Button
            variant="juicy"
            size="xs"
            disabled={submitting || (requireAllRows && pendingCount > 0)}
            onClick={() => void settle(pendingCount === 0 ? "handled" : "skipped")}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            {pendingCount === 0
              ? "Continue"
              : requireAllRows
                ? `Review ${pendingCount} remaining`
                : `Skip ${pendingCount} remaining & continue`}
          </Button>
        )}
      </div>
    </div>
  )
}

function CheckupSkeleton({ stepNumber = 2 }: { stepNumber?: number }) {
  const [wordIndex, setWordIndex] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setWordIndex((i) => (i + 1) % STATUS_WORDS.length), 1400)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium"><ListChecks className="h-3 w-3" /> Step {stepNumber} · Reviewing saved memories</span>
      </div>
      <div className="mt-3">
        <MemoryReviewSkeleton
          label="Reviewing suggested changes to saved memories"
          status={STATUS_WORDS[wordIndex]!}
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
  boardResolution,
}: {
  suggestion: MemoryCheckupSuggestionSnapshot
  resolvedOutcome?: string
  onResolved: (outcome: string) => void
  surface: MemoryControlSurface
  boardResolution?: MemoryBoardActionContext
}) {
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
      setError(err instanceof Error ? err.message : "action failed")
    } finally {
      setBusy(null)
    }
  }

  const id = suggestion.memoryId
  const other = suggestion.otherMemoryId
  const boardRow = (memoryId: string, otherMemoryId?: string) => buildBoardCheckupActionContext({
    boardResolution,
    suggestion,
    memoryId,
    otherMemoryId,
  })

  if (suggestion.kind === "promotion") {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <MemoryCitationChip id={id} /> — Automatic scope-widening flow is retired; no further action is available in this card.
      </div>
    )
  }

  if (resolvedOutcome) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <MemoryCitationChip id={id} /> — {resolvedOutcome}
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
          {actionButton(`Keep ${id}`, `kept ${id}, archived ${other}`, () =>
            memoriesApi.resolveAttention("conflict", other, "archive", chatId, id, surface, boardRow(other, id)),
          )}
          {actionButton(`Keep ${other}`, `kept ${other}, archived ${id}`, () =>
            memoriesApi.resolveAttention("conflict", id, "archive", chatId, other, surface, boardRow(id, other)),
          )}
        </>
      ) : null
      break
    case "redundancy":
      actions = other ? (
        <>
          {actionButton("Merge", "merge proposal drafted — review it in Step 1 next turn", () =>
            memoriesApi.resolveAttention("redundant", id, "merge", chatId, other, surface, boardRow(id, other)),
          )}
          {actionButton("Keep both", "kept both, won't be flagged again", () =>
            memoriesApi.resolveAttention("redundant", id, "keep", chatId, other, surface, boardRow(id, other)),
          )}
        </>
      ) : null
      break
    case "staleness":
      actions = (
        <>
          {actionButton("Archive", "archived", () => memoriesApi.resolveAttention("stale", id, "archive", chatId, undefined, surface, boardRow(id)))}
          {actionButton("Keep", "kept — expiry clock reset", () => memoriesApi.resolveAttention("stale", id, "keep", chatId, undefined, surface, boardRow(id)))}
        </>
      )
      break
  }

  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <MemoryCitationChip id={id} />
        {other ? (
          <>
            <span className="text-xs text-muted-foreground">↔</span>
            <MemoryCitationChip id={other} />
          </>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{suggestion.reason}</p>
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
