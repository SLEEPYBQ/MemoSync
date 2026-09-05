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
  suggested: "suggested",
  attention: "enforced",
  manual: "you added",
  // Compat default when no suggestion pass exists on this turn — everything
  // rides, and a label would just be noise on every row.
  standing: null,
}

const REVISE_STATUS_WORDS = ["thinking…", "reading the pool…", "revising the set…"]

const DEFAULT_EXPECTED_USE = "Apply this memory while completing the task."

function replyUrlTransform(url: string): string {
  return url.startsWith(MEMORY_CITATION_SCHEME) ? url : defaultUrlTransform(url)
}

/** Render the embedded assistant with the same Markdown and live memory
 * citations as the main conversation, while keeping its typography compact. */
export function ReplyMarkdown({ text, className }: { text: string; className?: string }) {
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
  go_on: "started with this working memory",
  without_memory: "started with empty working memory",
  dismiss: "turn dismissed — message returned to the composer",
  // System-recorded: the server restarted while this gate was parked.
  expired: "expired — send the message again",
}

export function MemoryPreviewMessage({ message, onRespond, stale = false }: Props) {
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
  const [poolExpanded, setPoolExpanded] = useState(false)
  const suggestionsMergedRef = useRef(false)
  const nextPlanTokenRef = useRef(0)
  const planTokenByIdRef = useRef(new Map<string, number>())

  useEffect(() => {
    suggestionsMergedRef.current = false
    setSelection(null)
    setExpectedUsesById(new Map())
    setPlanningIds(new Set())
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
  }, [attentionIds, message.decision, message.decisionSelectedIds, message.memories, message.relevant, message.relevancePending, memoriesById, pending, relevantIds, selection])

  const seeding = refreshing || selection === null
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
      setExpectedUsesById((current) => {
        const next = new Map(current)
        for (const use of planned) {
          if (planTokenByIdRef.current.get(use.id) === token && use.expectedUse.trim()) {
            next.set(use.id, use.expectedUse.trim())
          }
        }
        for (const id of uniqueIds) {
          if (planTokenByIdRef.current.get(id) === token && !next.has(id)) next.set(id, DEFAULT_EXPECTED_USE)
        }
        return next
      })
    } catch {
      setExpectedUsesById((current) => {
        const next = new Map(current)
        for (const id of uniqueIds) {
          if (planTokenByIdRef.current.get(id) === token && !next.has(id)) next.set(id, DEFAULT_EXPECTED_USE)
        }
        return next
      })
    } finally {
      setPlanningIds((current) => {
        const next = new Set(current)
        for (const id of uniqueIds) {
          if (planTokenByIdRef.current.get(id) !== token) continue
          planTokenByIdRef.current.delete(id)
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
    const timer = setInterval(() => setReviseStatusIndex((i) => (i + 1) % REVISE_STATUS_WORDS.length), 1100)
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

  async function askAgentToRevise() {
    const instruction = reviseText.trim()
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
      setExchanges((prev) => [...prev, { q: instruction, a: result.reply }])
    } catch (err) {
      setExchanges((prev) => [
        ...prev,
        { q: instruction, a: err instanceof Error ? `Couldn't process that (${err.message}).` : "Couldn't process that." },
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
    if (submitting || seeding || revising || planningSelected) return
    // Zero injected = the honest "start with nothing" — same user model,
    // existing server semantics.
    if (injectedIds.length === 0) respond("without_memory")
    else respond("go_on", injectedIds, selectedExpectedUses)
  }

  // Keyboard path for the gate (STUDY_PLAN §2.4): Enter = start with the
  // current injected list, Esc = dismiss. Never while typing.
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
  }, [pending, submitting, message.previewId, injectedIds])

  const decidedText = message.decision
    ? message.decision === "go_on" && message.decisionAuto
      ? "proceeded automatically (no memory in plan)"
      : message.decision === "go_on" && message.decisionSelectedIds
        ? `started with ${message.decisionSelectedIds.length} injected`
        : DECISION_TEXT[message.decision]
    : "expired (turn superseded)"

  return (
    <RiseIn freshAt={message.timestamp}>
      <div
        className="rounded-xl border border-border bg-card p-4 shadow-sm"
        // While the gate awaits a keyboard decision, claim Esc so sticky-focus
        // doesn't swallow it (BUG CORE-1).
        {...(interactive ? { [PREVIEW_GATE_PENDING_ATTRIBUTE]: "" } : {})}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <LibraryBig className="h-3 w-3" /> Confirmation
          </span>
          <span className="text-sm font-medium text-foreground">Working Memory for This Turn</span>
          {!pending ? <span className="ml-auto text-xs text-muted-foreground">{decidedText}</span> : null}
        </div>
        {pending ? (
          <p className="mt-1 text-xs text-muted-foreground">
            These memories will guide this run — adjust if needed, then start.
          </p>
        ) : null}

        {message.memories.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">no memories are available for this turn</p>
        ) : (
          <div className={cn("mt-2 flex flex-col gap-1.5", !pending && "opacity-60")}>
            {seeding ? (
              <MemoryReviewSkeleton
                label="Preparing the working memory"
                status="choosing memories for this turn…"
              />
            ) : injectedIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                working memory is empty — pick from the pool below, or start without memory
              </p>
            ) : (
              injectedIds.map((id, index) => {
                const memory = memoriesById.get(id)!
                const source = selection?.get(id) ?? "manual"
                const label = SOURCE_LABELS[source]
                const expectedUse = expectedUsesById.get(id) ?? DEFAULT_EXPECTED_USE
                const planning = planningIds.has(id)
                return (
                  <RiseIn key={id} freshAt={pending ? Date.now() : undefined} delay={index * 0.06}>
                    <div className="relative -mx-1 overflow-hidden rounded-lg bg-muted/40 px-3 py-2 text-sm border border-border/70">
                      <div className="flex items-start gap-2">
                        <MemoryCitationChip id={id} />
                        <span className="min-w-0 flex-1 text-foreground">{memory.content}</span>
                        {transferredIds.has(id) ? (
                          // Landed by THIS turn's transfer stage — also covers
                          // reinforce-merges, where the accept strengthened an
                          // existing memory instead of adding a row (otherwise
                          // an accepted transfer looks like it vanished).
                          <span
                            title="Landed by this turn's transfer review (a merge strengthens an existing memory)"
                            className="shrink-0 rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] leading-none text-violet-700 dark:text-violet-300"
                          >
                            via transfer
                          </span>
                        ) : null}
                        {label ? (
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
                              source === "suggested" && "border-border text-muted-foreground",
                              source === "attention" && "border-destructive/40 bg-destructive/10 text-destructive",
                              source === "manual" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                            )}
                          >
                            {label}
                          </span>
                        ) : null}
                        {interactive ? (
                          source === "attention" ? (
                            // Enforced rows lock (2026-08-19 D1): no casual ×.
                            // Cancelling the enforce is an explicit, named act.
                            <button
                              type="button"
                              title="This memory is enforced for this run — cancel the enforce to remove it"
                              disabled={revising}
                              onClick={() => removeFromInjected(id)}
                              className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40"
                            >
                              Cancel enforce
                            </button>
                          ) : (
                            <button
                              type="button"
                              title="Remove from this turn's working memory"
                              disabled={revising}
                              onClick={() => removeFromInjected(id)}
                              className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )
                        ) : null}
                      </div>
                      <div className="mt-2 border-t border-border/60 pt-2">
                        <p className="text-xs font-medium text-muted-foreground/75">
                          How the agent is expected to use it
                        </p>
                        {planning ? (
                          <div
                            className="memory-review-skeleton mt-1.5 h-4 w-3/4 rounded-md"
                            aria-label={`Planning how to use ${id}`}
                          />
                        ) : (
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{expectedUse}</p>
                        )}
                      </div>
                    </div>
                  </RiseIn>
                )
              })
            )}
            {message.relevant !== undefined && injectedIds.length > 0 ? (
              <p className="text-[10px] italic text-muted-foreground/70">
                suggestions are a model prediction — adjust the list before starting
              </p>
            ) : null}

            {!seeding && poolRest.length > 0 ? (
              // data-preview-pool: spotlight anchor for the guide tour.
              <div data-preview-pool className="mt-1.5 rounded-lg border border-border/70 bg-background/60 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <LibraryBig className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">Add from memory pool</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                    {poolRest.length} available
                  </span>
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
                    {poolExpanded ? "Close" : "Browse"}
                  </Button>
                </div>
                {poolExpanded ? (
                  <div className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border/60 pt-2">
                    {poolRest.map((memory) => (
                      <div
                        key={memory.id}
                        className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                      >
                        <MemoryCitationChip id={memory.id} />
                        <span className="min-w-0 flex-1">{memory.content}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={!interactive || revising}
                          onClick={() => addToInjected(memory.id)}
                          className="shrink-0"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add
                        </Button>
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
                placeholder="Ask about the pool, or tell me what to change… (e.g. anything on testing? drop the UI ones)"
                className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                type="button"
                size="icon"
                aria-label="Send"
                disabled={revising || seeding || !reviseText.trim()}
                onClick={() => void askAgentToRevise()}
                className="h-7 w-7 shrink-0 rounded-full bg-slate-600 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-white/90"
              >
                {revising ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {revising ? (
              <AnimatedShinyText className="mx-0 mt-1 max-w-none text-[11px] italic">
                {REVISE_STATUS_WORDS[reviseStatusIndex]}
              </AnimatedShinyText>
            ) : null}
          </div>
        ) : null}

        {interactive ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="juicy" size="xs" disabled={submitting !== null || seeding || revising || planningSelected} onClick={start}>
              {submitting === "go_on" || submitting === "without_memory" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {planningSelected
                ? "Preparing expected use…"
                : injectedIds.length === 0
                  ? "Start without memory"
                  : `Start (${injectedIds.length} injected)`}
              <kbd className="ml-1.5 rounded bg-black/15 px-1 font-sans text-[10px]">⏎</kbd>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-destructive hover:text-destructive/80"
              disabled={submitting !== null}
              title="Cancels this turn — your message goes back to the composer."
              onClick={() => respond("dismiss")}
            >
              Dismiss turn
              <kbd className="ml-1.5 rounded bg-muted px-1 font-sans text-[10px] text-muted-foreground">esc</kbd>
            </Button>
          </div>
        ) : null}
      </div>
    </RiseIn>
  )
}
