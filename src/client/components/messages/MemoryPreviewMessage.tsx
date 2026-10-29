import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
import { MemoryBadge } from "../memory/MemoryBadge"
// Independent pre-turn component: Working Memory for This Turn (redesign
// 2026-08-07 §3). It follows the proposed-changes component, but is not a
// third step inside it: the paper treats these as two different shared objects.
// user's model has exactly ONE concept: selected = injected, unselected = not
// injected. The injected list seeds from the model's suggestions (with a
// one-line why each) and grows by clicking items in the collapsed pool;
// removing a row un-injects it. Under the hood the full pool still rides the
// context for cache friendliness and unselected items get a "this turn,
// ignore" instruction — the user's model is true at the behavior level, and
// the audit charges violations against THIS list. None of that machinery is
// explained here.
import { useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import Markdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowUp, LibraryBig, Loader2, Plus, X } from "lucide-react"
import { MemoSyncIcon } from "../MemoSyncIcon"
import type { ExpectedMemoryUse, HydratedTranscriptMessage, MemoryPreviewDecision } from "../../../shared/types"
import { memoriesApi, recordUiMonitor, recordWorkingMemorySelection } from "../../lib/memoriesApi"
import { linkifyMemoryCitations, MEMORY_CITATION_SCHEME } from "../../lib/memoryCitations"
import { previewGateKeyAction } from "../../lib/previewGateKeys"
import { PREVIEW_GATE_PENDING_ATTRIBUTE } from "../../app/chatFocusPolicy"
import { dispatchPreviewDemoDecision, useTranscriptRenderOptions } from "./render-context"
import { cn } from "../../lib/utils"
import { RiseIn } from "../ui/motion-primitives"
import { Button } from "../ui/button"
import { markdownComponentsWithLinks, MemoryCitationChip } from "./shared"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { MemoryReviewSkeleton } from "./MemoryReviewSkeleton"

type MemoryPreviewHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>

interface Props {
  message: MemoryPreviewHydratedMessage
  onRespond: (
    previewId: string,
    decision: MemoryPreviewDecision,
    memoryIds?: string[],
    expectedUses?: ExpectedMemoryUse[],
  ) => void | Promise<void>
  /**
   * An undecided preview that newer turn entries have passed by (e.g. the
   * server restarted while parked) — show it, but don't offer dead buttons.
   */
  stale?: boolean
}

/** Why an item sits on the injected list — the three sources stay visibly distinct. */
type InjectSource = "suggested" | "attention" | "manual" | "standing"

const SOURCE_LABELS: Record<InjectSource, string | null> = {
  get suggested() { return t("memory:suggested") },
  get attention() { return t("memory:enforced") },
  get manual() { return t("memory:youAdded") },
  // Compat default when no suggestion pass exists on this turn — everything
  // rides, and a label would just be noise on every row.
  standing: null,
}

const REVISE_STATUS_WORDS = () => [t("memory:thinking"), t("memory:readingThePool"), t("memory:revisingTheSet")]

const DEFAULT_EXPECTED_USE = "Apply this memory while completing the task."

export function WorkingMemorySelectionError({ error, onRetry, disabled = false }: { error: string; onRetry: () => void; disabled?: boolean }) {
  useI18n()
  return <div role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
    <p className="font-medium text-destructive">{error}</p>
    <p className="mt-1 text-muted-foreground">{t("memory:chooseItemsFromTheMemoryPoolOrRetryTheSelection")}</p>
    <Button type="button" size="xs" variant="outline" className="mt-2" onClick={onRetry} disabled={disabled}>{t("memory:retrySelection")}</Button>
  </div>
}

function replyUrlTransform(url: string): string {
  return url.startsWith(MEMORY_CITATION_SCHEME) ? url : defaultUrlTransform(url)
}

/** Render the embedded assistant with the same Markdown and live memory
 * citations as the main conversation, while keeping its typography compact. */
