// Auditing Memory Use (4.2.4; four-way redesign 2026-08-19 B2): after the
// turn, the audit reconciles the reply against the working memory. Four
// sections in severity order, all expanded on initial render (study owner
// 2026-08-20); Not applicable and No visible effect keep their OWN collapsible
// header so the two "didn't act" states never blur together. Every
// row carries color + text label + a one-line reason; an NA row names the
// missing object. Rows distinguish the agent's own inline citations
// (self-report) from what only the audit found (inference).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, Check, ChevronRight, CornerDownRight, CornerUpLeft, Loader2, ShieldCheck } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { memoriesApi, recordUiMonitor } from "../../lib/memoriesApi"
import { findCitationBlock, findQuoteBlock, flashQuoteBlock } from "../../lib/quoteJump"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { MemoryCitationChip, useEnsureMemoriesLoaded } from "./shared"
import {
  useSurfaceExposure,
  useSurfaceViewportVisibility,
  type StudySurfaceExposureInitiator,
} from "../../app/study/surfaceExposure"

type MemoryTraceHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_trace" }>
type MemoryTraceLabel = MemoryTraceHydratedMessage["labels"][number]

interface Props {
  message: MemoryTraceHydratedMessage
}

// "mark" renders per-label: operational = green check, injected_without_effect
// = a neutral dot (no icon component — a plain filled circle, same idiom as
// the amber candidate-pill dot), violated = a destructive warning triangle.
const LABEL_TEXT: Record<MemoryTraceLabel["label"], string> = {
  operational: "shaped this turn",
  injected_without_effect: "no visible effect",
  not_applicable: "not applicable this turn",
  violated: "violated",
}

function TraceStatusMark({ label }: { label: MemoryTraceLabel["label"] }) {
  if (label === "operational") return <Check className="mt-0.5 h-3 w-3 shrink-0 text-session-fg" />
  if (label === "violated") return <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
  if (label === "not_applicable")
    return (
      <span className="mt-1.5 flex h-3 w-3 shrink-0 items-center justify-center">
        {/* Hollow ring: never entered play — visually distinct from the filled
            no-effect dot (played, changed nothing). */}
        <span className="h-1.5 w-1.5 rounded-full border border-slate-400 dark:border-slate-500" />
      </span>
    )
  return (
    <span className="mt-1.5 flex h-3 w-3 shrink-0 items-center justify-center">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
    </span>
  )
}

/** Per-section tone: the four verdicts each own a color (mentor 2026-08-15);
 * no green anywhere per the 2026-08-10 sidebar rule. */
const SECTION_TONE: Record<MemoryTraceLabel["label"], { bar: string; head: string }> = {
  violated: { bar: "bg-destructive", head: "text-destructive" },
  operational: { bar: "bg-foreground/70", head: "text-foreground" },
  not_applicable: { bar: "bg-slate-400 dark:bg-slate-500", head: "text-slate-600 dark:text-slate-400" },
  injected_without_effect: { bar: "bg-muted-foreground/40", head: "text-muted-foreground" },
}

/** One flat verdict group. Violated/Shaped render always-open (no onToggle);
 * the two "didn't act" groups start open but can fold behind their header. */
function TraceSection({
  tone,
  title,
  count,
  folded,
  onToggle,
  exposureInitiator,
  memoryIds,
  children,
}: {
  tone: MemoryTraceLabel["label"]
  title: string
  count: number
  folded?: boolean
  onToggle?: () => void
  exposureInitiator: StudySurfaceExposureInitiator
  memoryIds: string[]
  children: ReactNode
}) {
  const { chatId } = useTranscriptChatContext()
  const [initiator, setInitiator] = useState(exposureInitiator)
  const viewport = useSurfaceViewportVisibility<HTMLElement>()
  const effectiveInitiator = initiator === "participant" ? "participant" : viewport.initiator
  useSurfaceExposure({
    active: folded !== true && viewport.visible,
    surface: "audit_group",
    chatId,
    initiator: effectiveInitiator,
    memoryIds,
    closeReason: "toggle",
  })
  const colors = SECTION_TONE[tone]
  const header = (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-[2px]", colors.bar)} />
      <span className={cn("text-[10px] font-semibold uppercase tracking-wide", colors.head)}>{title}</span>
      <span className="text-[10px] text-muted-foreground/70">{count}</span>
    </span>
  )
  return (
    <section className="space-y-1.5" ref={viewport.ref}>
      {onToggle ? (
        <button
          type="button"
          onClick={() => {
            if (folded) setInitiator("participant")
            onToggle()
          }}
          className="flex w-full items-center gap-1 text-left transition-colors hover:opacity-80"
        >
          <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform", !folded && "rotate-90")} />
          {header}
        </button>
      ) : (
        header
      )}
      {onToggle && folded ? null : <div className="space-y-2">{children}</div>}
    </section>
  )
}

