import { translateUiText, translateServerUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, Archive, Check, ChevronRight, CornerDownRight, CornerUpLeft, Loader2, ShieldCheck, UserRound } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { memoriesApi, recordUiMonitor } from "../../lib/memoriesApi"
import { findCitationBlock, findQuoteBlock, flashQuoteBlock } from "../../lib/quoteJump"
import { revealToolEvidence } from "../../lib/toolEvidence"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { MemoryCitationChip, useEnsureMemoriesLoaded } from "./shared"
import { ArchivedInline, useArchiveMemory } from "../memory/archiveMemory"
import { useMemoryStore } from "../../stores/memoryStore"
import { Button } from "../ui/button"
import {
  useSurfaceExposure,
  useSurfaceViewportVisibility,
  type SurfaceExposureInitiator,
} from "../../app/memory/surfaceExposure"

type MemoryTraceHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_trace" }>
type MemoryTraceLabel = MemoryTraceHydratedMessage["labels"][number]

interface Props {
  message: MemoryTraceHydratedMessage
}

// "mark" renders per-label: operational = green check, injected_without_effect
// = a neutral dot (no icon component — a plain filled circle, same idiom as
// the amber candidate-pill dot), violated = a destructive warning triangle.
const LABEL_TEXT: Record<MemoryTraceLabel["label"], string> = {
  get operational() { return t("memory:traceShaped") },
  get injected_without_effect() { return t("memory:traceNoEffect") },
  get not_applicable() { return t("memory:traceNotApplicable") },
  get violated() { return t("memory:violated") },
}

function TraceStatusMark({ label, compact = false }: { label: MemoryTraceLabel["label"]; compact?: boolean }) {
  useI18n()
  if (label === "operational") return <Check className={cn("h-3 w-3 shrink-0 text-success-foreground", !compact && "mt-0.5")} />
  if (label === "violated") return <AlertTriangle className={cn("h-3 w-3 shrink-0 text-destructive", !compact && "mt-0.5")} />
  if (label === "not_applicable")
    return (
      <span className={cn("flex h-3 w-3 shrink-0 items-center justify-center", !compact && "mt-1.5")}>
        {/* Hollow ring: never entered play — visually distinct from the filled
            no-effect dot (played, changed nothing). */}
        <span className="h-1.5 w-1.5 rounded-full border border-border" />
      </span>
    )
  return (
    <span className={cn("flex h-3 w-3 shrink-0 items-center justify-center", !compact && "mt-1.5")}>
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
    </span>
  )
}

/** Per-section tone: the four verdicts each own a color (mentor 2026-08-15);
 * no green anywhere per the 2026-08-10 sidebar rule. */