export function ReplyMarkdown({ text, className }: { text: string; className?: string }) {
  useI18n()
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed text-muted-foreground [&_p]:!my-0 [&_p+p]:!mt-1.5 [&_h1]:!my-1.5 [&_h1]:!text-sm [&_h2]:!my-1.5 [&_h2]:!text-sm [&_h3]:!my-1.5 [&_h3]:!text-xs [&_h4]:!my-1.5 [&_h4]:!text-xs [&_h5]:!my-1.5 [&_h5]:!text-xs [&_h6]:!my-1.5 [&_h6]:!text-xs [&_ul]:!my-1.5 [&_ol]:!my-1.5 [&_li]:!my-0 [&_code]:!text-xs",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={replyUrlTransform}
        components={markdownComponentsWithLinks}
      >
        {linkifyMemoryCitations(text)}
      </Markdown>
    </div>
  )
}

const DECISION_TEXT: Record<MemoryPreviewDecision | "expired", string> = {
  get go_on() { return t("memory:startedWithThisWorkingMemory") },
  get without_memory() { return t("memory:startedWithEmptyWorkingMemory") },
  get dismiss() { return t("memory:turnDismissedMessageReturnedToTheComposer") },
  // System-recorded: the server restarted while this gate was parked.
  get expired() { return t("memory:expiredSendTheMessageAgain") },
}