const CAUSE_TEXT: Record<NonNullable<MemoryTraceLabel["cause"]>, string> = {
  not_followed: "the memory holds — the agent didn't comply",
  memory_conflict: "the memory itself clashes with the task or another memory",
}

function TraceRow({ label, onJump }: { label: MemoryTraceLabel; onJump?: (label: MemoryTraceLabel) => void }) {
  const renderOptions = useTranscriptRenderOptions()
  const { chatId } = useTranscriptChatContext()
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function act(name: string, run: () => Promise<unknown>, doneText: string) {
    setBusy(name)
    try {
      // Figure-only: under ?demo the trace rows are fabricated ids not in any
      // real injected pool, so skip the API and just show the settled UI.
      const demo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo")
      if (!demo) await run()
      setDone(doneText)
    } catch (err) {
      setDone(err instanceof Error ? `failed — ${err.message}` : "failed")
    } finally {
      setBusy(null)
    }
  }

  const violated = label.label === "violated"
  // Every row states its reason (2026-08-19 B2): the NA reason is the named
  // missing object; other labels fall back to the audit note.
  const reason = label.label === "not_applicable" ? (label.missing ?? label.note) : label.note
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 normal-case tracking-normal">
      <div className="pt-0.5">
        <TraceStatusMark label={label.label} />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <MemoryCitationChip id={label.id} />
          <span className={cn("font-medium", violated ? "text-destructive" : "text-foreground/80")}>
            {LABEL_TEXT[label.label]}
          </span>
          {/* Fact/inference line: the reply's own [M-NN] citation is a
              self-report; a verdict only the audit produced is an inference. */}
          <span className="text-[10px] text-muted-foreground/70">
            {label.cited ? "self-reported" : "audit-found"}
          </span>
        </div>
        {reason ? <p className="mt-0.5 leading-relaxed text-muted-foreground">{reason}</p> : null}
        {violated && label.cause ? (
          <p className="mt-0.5 leading-relaxed text-muted-foreground/80">{CAUSE_TEXT[label.cause]}</p>
        ) : null}
        {onJump || violated ? (
          <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
            {onJump ? (
              <button
                type="button"
                onClick={() => onJump(label)}
                title="Jump to where this memory was used in the reply"
                className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
              >
                <CornerDownRight className="h-3 w-3" /> where used
              </button>
            ) : null}
            {violated && !renderOptions.readonly ? done ? (
              <span className="text-muted-foreground/80">{done}</span>
            ) : (
              <>
                {/* The cause remains authoritative for which repair is safe:
                    enforce a sound memory, draft a fix for a conflicting one. */}
                {label.cause === "not_followed" && chatId ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        "attention",
                        () => memoriesApi.enforce(label.id, chatId, label.quote),
                        "enforced — locked into the next run; it must be followed",
                      )
                    }
                    className="rounded-md border border-destructive/40 bg-background px-2 py-1 font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    {busy === "attention" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Enforce this next run
                  </button>
                ) : null}
                {label.cause === "memory_conflict" ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        "fix",
                        () => memoriesApi.draftRevision(label.id, chatId),
                        "fix drafted — review it at Step 1 next turn",
                      )
                    }
                    className="rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
                  >
                    {busy === "fix" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Draft a fix
                  </button>
                ) : null}
                {!label.cause ? (
                  <span className="text-muted-foreground/80">
                    Cause unclear. Review the memory and reply before taking action.
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// Figure-only: with ?demo in the URL, force all four audit verdicts so a
// screenshot of the big card shows every state. Never used in normal operation.
const DEMO_TRACE_LABELS: MemoryTraceHydratedMessage["labels"] = [
  { id: "M-05", label: "operational", quote: "const total = recomputeCartTotal(cart)", cited: true },
  { id: "M-01", label: "operational", quote: "export function createOrder(input: OrderInput)", cited: true },
  // Two violations, one of each cause: not_followed → "Enforce this next run",
  // memory_conflict → "Draft a fix".
  { id: "M-07", label: "violated", cause: "not_followed", impact: "negative", quote: "const tax = price * 0.08", note: "Used a floating-point price; M-07 requires integer cents.", cited: true },
  { id: "M-16", label: "violated", cause: "memory_conflict", impact: "negative", quote: "// port 4000", note: "M-16 says the API runs on :4000, which contradicts M-05 (:3001).", cited: true },
  { id: "M-13", label: "injected_without_effect" },
  { id: "M-11", label: "not_applicable", missing: "no database migration was written this turn" },
]

export function MemoryTraceMessage({ message: sourceMessage }: Props) {
  useEnsureMemoriesLoaded()
  const { chatId } = useTranscriptChatContext()
  const message = (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo"))
    ? { ...sourceMessage, status: "ok" as const, summary: "Built the Stripe checkout — recomputed the cart total on the server [M-05] with strict typing [M-01], but charged a floating-point total, violating [M-07].", labels: DEMO_TRACE_LABELS }
    : sourceMessage
  // Expanded by default: the per-memory used / no-effect / violated verdicts are
  // the point of the trace. Hiding them behind a click made "was this memory
  // used?" an extra step (review feedback). Still collapsible for quiet turns.
  const [expanded, setExpanded] = useState(true)
  const [cardInitiator, setCardInitiator] = useState<StudySurfaceExposureInitiator>("system")
  // All four groups open on initial render (study-owner decision 2026-08-20):
  // the two "didn't act" sections keep their own headers and stay separately
  // collapsible, but no verdict starts hidden behind a fold.
  const [showNoEffect, setShowNoEffect] = useState(true)
  const [showNotApplicable, setShowNotApplicable] = useState(true)
  const expandReportedRef = useRef(false)
  // Jump-to-use (Prof. Ma point 3): "where used" locates each memory purely
  // post-hoc from the trace quote — independent of whether the agent cited it
  // inline. The Trace root doubles as the "back" target.
  const rootRef = useRef<HTMLDivElement>(null)
  const cardViewport = useSurfaceViewportVisibility<HTMLDivElement>()
  const setRootRef = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element
    cardViewport.ref(element)
  }, [cardViewport.ref])
  const [backVisible, setBackVisible] = useState(false)
  const [jumpFeedback, setJumpFeedback] = useState<string | null>(null)
  const backTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(backTimerRef.current), [])
  const hasAuditableCard = message.labels.length > 0
    && message.status !== "pending"
    && message.status !== "empty"
    && message.status !== "failed"
    && message.status !== "discarded"
  useSurfaceExposure({
    active: hasAuditableCard && expanded && cardViewport.visible,
    surface: "audit_card",
    chatId,
    initiator: cardInitiator === "participant" ? "participant" : cardViewport.initiator,
    memoryIds: message.labels.map((label) => label.id),
    closeReason: "toggle",
  })

  function jumpTo(label: MemoryTraceLabel) {
    // Monitoring-act beacon: the trace-card jump itself (the Record rail's
    // twin is timeline_quote_jump) — fired on intent, found or not.
    recordUiMonitor("trace_jump", { ids: [label.id], sessionId: chatId, interaction: "click" })
    // Post-hoc: locate the memory by its audit quote; when no quote survived,
    // fall back to the reply's own inline [M-NN] citation chip.
    const block =
      (label.quote ? findQuoteBlock(label.quote, rootRef.current) : null) ??
      (label.cited ? findCitationBlock(label.id, rootRef.current) : null)
    if (block) {
      setJumpFeedback(null)
      flashQuoteBlock(block)
      setBackVisible(true)
      window.clearTimeout(backTimerRef.current)
      backTimerRef.current = window.setTimeout(() => setBackVisible(false), 12000)
      return
    }
    setJumpFeedback("The quoted reply is not currently visible in the transcript.")
  }

  function jumpBack() {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
    setBackVisible(false)
    window.clearTimeout(backTimerRef.current)
  }

  function toggleExpanded() {
    setExpanded((v) => {
      // Monitoring-act beacon: the user re-opened the verdicts after collapsing.
      if (!v && !expandReportedRef.current) {
        expandReportedRef.current = true
        if (chatId) recordUiMonitor("trace_expand", { ids: message.labels.map((l) => l.id), sessionId: chatId, interaction: "click" })
      }
      if (!v) setCardInitiator("participant")
      return !v
    })
  }

  if (message.status === "pending") {
    // The audit is running (up to ~90s): a quiet shimmer, never a dead gap.
    return (
      <div className="flex items-center gap-1.5 text-[11px]" role="status">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        <AnimatedShinyText className="mx-0 max-w-none italic">auditing memory use…</AnimatedShinyText>
      </div>
    )
  }

  if (message.status === "empty") {
    // Zero memories in play: an explicit nothing-to-audit terminal so the
    // audit stage never just vanishes (2026-08-19 evening revision).
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        No memories were in play this turn. Nothing to audit.
      </div>
    )
  }

  if (message.status === "failed" || message.status === "discarded") {
    const text = message.status === "failed"
      ? "Memory audit unavailable for this turn."
      : "Memory audit discarded because the memory changed before the verdict was saved."
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {text}
      </div>
    )
  }

  if (message.labels.length === 0) return null

  const counts = { operational: 0, injected_without_effect: 0, violated: 0, not_applicable: 0 }
  for (const label of message.labels) counts[label.label] += 1
  // Four sections in severity order (2026-08-19 B2), all expanded initially
  // (2026-08-20); the two "didn't act" states keep their OWN collapsible
  // header so they never blur together.
  const violatedRows = message.labels.filter((l) => l.label === "violated")
  const shapedRows = message.labels.filter((l) => l.label === "operational")
  const notApplicableRows = message.labels.filter((l) => l.label === "not_applicable")
  const noEffectRows = message.labels.filter((l) => l.label === "injected_without_effect")

  const summaryParts: string[] = []
  if (counts.violated > 0) summaryParts.push(`${counts.violated} violated`)
  if (counts.operational > 0) summaryParts.push(`${counts.operational} shaped`)
  if (counts.not_applicable > 0) summaryParts.push(`${counts.not_applicable} not applicable`)
  if (counts.injected_without_effect > 0) summaryParts.push(`${counts.injected_without_effect} no visible effect`)
  const hasViolation = counts.violated > 0

  return (
    // A formal card, same family as the step gates (redesign 2026-08-07 §3):
    // the audit is a station of the cycle, not a footnote under the reply.
    <div className="rounded-xl border border-border/70 bg-card p-4 text-xs" ref={setRootRef}>
      <button type="button" onClick={toggleExpanded} className="group flex w-full flex-wrap items-baseline gap-2 text-left">
        <ChevronRight className={cn("h-3 w-3 self-center text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <span className="text-[11px] font-semibold text-muted-foreground">Auditing Memory Use</span>
        <span className={cn("text-xs", hasViolation ? "font-medium text-destructive" : "text-muted-foreground")}>
          {summaryParts.join(" · ")}
        </span>
      </button>
      {expanded ? (
        <div className="mt-3 flex flex-col gap-3">
          {violatedRows.length > 0 ? (
            <TraceSection
              tone="violated"
              title="Violated"
              count={violatedRows.length}
              exposureInitiator={cardInitiator}
              memoryIds={violatedRows.map((label) => label.id)}
            >
              {violatedRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} onJump={label.quote || label.cited ? jumpTo : undefined} />
              ))}
            </TraceSection>
          ) : null}
          {shapedRows.length > 0 ? (
            <TraceSection
              tone="operational"
              title="Shaped this turn"
              count={shapedRows.length}
              exposureInitiator={cardInitiator}
              memoryIds={shapedRows.map((label) => label.id)}
            >
              {shapedRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} onJump={label.quote || label.cited ? jumpTo : undefined} />
              ))}
            </TraceSection>
          ) : null}
          {notApplicableRows.length > 0 ? (
            <TraceSection
              tone="not_applicable"
              title="Not applicable this turn"
              count={notApplicableRows.length}
              folded={!showNotApplicable}
              onToggle={() => setShowNotApplicable((v) => !v)}
              exposureInitiator={cardInitiator}
              memoryIds={notApplicableRows.map((label) => label.id)}
            >
              {notApplicableRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} />
              ))}
            </TraceSection>
          ) : null}
          {noEffectRows.length > 0 ? (
            <TraceSection
              tone="injected_without_effect"
              title="No visible effect"
              count={noEffectRows.length}
              folded={!showNoEffect}
              onToggle={() => setShowNoEffect((v) => !v)}
              exposureInitiator={cardInitiator}
              memoryIds={noEffectRows.map((label) => label.id)}
            >
              {noEffectRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} />
              ))}
            </TraceSection>
          ) : null}
          {jumpFeedback ? <p className="text-[11px] text-muted-foreground">{jumpFeedback}</p> : null}
        </div>
      ) : null}
      {backVisible
        ? createPortal(
            <button
              type="button"
              onClick={jumpBack}
              className="fixed right-6 top-1/2 z-50 flex -translate-y-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-lg transition hover:bg-muted"
            >
              <CornerUpLeft className="h-3.5 w-3.5" /> Back to trace
            </button>,
            document.body,
          )
        : null}
    </div>
  )
}
