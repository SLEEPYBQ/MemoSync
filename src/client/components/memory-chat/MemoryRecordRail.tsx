// Memory Record — the sidebar re-presentation of the monitoring column over
// time (redesign discussion 2026-08-10). Each turn mirrors the transcript
// stations one-to-one as two-line stage rows: a Title-Case stage name (the
// system's own vocabulary, same icon as the in-flow card) above a lowercase
// one-line statement. Verdicts live ONLY in the audit stage; the summary
// sentence stays a neutral narrative. Hovering a stage row pops the same
// items the big card holds; clicking jumps back to that card in the
// transcript. Monitoring only — the record holds no buttons that change
// state; control stays at the gates.
import { Fragment, useMemo } from "react"
import {
  ArrowRightLeft,
  CircleSlash,
  ClipboardCheck,
  Inbox,
  LibraryBig,
  ListChecks,
  TextQuote,
  type LucideIcon,
} from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import {
  buildMemoryRecord,
  memoryRecordMonitorIds,
  turnPulse,
  type MemoryRecord,
  type MemoryRecordTurn,
  type RecordAuditStage,
} from "../../lib/memoryTimeline"
import { recordUiMonitor } from "../../lib/memoriesApi"
import { findQuoteBlock, flashQuoteBlock } from "../../lib/quoteJump"
import { CurrentTurnMemoryCitationProvider, MemoryCitationChip } from "../messages/shared"
import { useMemoryStore } from "../../stores/memoryStore"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { cn } from "../../lib/utils"

interface Props {
  chatId: string
  messages: HydratedTranscriptMessage[]
  /** Current Claude text before it becomes a hydrated transcript row. */
  streamingText?: string | null
  /** Server-authoritative active-turn state; remains true between text chunks. */
  isTurnActive?: boolean
}

const PULSE_CLASSES: Record<ReturnType<typeof turnPulse>, string> = {
  violated: "bg-destructive",
  shaped: "bg-foreground/60",
  quiet: "border border-muted-foreground/40 bg-background",
}

const CITATION_RE = /\[(M-\d+)\]/g