export function MemoryPreviewMessage({ message, onRespond, stale = false }: Props) {
  useI18n()
  // Guide-tour demo mode: internal UI state is seeded from the tour step and
  // the ask box answers locally — no server call ever leaves this card.
  const { previewDemo } = useTranscriptRenderOptions()
  const [submitting, setSubmitting] = useState<MemoryPreviewDecision | null>(null)
  const pending = message.decision === undefined && !stale
  const refreshing = message.refreshing === true
  const interactive = pending && !refreshing
  const { chatId } = useParams<{ chatId: string }>()

  // selected = injected. null = not seeded yet (waiting for the suggestion
  // pass); a Map so every row remembers WHY it is on the list.
  const [selection, setSelection] = useState<Map<string, InjectSource> | null>(null)
  const [expectedUsesById, setExpectedUsesById] = useState<Map<string, string>>(new Map())
  const [planningIds, setPlanningIds] = useState<Set<string>>(new Set())
  const [failedPlanningIds, setFailedPlanningIds] = useState<Set<string>>(new Set())
  const [selectionRecovered, setSelectionRecovered] = useState(false)
  const [poolExpanded, setPoolExpanded] = useState(false)
  const suggestionsMergedRef = useRef(false)
  const nextPlanTokenRef = useRef(0)
  const planTokenByIdRef = useRef(new Map<string, number>())

  useEffect(() => {
    suggestionsMergedRef.current = false
    setSelection(null)
    setExpectedUsesById(new Map())
    setPlanningIds(new Set())
    setFailedPlanningIds(new Set())
    setSelectionRecovered(false)
    setPoolExpanded(false)
    planTokenByIdRef.current.clear()
  }, [message.refreshVersion])

  const memoriesById = useMemo(() => new Map(message.memories.map((m) => [m.id, m])), [message.memories])
  const transferredIds = useMemo(() => new Set(message.transferredIds ?? []), [message.transferredIds])
  const relevantIds = useMemo(() => new Set((message.relevant ?? []).map((r) => r.id)), [message.relevant])
  const attentionIds = useMemo(() => new Set(message.attentionIds ?? []), [message.attentionIds])

  useEffect(() => {
    const uses = message.decisionExpectedUses ?? message.expectedUses
    if (!uses?.length) return
    setExpectedUsesById((current) => {
      const next = new Map(current)
      for (const use of uses) {
        if (memoriesById.has(use.id) && use.expectedUse.trim()) next.set(use.id, use.expectedUse.trim())
      }
      return next
    })
  }, [message.decisionExpectedUses, message.expectedUses, memoriesById])

  // Seed / merge the suggestion pass exactly once. No pass on this turn →
  // everything rides (the pre-redesign default, kept for LLM-less setups).
  // Pay-attention carryovers (audit follow-up ①) seed regardless, with their
  // own source label.
  useEffect(() => {
    if (!pending) {
      if (selection !== null) return
      const ids = message.decision === "go_on"
        ? (message.decisionSelectedIds ?? message.memories.map((memory) => memory.id))
        : []
      const seed = new Map<string, InjectSource>()
      for (const id of ids) {
        if (!memoriesById.has(id)) continue
        seed.set(id, attentionIds.has(id) ? "attention" : relevantIds.has(id) ? "suggested" : "standing")
      }
      setSelection(seed)
      return
    }
    if (message.selectionError && !selectionRecovered) {
      // Failure is not a model decision to select nothing. Preserve any
      // manual choices and mandatory items, then expose the pool for recovery.
      if (selection === null) {
        setSelection(new Map([...attentionIds].filter((id) => memoriesById.has(id)).map((id) => [id, "attention" as InjectSource])))
        setPoolExpanded(true)
      }
      return
    }
    if (message.relevant === undefined) {
      if (message.relevancePending !== true && selection === null) {
        const seed = new Map(message.memories.map((m) => [m.id, "standing" as InjectSource]))
        for (const id of message.attentionIds ?? []) if (seed.has(id)) seed.set(id, "attention")
        setSelection(seed)
      }
      return
    }
    if (suggestionsMergedRef.current) return
    suggestionsMergedRef.current = true
    setSelection((prev) => {
      const next = new Map(prev ?? [])
      for (const id of message.attentionIds ?? []) {
        if (memoriesById.has(id)) next.set(id, "attention")
      }
      for (const hint of message.relevant!) {
        if (memoriesById.has(hint.id) && !next.has(hint.id)) next.set(hint.id, "suggested")
      }
      return next
    })
  }, [attentionIds, message.decision, message.decisionSelectedIds, message.memories, message.relevant, message.relevancePending, message.selectionError, memoriesById, pending, relevantIds, selection, selectionRecovered])

  const seeding = refreshing || (selection === null && !message.selectionError)
  const injectedIds = useMemo(() => [...(selection?.keys() ?? [])].filter((id) => memoriesById.has(id)), [selection, memoriesById])
  const poolRest = useMemo(
    () => message.memories.filter((m) => !selection?.has(m.id)),
    [message.memories, selection],
  )

  const selectedExpectedUses = useMemo<ExpectedMemoryUse[]>(
    () => injectedIds.map((id) => ({ id, expectedUse: expectedUsesById.get(id) ?? DEFAULT_EXPECTED_USE })),
    [expectedUsesById, injectedIds],
  )
  const planningSelected = useMemo(
    () => injectedIds.some((id) => planningIds.has(id)),
    [injectedIds, planningIds],
  )
  const failedSelected = injectedIds.filter((id) => failedPlanningIds.has(id))
  const selectionError = failedSelected.length ? t("memory:expectedUsePlanningFailedForTheSelectedItems") : !selectionRecovered ? message.selectionError : undefined

  async function planExpectedUses(ids: string[]) {
    const uniqueIds = [...new Set(ids)].filter((id) => memoriesById.has(id))
    if (!uniqueIds.length) return
    if (previewDemo) {
      // Demo card: no planning pass — fill the default line immediately.
      setExpectedUsesById((current) => {
        const next = new Map(current)
        for (const id of uniqueIds) if (!next.has(id)) next.set(id, DEFAULT_EXPECTED_USE)
        return next
      })
      return
    }
    const token = ++nextPlanTokenRef.current
    for (const id of uniqueIds) planTokenByIdRef.current.set(id, token)
    setPlanningIds((current) => new Set([...current, ...uniqueIds]))
    try {
      const planned = await memoriesApi.planInjectionUses(message.task ?? "", uniqueIds, {
        sessionId: chatId,
        previewId: message.previewId,
      })
      const plannedIds = new Set(planned.filter((use) => use.expectedUse.trim()).map((use) => use.id))
      if (uniqueIds.some((id) => !plannedIds.has(id))) throw new Error(t("memory:expectedUsePlanIsIncomplete"))
      setExpectedUsesById((current) => {
        const next = new Map(current)
        for (const use of planned) {
          if (planTokenByIdRef.current.get(use.id) === token && use.expectedUse.trim()) {
            next.set(use.id, use.expectedUse.trim())
          }
        }
        return next
      })
      setFailedPlanningIds((current) => new Set([...current].filter((id) => !uniqueIds.includes(id) || planTokenByIdRef.current.get(id) !== token)))
      setSelectionRecovered(true)
    } catch {
      setFailedPlanningIds((current) => new Set([...current, ...uniqueIds.filter((id) => planTokenByIdRef.current.get(id) === token)]))
    } finally {
      setPlanningIds((current) => {
        const next = new Set(current)
        for (const id of uniqueIds) {
          if (planTokenByIdRef.current.get(id) !== token) continue
          // Keep the last token until the next request/reset. React may apply
          // queued state updaters after this finally block; they still need
          // to distinguish the latest plan from a superseded request.
          next.delete(id)
        }
        return next
      })
    }
  }

  function addToInjected(id: string) {
    if (!interactive || revising) return
    const needsPlan = !expectedUsesById.has(id)
    setSelection((prev) => {
      const next = new Map(prev ?? [])
      if (!next.has(id)) next.set(id, "manual")
      return next
    })
    if (chatId) {
      recordWorkingMemorySelection({ chatId, previewId: message.previewId, memoryId: id, action: "add" })
    }
    if (needsPlan) void planExpectedUses([id])
  }

  function removeFromInjected(id: string) {
    if (!interactive || revising) return
    setSelection((prev) => {
      const next = new Map(prev ?? [])
      next.delete(id)
      return next
    })
    if (chatId) {
      recordWorkingMemorySelection({ chatId, previewId: message.previewId, memoryId: id, action: "remove" })
    }
  }

  // "Ask agent to revise": a small talking assistant inside the card — an
  // instruction changes the selection, a question gets answered; either way
  // it replies (user feedback 2026-08-07: 不能只干不说话). Start stays the
  // only commit point.
  const [reviseText, setReviseText] = useState("")
  const [revising, setRevising] = useState(false)
  const [reviseStatusIndex, setReviseStatusIndex] = useState(0)
  const [exchanges, setExchanges] = useState<Array<{ q: string; a: string }>>([])
  useEffect(() => {
    if (!revising) return
    const timer = setInterval(() => setReviseStatusIndex((i) => (i + 1) % REVISE_STATUS_WORDS().length), 1100)
    return () => clearInterval(timer)
  }, [revising])

  // The tour advances this card's internal state step by step (pool open on
  // the pool step, a seeded exchange on the ask step) — sync when it changes.
  useEffect(() => {
    if (previewDemo?.poolExpanded !== undefined) setPoolExpanded(previewDemo.poolExpanded)
  }, [previewDemo?.poolExpanded])
  useEffect(() => {
    if (previewDemo?.exchanges) setExchanges(previewDemo.exchanges)
  }, [previewDemo?.exchanges])

  async function askAgentToRevise(retryInstruction?: string) {
    const instruction = retryInstruction ?? reviseText.trim()
    if (!instruction || revising) return
    setRevising(true)
    setReviseText("")
    if (previewDemo) {
      // Demo: a short think, then the canned reply — selection stays yours.
      await new Promise((resolve) => setTimeout(resolve, 900))
      setExchanges((prev) => [...prev, { q: instruction, a: previewDemo.reviseReply }])
      setRevising(false)
      return
    }
    try {
      const result = await memoriesApi.reviseInjection(
        instruction,
        injectedIds,
        message.memories.map((m) => m.id),
        chatId,
        message.previewId,
      )
      const changed =
        result.selectedIds.length !== injectedIds.length || result.selectedIds.some((id) => !selection?.has(id))
      if (changed) {
        const addedIds = result.selectedIds.filter((id) => memoriesById.has(id) && !expectedUsesById.has(id))
        setSelection((prev) => {
          const next = new Map<string, InjectSource>()
          for (const id of result.selectedIds) {
            if (!memoriesById.has(id)) continue
            // Kept rows keep their story; agent-added rows read as yours (the
            // instruction was yours).
            next.set(id, prev?.get(id) ?? "manual")
          }
          return next
        })
        if (addedIds.length) void planExpectedUses(addedIds)
      }
      setSelectionRecovered(true)
      setExchanges((prev) => [...prev, { q: instruction, a: result.reply }])
    } catch (err) {
      setExchanges((prev) => [
        ...prev,
        { q: instruction, a: err instanceof Error ? t("memory:couldnTProcessThatValue0", { v0: err.message }) : t("memory:couldnTProcessThat") },
      ])
    } finally {
      setRevising(false)
    }
  }

  function respond(decision: MemoryPreviewDecision, memoryIds?: string[], expectedUses?: ExpectedMemoryUse[]) {
    // Demo card: the production controls report into the Guide's local turn
    // controller. No participant command or transcript endpoint is involved.
    if (dispatchPreviewDemoDecision(previewDemo, {
      previewId: message.previewId,
      decision,
      selectedIds: memoryIds,
      expectedUses,
      prompt: message.task,
    })) return
    if (submitting) return
    setSubmitting(decision)
    void Promise.resolve(onRespond(message.previewId, decision, memoryIds, expectedUses)).catch(() => {
      // Send failed (disconnect / command timeout): re-enable the buttons so the
      // user can retry, instead of a permanently-disabled card with a spinner
      // that even Enter/Esc can't get past (BUG MSG-5).
      setSubmitting(null)
    })
  }

  function start() {
    if (submitting || seeding || revising || planningSelected || failedSelected.length) return
    // Zero injected = the honest "start with nothing" — same user model,
    // existing server semantics.
    if (injectedIds.length === 0) respond("without_memory")
    else respond("go_on", injectedIds, selectedExpectedUses)
  }

  useEffect(() => {
    if (!pending) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const action = previewGateKeyAction(
        event,
        target
          ? { tagName: target.tagName, isContentEditable: target.isContentEditable, value: (target as HTMLTextAreaElement).value }
          : null,
      )
      if (!action) return
      event.preventDefault()
      if (action === "go_on") start()
      else respond(action)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, submitting, message.previewId, injectedIds, seeding, revising, planningSelected, failedSelected.length])

  const decidedText = message.decision
    ? message.decision === "go_on" && message.decisionAuto
      ? t("memory:proceededAutomaticallyNoMemoryInPlan")
      : message.decision === "go_on" && message.decisionSelectedIds
        ? t("memory:startedWithValue0Injected", { v0: message.decisionSelectedIds.length })
        : DECISION_TEXT[message.decision]
    : t("memory:expiredTurnSuperseded")

  return (
    <RiseIn freshAt={message.timestamp}>
      <div
        className={MEMORY_CARD}
        // While the gate awaits a keyboard decision, claim Esc so sticky-focus
        // doesn't swallow it (BUG CORE-1).
        {...(interactive ? { [PREVIEW_GATE_PENDING_ATTRIBUTE]: "" } : {})}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <LibraryBig className="h-4 w-4" /> {t("memory:confirmation")}</span>
          <span className="text-sm font-semibold text-foreground">{t("memory:workingMemoryForThisTurn")}</span>
          {!pending ? <span className="ml-auto text-xs text-muted-foreground">{decidedText}</span> : null}
        </div>
        {pending ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("memory:theseMemoriesWillGuideThisRunAdjustIfNeededThen")}</p>
        ) : null}

        {pending && selectionError ? <WorkingMemorySelectionError
          error={selectionError}
          disabled={revising || planningSelected}
          onRetry={() => {
            if (failedSelected.length) void planExpectedUses(failedSelected)
            else void askAgentToRevise("Retry selecting working memory for the current task from the active pool. Preserve every enforced item and explain the selection.")
          }}
        /> : null}

        {message.memories.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("memory:noMemoriesAreAvailableForThisTurn")}</p>
        ) : (
          <div className={cn("mt-2 flex flex-col gap-1.5", !pending && "opacity-60 dark:opacity-100")}>
            {seeding ? (
              <MemoryReviewSkeleton
                label={t("memory:preparingTheWorkingMemory")}
                status={t("memory:choosingMemories")}
              />
            ) : injectedIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {selectionError ? t("memory:noSelectionIsReadyPickItemsBelowRetryOrExplicitly") : t("memory:workingMemoryIsEmptyPickFromThePoolBelowOr")}
              </p>
            ) : (
              injectedIds.map((id, index) => {
                const memory = memoriesById.get(id)!
                const source = selection?.get(id) ?? "manual"
                const label = SOURCE_LABELS[source]
                const expectedUse = expectedUsesById.get(id) ?? DEFAULT_EXPECTED_USE
                const planning = planningIds.has(id)
                const planningFailed = failedPlanningIds.has(id) || Boolean(message.selectionError && !expectedUsesById.has(id))
                return (
                  <RiseIn key={id} freshAt={pending ? Date.now() : undefined} delay={index * 0.06}>
                    <div className="relative min-w-0 rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 px-3 py-2 text-sm">
                      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-2 @2xl:grid-cols-[auto_minmax(0,1fr)_auto]">
                        <MemoryCitationChip id={id} />
                        <span className="min-w-0 text-foreground">{memory.content}</span>
                        <div className="col-span-2 flex min-w-0 flex-wrap items-center justify-end gap-1.5 @2xl:col-span-1">
                        {transferredIds.has(id) ? (
                          // Landed by THIS turn's transfer stage — also covers
                          // reinforce-merges, where the accept strengthened an
                          // existing memory instead of adding a row (otherwise
                          // an accepted transfer looks like it vanished).
                          <MemoryBadge
                            title={t("memory:landedByThisTurnSTransferReviewAMergeStrengthens")}
                            className="shrink-0 rounded-md border border-info/40 bg-info/10 px-1.5 py-0.5 text-[11px] leading-4 text-info-foreground dark:text-info-foreground"
                          >
                            {t("memory:viaTransfer")}</MemoryBadge>
                        ) : null}
                        {label ? (
                          <MemoryBadge
                            className={cn(
                              "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] leading-4",
                              source === "suggested" && "border-border text-muted-foreground",
                              source === "attention" && "border-info/25 bg-info/8 text-info-foreground",
                              source === "manual" && "border-success/40 bg-success/10 text-success-foreground dark:text-success-foreground",
                            )}
                          >
                            {label}
                          </MemoryBadge>
                        ) : null}
                        {interactive ? (
                          source === "attention" ? (
                            // Enforced rows lock (2026-08-19 D1): no casual ×.
                            // Cancelling the enforce is an explicit, named act.
                            <button
                              type="button"
                              title={t("memory:thisMemoryIsEnforcedForThisRunCancelTheEnforce")}
                              disabled={revising}
                              onClick={() => removeFromInjected(id)}
                              className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40"
                            >
                              {t("memory:cancelEnforce")}</button>
                          ) : (
                            <button
                              type="button"
                              title={t("memory:removeFromThisTurnSWorkingMemory")}
                              disabled={revising}
                              onClick={() => removeFromInjected(id)}
                              className="shrink-0 rounded p-0.5 text-destructive transition-colors hover:bg-muted hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )
                        ) : null}
                        </div>
                      </div>
                      <div className="mt-2 border-t border-border/60 pt-2">
                        <p className="text-xs font-medium text-muted-foreground/75 dark:text-muted-foreground">
                          {t("memory:howTheAgentIsExpectedToUseIt")}</p>
                        {planning ? (
                          <div
                            className="memory-review-skeleton mt-1.5 h-4 w-3/4 rounded-md"
                            aria-label={t("memory:planningHowToUseValue0", { v0: id })}
                          />
                        ) : planningFailed ? (
                          <p className="mt-1 text-xs leading-relaxed text-destructive">{t("memory:expectedUseIsUnavailableRetryPlanningBeforeStarting")}</p>
                        ) : (
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{expectedUse}</p>
                        )}
                      </div>
                    </div>
                  </RiseIn>
                )
              })
            )}
            {message.relevant !== undefined && !selectionError && injectedIds.length > 0 ? (
              <p className="text-[11px] italic text-muted-foreground/70 dark:text-muted-foreground">
                {t("memory:suggestionsAreAModelPredictionAdjustTheListBeforeStarting")}</p>
            ) : null}

            {!seeding && poolRest.length > 0 ? (
              // data-preview-pool: spotlight anchor for the guide tour.
              <div data-preview-pool className="mt-1.5 border-t border-border/70 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <LibraryBig className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">{t("memory:addFromMemoryPool")}</span>
                  <MemoryBadge className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {poolRest.length} {t("memory:available")}</MemoryBadge>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="ml-auto"
                    aria-expanded={poolExpanded}
                    onClick={() => {
                      const next = !poolExpanded
                      setPoolExpanded(next)
                      if (next) recordUiMonitor("preview_pool_expand", { sessionId: chatId, interaction: "click" })
                    }}
                  >
                    {poolExpanded ? t("common:close") : t("memory:browse")}
                  </Button>
                </div>
                {poolExpanded ? (
                  <div className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border/60 pt-2">
                    {poolRest.map((memory) => (
                      <div
                        key={memory.id}
                        className="flex flex-wrap items-start gap-2 rounded-lg px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                      >
                        <MemoryCitationChip id={memory.id} />
                        <span className="min-w-0 flex-1 basis-40">{memory.content}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={!interactive || revising}
                          onClick={() => addToInjected(memory.id)}
                          className="shrink-0"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t("common:add")}</Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {interactive && message.memories.length > 0 ? (
          // data-preview-ask: spotlight anchor for the guide tour.
          <div data-preview-ask className="mt-3 border-t border-border/60 pt-3">
            {exchanges.length > 0 ? (
              <div className="mb-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto pr-1">
                {exchanges.map((exchange, index) => (
                  <div key={index} className="flex flex-col gap-1">
                    <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-muted px-2.5 py-1">
                      <ReplyMarkdown text={exchange.q} className="text-foreground" />
                    </div>
                    <div className="mr-auto flex max-w-[85%] items-start gap-1.5">
                      <MemoSyncIcon animated="none" className="mt-1 size-3.5 shrink-0" />
                      <div className="min-w-0 rounded-xl rounded-bl-sm border border-border/60 px-2.5 py-1">
                        <ReplyMarkdown text={exchange.a} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={reviseText}
                onChange={(e) => setReviseText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    e.stopPropagation()
                    void askAgentToRevise()
                  }
                }}
                disabled={revising || seeding}
                placeholder={t("memory:askAboutThePoolOrTellMeWhatToChange")}
                className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("common:send")}
                disabled={revising || seeding || !reviseText.trim()}
                onClick={() => void askAgentToRevise()}
                className="h-7 w-7 shrink-0 rounded-lg"
              >
                {revising ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {revising ? (
              <AnimatedShinyText className="mx-0 mt-1 max-w-none text-[11px] italic">
                {REVISE_STATUS_WORDS()[reviseStatusIndex]}
              </AnimatedShinyText>
            ) : null}
          </div>
        ) : null}

        {interactive ? (
          <div className="mt-3 flex flex-wrap justify-end items-center gap-2">

            <Button
              variant="ghost"
              size="xs"
              className="text-destructive hover:text-destructive/80"
              disabled={submitting !== null}
              title={t("memory:cancelsThisTurnYourMessageGoesBackToTheComposer")}
              onClick={() => respond("dismiss")}
            >
              {t("memory:dismissTurn")}<kbd className="ml-1.5 rounded bg-muted px-1 font-sans text-[11px] text-muted-foreground">esc</kbd>
            </Button>

            <Button variant="default" size="xs" disabled={submitting !== null || seeding || revising || planningSelected || failedSelected.length > 0} onClick={start}>
              {submitting === "go_on" || submitting === "without_memory" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {planningSelected
                ? t("memory:preparingExpectedUse")
                : injectedIds.length === 0
                  ? t("memory:startWithoutMemory")
                  : t("memory:startValue0Injected", { v0: injectedIds.length })}
              <kbd className="ml-1.5 rounded bg-black/15 px-1 font-sans text-[11px]">⏎</kbd>
            </Button>
          </div>
        ) : null}
      </div>
    </RiseIn>
  )
}