const SECTION_TONE: Record<MemoryTraceLabel["label"], { bar: string; head: string }> = {
  violated: { bar: "bg-destructive", head: "text-destructive" },
  operational: { bar: "bg-success", head: "text-success-foreground" },
  not_applicable: { bar: "bg-muted-foreground/50", head: "text-muted-foreground" },
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
  exposureInitiator: SurfaceExposureInitiator
  memoryIds: string[]
  children: ReactNode
}) {
  useI18n()
  const { chatId } = useTranscriptChatContext()
  const [initiator, setInitiator] = useState(exposureInitiator)
  const viewport = useSurfaceViewportVisibility<HTMLElement>()
  const effectiveInitiator = initiator === "user" ? "user" : viewport.initiator
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
      <span className={cn("text-[11px] font-semibold", colors.head)}>{title}</span>
      <span className="text-[11px] text-muted-foreground/70">{count}</span>
    </span>
  )
  return (
    <section className="space-y-1.5" ref={viewport.ref}>
      {onToggle ? (
        <button
          type="button"
          onClick={() => {
            if (folded) setInitiator("user")
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
  get not_followed() { return t("memory:causeNotFollowed") },
  get memory_conflict() { return t("memory:causeConflict") },
}

function TraceRow({ label, turn, onJump, onDemoCorrection }: { label: MemoryTraceLabel; turn?: number; onJump?: (label: MemoryTraceLabel) => void; onDemoCorrection: (id: string, value: { userLabel?: MemoryTraceLabel["label"]; userNote?: string }) => void }) {
  useI18n()
  const renderOptions = useTranscriptRenderOptions()
  const { chatId } = useTranscriptChatContext()
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const memory = useMemoryStore((state) => state.items.find((item) => item.id === label.id))
  const demo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo")
  const archiveControl = useArchiveMemory("chat_audit", { localOnly: demo })
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<MemoryTraceLabel["label"] | null>(null)
  const [correctionNote, setCorrectionNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const [pendingTarget, setPendingTarget] = useState<{ label: MemoryTraceLabel["label"] | null; note?: string } | null>(null)
  const archived = memory?.status === "archived"
  const canCorrect = !renderOptions.readonly && Boolean(chatId) && turn !== undefined && !archived

  useEffect(() => {
    if (!canCorrect) {
      setEditing(false)
      setSelected(null)
      setCorrectionNote("")
      setCorrectionError(null)
    }
  }, [canCorrect])

  function cancelCorrection() {
    setEditing(false)
    setSelected(null)
    setCorrectionNote("")
    setCorrectionError(null)
  }

  async function correct(value: MemoryTraceLabel["label"] | null) {
    if (!chatId || turn === undefined || saving || renderOptions.readonly || (archived && value !== null)) return
    setSaving(true)
    setCorrectionError(null)
    try {
      const note = correctionNote.trim().slice(0, 300)
      if (demo) {
        onDemoCorrection(label.id, value ? { userLabel: value, ...(note ? { userNote: note } : {}) } : {})
        setPendingTarget(null)
      }
      else {
        const result = await memoriesApi.correctTrace(label.id, { sessionId: chatId, turn, label: value, ...(value && note ? { note } : {}) })
        setPendingTarget(result.transcriptPending ? { label: value, ...(value && note ? { note } : {}) } : null)
        void useMemoryStore.getState().loadAll()
      }
      cancelCorrection()
    } catch (err) {
      setCorrectionError(err instanceof Error ? `${t("memory:couldntSaveCorrection")}: ${err.message}` : t("memory:couldntSaveCorrection"))
    } finally { setSaving(false) }
  }

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

  const effective = label.userLabel ?? label.label
  const violated = effective === "violated"
  const cause = label.userLabel ? undefined : label.cause
  const canArchive = !renderOptions.readonly && memory?.status === "active"
  // Every row states its reason (2026-08-19 B2): the NA reason is the named
  // missing object; other labels fall back to the audit note.
  const note = label.note ? translateServerUiText(label.noteUiText, label.note) : undefined
  const reason = label.label === "not_applicable" ? (label.missing ?? note) : note
  return (
    <div className="group/trace grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 normal-case tracking-normal">
      <div className="pt-0.5">
        <TraceStatusMark label={effective} />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <MemoryCitationChip id={label.id} />
          <span className={cn("font-medium", label.userLabel ? "text-muted-foreground line-through" : violated ? "text-destructive" : "text-foreground/80")}>
            {LABEL_TEXT[label.label]}
          </span>
          {label.userLabel ? <span className={cn("inline-flex items-center gap-1 font-medium", violated ? "text-destructive" : "text-foreground")}>
            <UserRound className="h-3 w-3" /> {t("memory:youVerdict", { v0: LABEL_TEXT[effective] })}
          </span> : null}
          {/* Fact/inference line: the reply's own [M-NN] citation is a
              self-report; a verdict only the audit produced is an inference. */}
          <span className="text-[11px] text-muted-foreground/70">
            {label.cited ? t("memory:selfReported") : t("memory:auditFound")}
          </span>
          {!renderOptions.readonly && chatId && turn !== undefined && (label.userLabel || !archived) ? (
            <button type="button" disabled={saving} onClick={() => label.userLabel ? void correct(null) : setEditing(true)}
              className="ml-auto text-[11px] text-muted-foreground/60 underline-offset-2 transition-colors hover:text-foreground hover:underline">
              {label.userLabel ? t("common:undo") : t("memory:notRight")}
            </button>
          ) : null}
        </div>
        {editing && !label.userLabel && canCorrect ? <div className="mt-1.5 rounded-lg border border-border/70 bg-background/60 p-2 dark:bg-muted/40">
          <p className="text-[11px] font-medium text-muted-foreground">{t("memory:whatActuallyHappened")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(Object.keys(LABEL_TEXT) as MemoryTraceLabel["label"][]).filter(value => value !== label.label).map(value => (
              <button key={value} type="button" aria-pressed={selected === value} onClick={() => setSelected(value)}
                className={cn("inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", selected === value && "border-foreground/40 bg-muted text-foreground")}>
                <TraceStatusMark label={value} compact /> {LABEL_TEXT[value]}
              </button>
            ))}
          </div>
          <div className="mt-1.5"><input value={correctionNote} onChange={event => setCorrectionNote(event.target.value)} maxLength={300}
            placeholder={t("memory:correctionWhyPlaceholder")}
            aria-label={t("memory:correctionWhyPlaceholder")}
            onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (event.key === "Escape") cancelCorrection(); else if (selected) void correct(selected) } }}
            className="h-7 w-full min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring" /></div>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="xs" onClick={cancelCorrection} disabled={saving}>{t("common:cancel")}</Button>
            <Button variant="default" size="xs" onClick={() => selected && void correct(selected)} disabled={!selected || saving}>{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t("common:save")}</Button>
          </div>
        </div> : null}
        {correctionError ? <p className="mt-1 text-[11px] text-destructive">{correctionError}</p> : null}
        {pendingTarget && ((label.userLabel ?? null) !== pendingTarget.label || (label.userNote ?? undefined) !== pendingTarget.note)
          ? <p role="status" className="mt-1 text-[11px] text-muted-foreground">{t("memory:correctionSyncPending")}</p> : null}
        {label.userNote ? <p className="mt-0.5 leading-relaxed text-foreground/80">{t("memory:yourNote", { v0: label.userNote })}</p> : null}
        {reason ? <p className={cn("mt-0.5 leading-relaxed text-muted-foreground", (archived || label.userLabel) && "opacity-60")}>{reason}</p> : null}
        {label.label === "violated" && label.cause ? (
          <p className={cn("mt-0.5 leading-relaxed text-muted-foreground/80", (archived || label.userLabel) && "opacity-60")}>{CAUSE_TEXT[label.cause]}</p>
        ) : null}
        {onJump || violated || canArchive || (archived && !renderOptions.readonly) ? (
          <div className="mt-2 flex min-h-7 flex-wrap items-center justify-end gap-2">
            {canArchive ? <button type="button" title={t("memory:archiveEverywhereTitle")} disabled={archiveControl.busyId !== null}
              onClick={() => void archiveControl.archive(label.id).catch(() => {})}
              className={cn("inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground", !violated && "opacity-0 group-hover/trace:opacity-100 focus-visible:opacity-100")}>
              <Archive className="h-3 w-3" /> {t("common:archive")}
            </button> : null}
            {archived && !renderOptions.readonly ? <div className="min-w-0 flex-1"><ArchivedInline id={label.id} busy={archiveControl.busyId === label.id} onUndo={(id) => void archiveControl.restore(id).catch(() => {})} /></div> : null}
            {onJump ? (
              <button
                type="button"
                onClick={() => onJump(label)}
                title={t("memory:jumpEvidence")}
                className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
              >
                <CornerDownRight className="h-3 w-3" /> {t("memory:whereUsed")}</button>
            ) : null}
            {violated && !archived && !renderOptions.readonly ? done ? (
              <span className="text-muted-foreground/80">{translateUiText(done)}</span>
            ) : (
              <>
                {/* The cause remains authoritative for which repair is safe:
                    enforce a sound memory, draft a fix for a conflicting one. */}
                {cause === "not_followed" && chatId ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        "attention",
                        () => memoriesApi.enforce(label.id, chatId, label.quote),
                        t("memory:nextRunEnforced"),
                      )
                    }
                    className="rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {busy === "attention" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} {t("memory:enforceNext")}</button>
                ) : null}
                {cause === "memory_conflict" ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        "fix",
                        () => memoriesApi.draftRevision(label.id, chatId),
                        t("memory:fixDrafted"),
                      )
                    }
                    className="rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
                  >
                    {busy === "fix" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} {t("memory:draftFix")}</button>
                ) : null}
                {!cause ? (
                  <span className="text-muted-foreground/80">
                    {t("memory:causeUnclear")}</span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {archiveControl.error ? <p className="mt-1 text-[11px] text-destructive">{archiveControl.error}</p> : null}
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
  useI18n()
  useEnsureMemoriesLoaded()
  const { chatId } = useTranscriptChatContext()
  const demo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo")
  const [demoCorrections, setDemoCorrections] = useState<Record<string, { userLabel?: MemoryTraceLabel["label"]; userNote?: string }>>({})
  const originalMessage = demo
    ? { ...sourceMessage, status: "ok" as const, summary: "Built the Stripe checkout — recomputed the cart total on the server [M-05] with strict typing [M-01], but charged a floating-point total, violating [M-07].", labels: DEMO_TRACE_LABELS }
    : sourceMessage
  const message = demo ? { ...originalMessage, labels: originalMessage.labels.map(label => ({ ...label, ...demoCorrections[label.id] })) } : originalMessage
  const onDemoCorrection = (id: string, value: { userLabel?: MemoryTraceLabel["label"]; userNote?: string }) => setDemoCorrections(current => ({ ...current, [id]: value }))
  // Expanded by default: the per-memory used / no-effect / violated verdicts are
  // the point of the trace. Hiding them behind a click made "was this memory
  // used?" an extra step (review feedback). Still collapsible for quiet turns.
  const [expanded, setExpanded] = useState(true)
  const [cardInitiator, setCardInitiator] = useState<SurfaceExposureInitiator>("system")
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
    initiator: cardInitiator === "user" ? "user" : cardViewport.initiator,
    memoryIds: message.labels.map((label) => label.id),
    closeReason: "toggle",
  })

  async function jumpTo(label: MemoryTraceLabel) {
    // Monitoring-act beacon: the trace-card jump itself (the Record rail's
    // twin is timeline_quote_jump) — fired on intent, found or not.
    recordUiMonitor("trace_jump", { ids: [label.id], sessionId: chatId, interaction: "click" })
    // Post-hoc: locate the memory by its audit quote; when no quote survived,
    // fall back to the reply's own inline [M-NN] citation chip.
    const block = label.toolId
      ? await revealToolEvidence({ toolId: label.toolId, chatId, quote: label.quote }, rootRef.current)
      : (label.quote ? findQuoteBlock(label.quote, rootRef.current) : null)
        ?? (label.cited ? findCitationBlock(label.id, rootRef.current) : null)
    if (block) {
      setJumpFeedback(null)
      flashQuoteBlock(block)
      setBackVisible(true)
      window.clearTimeout(backTimerRef.current)
      backTimerRef.current = window.setTimeout(() => setBackVisible(false), 12000)
      return
    }
    setJumpFeedback(t("memory:missingEvidence"))
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
      if (!v) setCardInitiator("user")
      return !v
    })
  }

  if (message.status === "pending") {
    // The audit is running (up to ~90s): a quiet shimmer, never a dead gap.
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 flex items-center gap-1.5 text-sm" role="status">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        <AnimatedShinyText className="mx-0 max-w-none italic">{t("memory:auditing")}</AnimatedShinyText>
      </div>
    )
  }

  if (message.status === "empty") {
    // Zero memories in play: an explicit nothing-to-audit terminal so the
    // audit stage never just vanishes (2026-08-19 evening revision).
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        {t("memory:noMemoryAudit")}</div>
    )
  }

  if (message.status === "failed" || message.status === "discarded") {
    const text = message.status === "failed"
      ? t("memory:auditUnavailable")
      : t("memory:auditDiscarded")
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {text}
      </div>
    )
  }

  if (message.labels.length === 0) return null

  const counts = { operational: 0, injected_without_effect: 0, violated: 0, not_applicable: 0 }
  for (const label of message.labels) counts[label.userLabel ?? label.label] += 1
  // Four sections in severity order (2026-08-19 B2), all expanded initially
  // (2026-08-20); the two "didn't act" states keep their OWN collapsible
  // header so they never blur together.
  const violatedRows = message.labels.filter((l) => (l.userLabel ?? l.label) === "violated")
  const shapedRows = message.labels.filter((l) => (l.userLabel ?? l.label) === "operational")
  const notApplicableRows = message.labels.filter((l) => (l.userLabel ?? l.label) === "not_applicable")
  const noEffectRows = message.labels.filter((l) => (l.userLabel ?? l.label) === "injected_without_effect")

  const summaryParts: string[] = []
  if (counts.violated > 0) summaryParts.push(t("memory:traceViolations", { v0: counts.violated }))
  if (counts.operational > 0) summaryParts.push(t("memory:traceShapes", { v0: counts.operational }))
  if (counts.not_applicable > 0) summaryParts.push(t("memory:traceNotApplicableCount", { v0: counts.not_applicable }))
  if (counts.injected_without_effect > 0) summaryParts.push(t("memory:traceNoEffectCount", { v0: counts.injected_without_effect }))
  const hasViolation = counts.violated > 0
  const correctedCount = message.labels.filter(label => label.userLabel).length

  return (
    // Give the audit its own card, matching the pre-turn review cards.
    <div className={MEMORY_CARD} ref={setRootRef}>
      <button type="button" onClick={toggleExpanded} className="group flex w-full flex-wrap items-baseline gap-2 text-left">
        <ShieldCheck aria-hidden className="h-4 w-4 text-muted-foreground" />
        <ChevronRight className={cn("h-3 w-3 self-center text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <span className="text-sm font-semibold text-foreground">{t("memory:auditHeading")}</span>
        <span className={cn("text-xs", hasViolation ? "font-medium text-destructive" : "text-muted-foreground")}>
          {summaryParts.join(" · ")}
        </span>
        {correctedCount ? <span className="text-xs text-muted-foreground">{t("memory:correctedCount", { count: correctedCount })}</span> : null}
      </button>
      {expanded ? (
        <div className="mt-3 flex flex-col gap-3">
          {violatedRows.length > 0 ? (
            <TraceSection
              tone="violated"
              title={t("memory:violatedHeading")}
              count={violatedRows.length}
              exposureInitiator={cardInitiator}
              memoryIds={violatedRows.map((label) => label.id)}
            >
              {violatedRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} turn={message.turn} onDemoCorrection={onDemoCorrection} onJump={label.toolId || label.quote || label.cited ? jumpTo : undefined} />
              ))}
            </TraceSection>
          ) : null}
          {shapedRows.length > 0 ? (
            <TraceSection
              tone="operational"
              title={t("memory:shapedHeading")}
              count={shapedRows.length}
              exposureInitiator={cardInitiator}
              memoryIds={shapedRows.map((label) => label.id)}
            >
              {shapedRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} turn={message.turn} onDemoCorrection={onDemoCorrection} onJump={label.toolId || label.quote || label.cited ? jumpTo : undefined} />
              ))}
            </TraceSection>
          ) : null}
          {notApplicableRows.length > 0 ? (
            <TraceSection
              tone="not_applicable"
              title={t("memory:notApplicableHeading")}
              count={notApplicableRows.length}
              folded={!showNotApplicable}
              onToggle={() => setShowNotApplicable((v) => !v)}
              exposureInitiator={cardInitiator}
              memoryIds={notApplicableRows.map((label) => label.id)}
            >
              {notApplicableRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} turn={message.turn} onDemoCorrection={onDemoCorrection} />
              ))}
            </TraceSection>
          ) : null}
          {noEffectRows.length > 0 ? (
            <TraceSection
              tone="injected_without_effect"
              title={t("memory:noEffectHeading")}
              count={noEffectRows.length}
              folded={!showNoEffect}
              onToggle={() => setShowNoEffect((v) => !v)}
              exposureInitiator={cardInitiator}
              memoryIds={noEffectRows.map((label) => label.id)}
            >
              {noEffectRows.map((label, index) => (
                <TraceRow key={`${label.id}-${index}`} label={label} turn={message.turn} onDemoCorrection={onDemoCorrection} />
              ))}
            </TraceSection>
          ) : null}
          {jumpFeedback ? <p className="text-[11px] text-muted-foreground">{translateUiText(jumpFeedback)}</p> : null}
        </div>
      ) : null}
      {backVisible
        ? createPortal(
            <button
              type="button"
              onClick={jumpBack}
              className="fixed right-6 top-1/2 z-50 flex -translate-y-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-lg transition hover:bg-muted"
            >
              <CornerUpLeft className="h-3.5 w-3.5" /> {t("memory:backTrace")}</button>,
            document.body,
          )
        : null}
    </div>
  )
}