function CurrentTurnOnly({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return enabled
    ? <CurrentTurnMemoryCitationProvider>{children}</CurrentTurnMemoryCitationProvider>
    : children
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** The audit recap with its [M-NN] citations as live chips. */
function SummaryLine({ text }: { text: string }) {
  const parts = text.split(CITATION_RE)
  return (
    <p className="text-xs leading-relaxed text-foreground">
      {parts.map((part, i) =>
        // Odd indexes are the captured M-NN groups from the split regex.
        i % 2 === 0 ? <Fragment key={i}>{part}</Fragment> : <MemoryCitationChip key={i} id={part} />,
      )}
    </p>
  )
}

/** Scroll the transcript to a station's card and flash it (virtualized rows
 *  that are not mounted simply no-op — same limit as quote jumps). */
function jumpToEntry(chatId: string, entryId: string) {
  const el = document.querySelector<HTMLElement>(`[data-transcript-row-id="${entryId}"]`)
    ?? document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  flashQuoteBlock(el)
  recordUiMonitor("timeline_slot_jump", { sessionId: chatId, interaction: "click" })
}

/**
 * One stage as two lines: icon + Title-Case stage name, then the statement.
 * `detail` (when given) renders in a hover card — the same read-only popover
 * language as hovering a memory chip.
 */
function StageRow({
  icon: Icon,
  label,
  dim,
  onJump,
  detail,
  children,
}: {
  icon: LucideIcon
  label: string
  dim?: boolean
  onJump?: () => void
  detail?: React.ReactNode
  children: React.ReactNode
}) {
  const row = (
    <div
      className={cn(
        "-ml-1 rounded-md px-1 py-0.5 transition-colors",
        onJump && "cursor-pointer hover:bg-muted",
      )}
      onClick={onJump}
      role={onJump ? "button" : undefined}
    >
      <div className="flex items-baseline gap-1.5 text-[11px] font-medium text-foreground/75">
        <Icon className="h-3 w-3 shrink-0 translate-y-[1.5px] text-muted-icon" />
        {label}
      </div>
      <div className={cn("ml-[18px] mt-px text-[11px] leading-relaxed", dim ? "text-muted-foreground/50" : "text-muted-foreground")}>
        {children}
      </div>
    </div>
  )
  if (!detail) return row
  return (
    <HoverCard openDelay={260} closeDelay={120}>
      <HoverCardTrigger asChild>{row}</HoverCardTrigger>
      <HoverCardContent side="left" align="start" className="w-[330px] p-3">
        {detail}
      </HoverCardContent>
    </HoverCard>
  )
}

/** A proposed candidate: content lives in the memory store, not the
 *  transcript (ids alone persist) — resolve live, fall back to the snapshot. */
function CandidateLine({ id, fallback }: { id: string; fallback?: string }) {
  const memory = useMemoryStore((s) => s.items.find((m) => m.id === id))
  const content = memory?.content ?? fallback
  return (
    <p className="text-[11px] leading-relaxed text-foreground">
      <MemoryCitationChip id={id} />
      <span className={cn("ml-1", content ? "text-muted-foreground" : "italic text-muted-foreground/60")}>
        {content ? truncate(content, 100) : "no longer available"}
      </span>
    </p>
  )
}

function DecisionWord({ decision }: { decision?: string }) {
  const WORDS: Record<string, string> = {
    reviewed: "reviewed",
    handled: "handled",
    skipped: "skipped for now",
    cancelled: "cancelled",
    expired: "expired",
  }
  if (!decision || !WORDS[decision]) return null
  return <> · {WORDS[decision]}</>
}

function AuditDetail({ chatId, audit }: { chatId: string; audit: RecordAuditStage }) {
  const jumpToQuote = (quote: string) => {
    recordUiMonitor("timeline_quote_jump", { sessionId: chatId, interaction: "click" })
    const block = findQuoteBlock(quote, null)
    if (!block) return
    flashQuoteBlock(block)
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-muted-foreground/70">
        Memory Use Audit — this turn's output checked against each working-memory item
      </p>
      {audit.labels.map((label) => (
        <div key={label.id} className="flex items-baseline gap-1.5 text-[11px]">
          <MemoryCitationChip id={label.id} />
          <span className="min-w-0">
            {label.label === "violated" ? (
              <>
                <span className="font-medium text-destructive">violated</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
                  {label.quote ? <span className="text-foreground/80">“{truncate(label.quote, 110)}”</span> : null}
                  {label.note ? <span className="block">{label.note}</span> : null}
                  {label.quote ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        jumpToQuote(label.quote!)
                      }}
                      className="mt-0.5 block underline underline-offset-2 hover:text-foreground"
                    >
                      show in transcript
                    </button>
                  ) : null}
                </span>
              </>
            ) : label.label === "operational" ? (
              <span className="text-foreground/80">shaped this turn</span>
            ) : label.label === "not_applicable" ? (
              // Slate + the named missing object: "never entered play" must not
              // blur into "played, changed nothing" (mentor 2026-08-15).
              <span className="text-slate-600 dark:text-slate-400">
                not applicable
                {label.missing ? <span className="text-muted-foreground"> — {label.missing}</span> : null}
              </span>
            ) : (
              <span className="text-muted-foreground">no visible effect</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function TurnBlock({ chatId, turn, isLast, isLive }: { chatId: string; turn: MemoryRecordTurn; isLast: boolean; isLive: boolean }) {
  const pulse = turnPulse(turn)
  const expired = turn.decision === "expired"
  const noMemory = turn.decision === "dismiss" || turn.decision === "without_memory"
  const reported = turn.reported ? [...turn.reported.counts.entries()] : []
  const audit = turn.audit
  const auditCounts = useMemo(() => {
    const counts = { shaped: 0, violated: 0, noEffect: 0 }
    for (const label of audit?.labels ?? []) {
      if (label.label === "operational") counts.shaped += 1
      else if (label.label === "violated") counts.violated += 1
      else counts.noEffect += 1
    }
    return counts
  }, [audit])

  return (
    <div className="flex gap-2.5">
      {/* Spine: pulse node + connector. */}
      <div className="flex w-6 shrink-0 flex-col items-center">
        <span
          className={cn(
            "mt-[3px] h-2 w-2 shrink-0 rounded-full",
            isLast && !turn.audit && !expired && !noMemory
              ? "border-2 border-muted-icon bg-background"
              : PULSE_CLASSES[pulse],
          )}
        />
        {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
      </div>

      <div className={cn("min-w-0 flex-1", !isLast && "pb-5")}>
        {/* Head: turn number + the settled recap (or the turn's fate). */}
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] font-semibold leading-relaxed text-muted-icon">t{turn.turn}</span>
          <div className="min-w-0 flex-1">
            {expired ? (
              <p className="text-[11px] italic text-muted-foreground">cancelled before running (server restart)</p>
            ) : noMemory ? (
              <p className="text-[11px] italic text-muted-foreground">
                ran without memory{turn.decision === "dismiss" ? " (gate dismissed)" : ""}
              </p>
            ) : turn.summary ? (
              <SummaryLine text={turn.summary} />
            ) : turn.audit && turn.audit.status !== "pending" ? (
              // A settled audit without a recap sentence still settles the row
              // (2026-08-19 evening revision: no eternal "running…").
              <p className="text-[11px] italic text-muted-foreground">
                {turn.audit.status === "empty"
                  ? "no memory was in play this turn"
                  : turn.audit.status === "discarded"
                    ? "audit discarded (memory changed mid-pass)"
                    : turn.audit.status === "failed"
                      ? "audit unavailable for this turn"
                      : "audit complete"}
              </p>
            ) : isLast ? (
              <p className="text-[11px] italic text-muted-foreground">running…</p>
            ) : null}
          </div>
        </div>

        {!expired ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {turn.candidates ? (
              <StageRow
                icon={Inbox}
                label="Memory Candidates"
                dim={!turn.candidates.pending && turn.candidates.items.length === 0}
                onJump={() => jumpToEntry(chatId, turn.candidates!.entryId)}
                detail={turn.candidates.items.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {turn.candidates.items.map((item) => (
                      <CandidateLine key={item.id} id={item.id} fallback={item.content} />
                    ))}
                  </div>
                ) : undefined}
              >
                {turn.candidates.pending ? (
                  <AnimatedShinyText animate shimmerWidth={60}>checking this prompt…</AnimatedShinyText>
                ) : turn.candidates.items.length === 0 ? (
                  "none proposed"
                ) : (
                  <>{turn.candidates.items.length} proposed<DecisionWord decision={turn.candidates.decision} /></>
                )}
              </StageRow>
            ) : null}

            {turn.transfers ? (
              <StageRow
                icon={ArrowRightLeft}
                label="Transfer Suggestions"
                dim={!turn.transfers.pending && turn.transfers.items.length === 0}
                onJump={() => jumpToEntry(chatId, turn.transfers!.entryId)}
                detail={turn.transfers.items.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {turn.transfers.items.map((item, i) => (
                      <p key={i} className="text-[11px] leading-relaxed text-foreground">
                        {truncate(item.content, 100)}
                        <span className="text-muted-foreground"> · from {item.sourceLabel}</span>
                      </p>
                    ))}
                  </div>
                ) : undefined}
              >
                {turn.transfers.pending ? (
                  <AnimatedShinyText animate shimmerWidth={60}>searching your other projects…</AnimatedShinyText>
                ) : turn.transfers.items.length === 0 ? (
                  "nothing worth bringing in"
                ) : (
                  <>{turn.transfers.items.length} suggested<DecisionWord decision={turn.transfers.decision} /></>
                )}
              </StageRow>
            ) : null}

            {turn.checkup ? (
              <StageRow
                icon={ListChecks}
                label="Saved Memory Changes"
                dim={!turn.checkup.pending && turn.checkup.items.length === 0 && !turn.checkup.failedKinds?.length}
                onJump={() => jumpToEntry(chatId, turn.checkup!.entryId)}
                detail={turn.checkup.items.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {turn.checkup.items.map((item, i) => (
                      <p key={i} className="text-[11px] leading-relaxed text-foreground">
                        <MemoryCitationChip id={item.memoryId} />
                        {item.otherMemoryId ? <> <MemoryCitationChip id={item.otherMemoryId} /></> : null}
                        <span className="text-muted-foreground"> {truncate(item.reason, 100)}</span>
                      </p>
                    ))}
                  </div>
                ) : undefined}
              >
                {turn.checkup.pending ? (
                  <AnimatedShinyText animate shimmerWidth={60}>checking saved memories…</AnimatedShinyText>
                ) : turn.checkup.failedKinds?.length ? (
                  <>
                    {turn.checkup.items.length > 0 ? `${turn.checkup.items.length} suggestion${turn.checkup.items.length > 1 ? "s" : ""} · ` : ""}
                    checkup incomplete · {turn.checkup.failedKinds.join(", ")} unchecked
                    <DecisionWord decision={turn.checkup.decision} />
                  </>
                ) : turn.checkup.items.length === 0 ? (
                  "nothing needs attention"
                ) : (
                  <>
                    {turn.checkup.items.length} suggestion{turn.checkup.items.length > 1 ? "s" : ""}
                    <DecisionWord decision={turn.checkup.decision} />
                  </>
                )}
              </StageRow>
            ) : null}

            {turn.injected ? (
              <CurrentTurnOnly enabled={isLive}>
                <StageRow
                  icon={LibraryBig}
                  label="Working Memory"
                  onJump={() => jumpToEntry(chatId, turn.injected!.entryId)}
                  detail={turn.injected.items.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {turn.injected.items.map((item) => (
                        <p key={item.id} className="text-[11px] leading-relaxed text-foreground">
                          <MemoryCitationChip id={item.id} />
                          <span className="text-muted-foreground"> {truncate(item.content, 90)}</span>
                        </p>
                      ))}
                    </div>
                  ) : undefined}
                >
                  {turn.injected.items.length === 0 ? (
                    "started with nothing injected"
                  ) : (
                    <span className="inline-flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
                      {turn.injected.items.length} injected ·
                      {turn.injected.items.map((item) => (
                        <MemoryCitationChip key={item.id} id={item.id} />
                      ))}
                    </span>
                  )}
                </StageRow>
              </CurrentTurnOnly>
            ) : null}

            {reported.length > 0 ? (
              <StageRow icon={TextQuote} label="Reported Memory Use">
                <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  {reported.map(([id, count]) => (
                    <span key={id} className="inline-flex items-baseline gap-0.5">
                      <CurrentTurnOnly enabled={isLive && Boolean(turn.injected?.items.some((item) => item.id === id))}>
                        <MemoryCitationChip id={id} />
                      </CurrentTurnOnly>
                      {count > 1 ? <span>×{count}</span> : null}
                    </span>
                  ))}
                </span>
              </StageRow>
            ) : null}

            {turn.interrupted ? (
              <StageRow icon={CircleSlash} label="Interrupted">
                <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-destructive">
                  stopped by you over <MemoryCitationChip id={turn.interrupted.memoryId} />
                </span>
              </StageRow>
            ) : null}

            {audit ? (
              <StageRow
                icon={ClipboardCheck}
                label="Memory Use Audit"
                dim={audit.labels.length === 0}
                onJump={() => jumpToEntry(chatId, audit.entryId)}
                detail={audit.labels.length > 0 ? <AuditDetail chatId={chatId} audit={audit} /> : undefined}
              >
                {audit.status === "failed" ? (
                  "audit failed"
                ) : audit.labels.length === 0 ? (
                  "nothing to audit"
                ) : (
                  <>
                    {[
                      auditCounts.shaped > 0 ? `${auditCounts.shaped} shaped` : null,
                      auditCounts.noEffect > 0 ? `${auditCounts.noEffect} no visible effect` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {auditCounts.violated > 0 ? (
                      <>
                        {auditCounts.shaped > 0 || auditCounts.noEffect > 0 ? " · " : ""}
                        <span className="font-medium text-destructive">{auditCounts.violated} violated</span>
                      </>
                    ) : null}
                  </>
                )}
              </StageRow>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// Figure-only demo record (opt-in via ?demo in the URL). Hand-crafted so a
// screenshot shows a full pre-turn review + an interrupt on t1 and all four
// audit verdicts on t2. Never used in normal operation.
const DEMO_RECORD: MemoryRecord = {
  turns: [
    {
      turn: 1,
      candidates: {
        entryId: "demo-c1",
        decision: "reviewed",
        items: [{ id: "M-19", content: "This project settles all amounts in USD.", scope: "project" }],
      },
      transfers: {
        entryId: "demo-t1",
        decision: "handled",
        items: [{
          sourceId: "M-42",
          sourceLabel: "acme-payments",
          content: "Never trust a client-submitted order total — recompute it server-side before charging via Stripe.",
        }],
      },
      checkup: {
        entryId: "demo-k1",
        decision: "handled",
        items: [
          { kind: "conflict", memoryId: "M-02", otherMemoryId: "M-14", reason: "pnpm vs npm as the package manager" },
          { kind: "conflict", memoryId: "M-05", otherMemoryId: "M-15", reason: "API port 3001 vs 4000" },
          { kind: "conflict", memoryId: "M-07", otherMemoryId: "M-16", reason: "prices in integer cents vs floats" },
        ],
      },
      injected: {
        entryId: "demo-i1",
        items: [
          { id: "M-01", content: "Prefers TypeScript with strict mode.", scope: "personal" },
          { id: "M-02", content: "Uses pnpm as the package manager.", scope: "personal" },
          { id: "M-05", content: "The API server runs on port 3001 in dev.", scope: "project" },
          { id: "M-07", content: "Prices are stored as integer cents.", scope: "project" },
          { id: "M-13", content: "Checkout routes are guarded by auth middleware.", scope: "project" },
        ],
      },
      reported: { counts: new Map([["M-01", 1], ["M-02", 1], ["M-05", 2], ["M-07", 1]]) },
      interrupted: { memoryId: "M-02" },
    },
    {
      turn: 2,
      summary: "Built the Stripe checkout — recomputed the cart total on the server [M-05] with strict typing [M-01], but charged a floating-point total, violating [M-07].",
      injected: {
        entryId: "demo-i2",
        items: [
          { id: "M-01", content: "Prefers TypeScript with strict mode.", scope: "personal" },
          { id: "M-05", content: "The API server runs on port 3001 in dev.", scope: "project" },
          { id: "M-07", content: "Prices are stored as integer cents.", scope: "project" },
          { id: "M-11", content: "Migrations live in src/db and run via pnpm migrate.", scope: "project" },
          { id: "M-13", content: "Checkout routes are guarded by auth middleware.", scope: "project" },
        ],
      },
      reported: { counts: new Map([["M-01", 1], ["M-05", 2], ["M-07", 1]]) },
      audit: {
        entryId: "demo-a2",
        status: "ok",
        labels: [
          { id: "M-05", label: "operational", quote: "const total = recomputeCartTotal(cart)" },
          { id: "M-01", label: "operational" },
          { id: "M-07", label: "violated", quote: "const tax = price * 0.08", note: "Used a floating-point price; M-07 requires integer cents." },
          { id: "M-13", label: "injected_without_effect" },
          { id: "M-11", label: "not_applicable", missing: "no database migration was written this turn" },
        ],
      },
    },
  ],
}

function hasDemoFlag(): boolean {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("demo")
}

export function MemoryRecordRail({ chatId, messages, streamingText = null, isTurnActive = false }: Props) {
  const demo = hasDemoFlag()
  const record = useMemo(
    () => (demo ? DEMO_RECORD : buildMemoryRecord(messages, streamingText)),
    [demo, messages, streamingText],
  )
  const live = !demo && (isTurnActive || streamingText !== null)
  const monitorIds = useMemo(() => memoryRecordMonitorIds(record), [record])
  const recordInteraction = (interaction: "click" | "scroll") => {
    recordUiMonitor("timeline", { sessionId: chatId, ids: monitorIds, interaction })
  }

  if (record.turns.length === 0) {
    return (
      <div
        className="px-3 py-6 text-sm text-muted-foreground"
        onClick={() => recordInteraction("click")}
      >
        No memory activity yet. Once the agent runs a turn with memories in play, each turn
        collects here — what was proposed, injected, reported, and how the audit ruled.
      </div>
    )
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      onClick={() => recordInteraction("click")}
      onScroll={() => recordInteraction("scroll")}
    >
      {record.turns.map((turn, index) => (
        <TurnBlock
          key={turn.turn}
          chatId={chatId}
          turn={turn}
          isLast={index === record.turns.length - 1}
          isLive={index === record.turns.length - 1 && live}
        />
      ))}
    </div>
  )
}
