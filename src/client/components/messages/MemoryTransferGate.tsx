import { en } from "../../i18n/resources"
import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
import { MemoryBadge } from "../memory/MemoryBadge"
// The Transfer card (Transfer design 2026-08-08; pipeline form follows the
// user's own five-station figure, 2026-08-09). Memories from OUTSIDE this
// conversation's context — other projects or other chats of this project —
// suggested for bringing in.
//
// Each suggestion is the figure, miniaturized:
//   source card (its scope's color) → Encoder machine → abstract-rule card
//   (amber, with derived-from / applicability tags) → Decoder machine →
//   localized card (the landing scope's color, switching live with the
//   picker).
// The concrete VALUES the encoder stripped and the decoder bound render as
// monospace chips inside the texts — compare the chips across the two cards
// and the transformation is visible without reading the sentence twice.
// Rows stream in as current-task Decode/landing completes; a complete row
// renders complete (no staged replay — it read as slowness).
import { useState } from "react"
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowRightLeft,
  Check,
  FolderGit2,
  GitMerge,
  Info,
  Lightbulb,
  Loader2,
  MessagesSquare,
  Pencil,
  Sparkles,
  Target,
  TriangleAlert,
  User,
  X,
} from "lucide-react"
import type { HydratedTranscriptMessage, MemoryTransferSuggestionSnapshot } from "../../../shared/types"
import {
  memoriesApi,
  type MemoryControlSurface,
} from "../../lib/memoriesApi"
import { MEMORY_SCOPE_CHIP_CLASSES } from "../../lib/memoryCitations"
import { cn } from "../../lib/utils"
import { useMemoryStore } from "../../stores/memoryStore"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { Button } from "../ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { Textarea } from "../ui/textarea"
import { RiseIn } from "../ui/motion-primitives"
import { ScopeControl } from "../memory-chat/ScopeControl"
import { MemoryReviewSkeleton } from "./MemoryReviewSkeleton"
import { MemoryReviewStepSummary } from "./MemoryReviewStepSummary"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"

type MemoryTransferHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_transfer" }>
type MemoryScope = "personal" | "project" | "session"

interface Props {
  message: MemoryTransferHydratedMessage
  stale?: boolean
  onRespond: (transferId: string, decision: "handled" | "skipped") => Promise<void> | void
  canReopen?: boolean
  onReopen?: () => Promise<void> | void
  /** Position in this turn's flow (the checkup renumbers itself after us). */
  stepNumber?: number
  surface?: MemoryControlSurface
  /** Session-start Board: every resurfaced row must be handled before leaving. */
  requireAllRows?: boolean
  /** Shared when the same active gate is expanded in the Memory Board. */
  settledRows?: ReadonlyMap<string, string>
  onSuggestionSettled?: (sourceId: string, outcome: string) => void
}

const DECISION_LABELS: Record<Exclude<NonNullable<MemoryTransferHydratedMessage["decision"]>, "empty">, string> = {
  get handled() { return t("memory:handled") },
  get skipped() { return t("memory:skippedForNow") },
  get cancelled() { return t("memory:cancelledWithTheTurn") },
  get expired() { return t("memory:expiredTheServerRestartedMidReview") },
}

const SCOPE_ICONS = { session: MessagesSquare, project: FolderGit2, personal: User } as const

export const MEMORY_TRANSFER_HELP_COPY =
  en.memory.theseAreMemoriesSavedInOtherProjectsOrConversationsThat

/** Source and landing surfaces stay neutral; scope hues belong to chips. */
const SCOPE_CARD_TINT: Record<MemoryScope, string> = {
  session: "border-border/70 bg-background/60 dark:bg-muted/40",
  project: "border-border/70 bg-background/60 dark:bg-muted/40",
  personal: "border-border/70 bg-background/60 dark:bg-muted/40",
}

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g

/** Inline color swatches for hex values in memory text — a palette you can
 * SEE beats one you have to imagine. Tiny enough that no library earns its
 * dependency here. */
function ColorizedText({ text }: { text: string }) {
  useI18n()
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(HEX_COLOR_RE)) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    parts.push(
      <span key={`${index}-${match[0]}`} className="inline-flex items-baseline gap-1 whitespace-nowrap">
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 self-center rounded-[4px] border border-border"
          style={{ backgroundColor: match[0] }}
        />
        {match[0]}
      </span>,
    )
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** Every verbatim occurrence of `marks` inside `text`, merged when they
 * overlap. Marks are short concrete VALUES (enforced server-side) and render
 * as monospace chips — the user's figure's vocabulary. */
function segmentByMarks(text: string, marks: string[] | undefined): Array<{ text: string; marked: boolean }> {
  if (!marks?.length) return [{ text, marked: false }]
  const intervals: Array<[number, number]> = []
  for (const mark of marks) {
    let from = 0
    while (true) {
      const index = text.indexOf(mark, from)
      if (index === -1) break
      intervals.push([index, index + mark.length])
      from = index + mark.length
    }
  }
  intervals.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  const segments: Array<{ text: string; marked: boolean }> = []
  let position = 0
  for (const [start, end] of merged) {
    if (start > position) segments.push({ text: text.slice(position, start), marked: false })
    segments.push({ text: text.slice(start, end), marked: true })
    position = end
  }
  if (position < text.length) segments.push({ text: text.slice(position), marked: false })
  return segments
}

function ValueChippedText({ text, marks }: { text: string; marks?: string[] }) {
  useI18n()
  const segments = segmentByMarks(text, marks)
  return (
    <>
      {segments.map((segment, index) =>
        segment.marked ? (
          <span
            key={index}
            className="mx-0.5 inline-flex items-baseline rounded border border-border/70 bg-background/70 px-1 font-mono text-[0.85em] leading-snug"
          >
            <ColorizedText text={segment.text} />
          </span>
        ) : (
          <ColorizedText key={index} text={segment.text} />
        ),
      )}
    </>
  )
}

function StageLabel({ icon: IconCmp, children }: { icon: typeof Lightbulb; children: React.ReactNode }) {
  useI18n()
  return (
    <p className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <IconCmp className="h-3 w-3" /> {children}
    </p>
  )
}

/**
 * Encoder / Decoder as visible machines (the user's figure): violet funnels —
 * the encoder narrows rightward (compressing away the source-local), the
 * decoder widens rightward (re-binding into the target). On narrow screens
 * they become small inline badges between the stacked cards.
 */
function StageMachine({ name, hint, expand }: { name: string; hint: string; expand?: boolean }) {
  useI18n()
  // Rounded funnel: the polygon is drawn inset and fattened by a same-color
  // stroke with round joins — clip-path corners cannot round, a stroked SVG
  // path can. Encoder narrows rightward (compressing), decoder widens
  // (re-binding).
  const points = expand ? "8,26 48,10 48,86 8,70" : "8,10 48,26 48,70 8,86"
  return (
    <>
      <div className="hidden w-full self-stretch @2xl:flex @2xl:flex-col" title={hint}>
        <div aria-hidden className="h-[21px]" />
        <div className="relative flex min-h-[86px] flex-1 flex-col items-center justify-center gap-1 text-info-foreground dark:text-info-foreground">
          <svg
            aria-hidden
            className="absolute inset-0 h-full w-full text-info-foreground opacity-10 dark:text-info-foreground dark:opacity-15"
            viewBox="0 0 56 96"
            preserveAspectRatio="none"
          >
            <polygon
              points={points}
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="14"
              strokeLinejoin="round"
            />
          </svg>
          <Sparkles className="relative h-3.5 w-3.5" />
          <span className="relative text-[11px] font-medium">{name}</span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 text-[11px] font-medium text-info-foreground @2xl:hidden dark:text-info-foreground" title={hint}>
        <Sparkles className="h-3 w-3" /> {name} ↓
      </div>
    </>
  )
}

export function MemoryTransferGate({
  message,
  stale,
  onRespond,
  canReopen = false,
  onReopen,
  stepNumber = 2,
  surface = "chat_gate",
  requireAllRows = false,
  settledRows,
  onSuggestionSettled,
}: Props) {
  useI18n()
  const renderOptions = useTranscriptRenderOptions()
  const suggestions = message.suggestions
  const [localSettledRows, setLocalSettledRows] = useState<Map<string, string>>(() => new Map())
  const [submitting, setSubmitting] = useState(false)
  const [reopening, setReopening] = useState(false)
  const effectiveSettledRows = settledRows ?? localSettledRows

  if (renderOptions.readonly) {
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        {t("memory:stepNumber", { step: stepNumber })} {t("memory:transferSuggestions2")}{suggestions.length} {t("memory:omittedFromThisExportForPrivacy")}</div>
    )
  }

  // A visible search that found nothing settles into one quiet line. A task
  // that completes empty before presentation never publishes a card at all.
  if (message.decision === "empty" || (!message.pending && suggestions.length === 0 && !message.decision)) {
    if (!message.pending && suggestions.length === 0 && message.decision === undefined) return null
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{t("memory:stepNumber", { step: stepNumber })} {t("memory:transferSuggestions3")}</span>
        <span className="ml-1">{t("memory:nothingWorthBringingInFromYourOtherProjectsOrConversations")}</span>
      </div>
    )
  }

  // "empty" already returned above — TS narrows the record lookup below.
  if (message.decision) {
    const mayReopen = canReopen && onReopen && (message.decision === "handled" || message.decision === "skipped")
    return (
      <MemoryReviewStepSummary
        title={t("memory:stepValue0TransferSuggestions", { v0: stepNumber })}
        outcome={<>✓ {t("memory:suggestionReceipt", { count: suggestions.length, decision: DECISION_LABELS[message.decision] })}</>}
        consequence={t("memory:reviewAgainTransfer")}
        reopening={reopening}
        onReopen={mayReopen ? async () => {
          setReopening(true)
          try {
            setLocalSettledRows(new Map())
            await onReopen()
          } finally {
            setReopening(false)
          }
        } : undefined}
      />
    )
  }

  // Historical widening rows predate the retired feature. They are receipts,
  // not pending choices, so an old open gate can still Continue safely.
  const pendingCount = suggestions.filter((s) => !s.widening && !effectiveSettledRows.has(s.sourceId)).length

  async function settle(decision: "handled" | "skipped") {
    setSubmitting(true)
    try {
      await onRespond(message.transferId, decision)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={MEMORY_CARD} data-memory-control-surface={surface}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <ArrowRightLeft className="h-4 w-4" /> {t("memory:stepNumber", { step: stepNumber })}
        </span>
        <span className="text-sm font-semibold text-foreground">{t("memory:transferSuggestions")}</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label={t("memory:whatIsATransfer")}
              className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="text-xs leading-5 text-muted-foreground">
            {t("memory:theseAreMemoriesSavedInOtherProjectsOrConversationsThat")}
          </HoverCardContent>
        </HoverCard>
        {suggestions.length > 0 ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {t("memory:handledProgress", { handled: suggestions.length - pendingCount, total: suggestions.length })}</span>
        ) : null}
      </div>

      {suggestions.length > 0 ? (
        <div className="mt-1 divide-y divide-border/60">
          {suggestions.map((suggestion) => (
            <RiseIn key={suggestion.sourceId} freshAt={message.timestamp}>
              {suggestion.widening ? (
                <LegacyWideningReceipt suggestion={suggestion} />
              ) : (
                <TransferSuggestionRow
                  suggestion={suggestion}
                  freshAt={message.timestamp}
                  surface={surface}
                  settledText={effectiveSettledRows.get(suggestion.sourceId)}
                  onSettled={(text) => {
                    if (onSuggestionSettled) {
                      onSuggestionSettled(suggestion.sourceId, text)
                      return
                    }
                    setLocalSettledRows((current) => new Map(current).set(suggestion.sourceId, text))
                  }}
                />
              )}
            </RiseIn>
          ))}
        </div>
      ) : null}

      {message.pending ? (
        suggestions.length === 0 ? (
          <div className="mt-3">
            <MemoryReviewSkeleton
              label={t("memory:searchingForTransferableMemories")}
              status={t("memory:searchingOtherProjects")}
            />
          </div>
        ) : null
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-end">
          {stale ? (
            <p className="text-xs text-muted-foreground">{t("memory:thisCardBelongsToAnEarlierTurnAndIsNo")}</p>
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
      )}
    </div>
  )
}

function LegacyWideningReceipt({ suggestion }: { suggestion: MemoryTransferSuggestionSnapshot }) {
  useI18n()
  return (
    <div className="flex items-center gap-2 py-2.5 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[11px]">{suggestion.sourceId}</span>
      <span>{t("memory:automaticScopeWideningFlowIsRetiredNoFurtherActionIs")}</span>
    </div>
  )
}

/** Keep the transcript-snapshot CAS fields explicit and testable. The same
 * payload protects both a live chat gate and its later Board resurfacing. */
export function buildAutomaticTransferCommitBody(input: {
  suggestion: MemoryTransferSuggestionSnapshot
  scope: MemoryScope
  projectId?: string
  chatId?: string
  content: string
}): Parameters<typeof memoriesApi.transfer>[1] {
  const { suggestion, scope, projectId, chatId } = input
  const content = input.content.trim()
  const landing = scope === (suggestion.suggestedScope ?? "project") ? suggestion.landing : undefined
  return {
    sourceVersion: suggestion.sourceVersion,
    targetScope: scope,
    targetProjectId: scope === "project" ? projectId : undefined,
    targetSessionId: scope === "session" ? chatId : undefined,
    chatId,
    content,
    detail: suggestion.detail,
    abstractionLevel: suggestion.abstractionLevel ?? "contextual",
    verdict: "rewrite",
    edited: content !== suggestion.content,
    landingRoute: landing?.route ?? "new",
    landingTargetId: landing?.targetId,
    landingTargetVersion: landing?.targetVersion,
    rule: suggestion.rule,
    applicability: suggestion.applicability,
  }
}

function TransferSuggestionRow({
  suggestion,
  freshAt,
  settledText,
  onSettled,
  surface,
}: {
  suggestion: MemoryTransferSuggestionSnapshot
  freshAt?: string
  settledText?: string
  onSettled: (text: string) => void
  surface: MemoryControlSurface
}) {
  useI18n()
  const { chatId, projectId } = useTranscriptChatContext()
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [scopeChoice, setScopeChoice] = useState<MemoryScope | null>(null)
  const [contentDraft, setContentDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The decode half streams in AFTER first render on live rows: the picker
  // and the text adopt it when it lands, unless the user already intervened.
  const scope: MemoryScope = scopeChoice ?? suggestion.suggestedScope ?? "project"
  const content = contentDraft ?? suggestion.content ?? ""
  const decoded = Boolean(suggestion.content !== undefined && suggestion.landing)
  const landing = scope === (suggestion.suggestedScope ?? "project") ? suggestion.landing : undefined
  const reinforcing = landing?.route === "reinforces"
  const SourceIcon = SCOPE_ICONS[suggestion.sourceScope] ?? MessagesSquare
  const acceptLabel = reinforcing ? t("memory:reinforce") : t("memory:bringIn")

  async function accept() {
    if (!decoded) return
    setBusy("accept")
    setError(null)
    try {
      const created = await memoriesApi.transfer(
        suggestion.sourceId,
        {
          ...buildAutomaticTransferCommitBody({ suggestion, scope, projectId, chatId, content }),
          surface,
        },
      )
      await loadAll()
      onSettled(
        reinforcing
          ? t("memory:reinforcedValue0ThisTurnSFocusIsReviewedInWorking", { v0: created.id })
          : t("memory:savedAsValue0InTheValue1PoolThisTurnS", { v0: created.id, v1: scope }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:transferFailed"))
    } finally {
      setBusy(null)
    }
  }

  async function decline() {
    setBusy("decline")
    setError(null)
    try {
      await memoriesApi.transferDecline(
        suggestion.sourceId,
        projectId ?? chatId ?? "",
        surface,
      )
      onSettled(t("memory:passedWonTBeSuggestedAgain"))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:declineFailed"))
    } finally {
      setBusy(null)
    }
  }

  if (settledText) {
    return (
      <div className="flex items-center gap-2 py-2.5 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5 shrink-0 text-success-foreground dark:text-success-foreground" />
        <span className="font-mono text-[11px]">{suggestion.sourceId}</span>
        <span>— {settledText}</span>
      </div>
    )
  }

  return (
    <div className="py-3">
      <div className="grid grid-cols-1 items-stretch gap-1.5 @2xl:grid-cols-[1fr_56px_1.15fr_56px_1.05fr]">
        {/* Station 1 — the source, wearing ITS scope's color. Stripped
            values render as chips: compare them with the last card's chips
            and the move is visible. */}
        <RiseIn freshAt={freshAt} delay={0} className="flex min-w-0 flex-col">
          <StageLabel icon={SourceIcon}>
            <span className="truncate">{t("memory:source")}{suggestion.sourceLabel}</span>
            <MemoryBadge
              className={cn(
                "ml-0.5 inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-4",
                MEMORY_SCOPE_CHIP_CLASSES[suggestion.sourceScope],
              )}
            >
              {suggestion.sourceId}
            </MemoryBadge>
          </StageLabel>
          <div className={cn("flex flex-1 flex-col rounded-lg border p-2.5", SCOPE_CARD_TINT[suggestion.sourceScope])}>
            <p className="text-sm leading-snug text-foreground">
              <ValueChippedText text={suggestion.sourceContent} marks={suggestion.stripped} />
            </p>
          </div>
        </RiseIn>

        {/* flex: the machine column must track the ROW height (self-stretch
            inside), or the funnel centers on its own min-height and drifts
            upward next to a tall source card. */}
        <RiseIn freshAt={freshAt} delay={0.12} className="flex">
          <StageMachine name={t("memory:encoder")} hint={t("memory:removesSourceSpecificDetailsAndExtractsTheStableIdea")} />
        </RiseIn>

        {/* Station 3 — the abstract representation: a card of its own kind
            (amber = metadata, never a memory item). */}
        <RiseIn freshAt={freshAt} delay={0.24} className="flex min-w-0 flex-col">
          <StageLabel icon={Lightbulb}>{t("memory:abstractRule")}</StageLabel>
          <div className="flex flex-1 flex-col rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 p-2.5">
            {suggestion.rule ? (
              <p className="text-sm italic leading-snug text-foreground">
                <ColorizedText text={suggestion.rule} />
              </p>
            ) : (
              <>
                <div className="memory-review-skeleton h-6 rounded-lg" />
                <AnimatedShinyText className="mx-0 mt-1.5 max-w-none text-[11px] italic">
                  {t("memory:encodingTheSource")}</AnimatedShinyText>
              </>
            )}
          </div>
        </RiseIn>

        <RiseIn freshAt={freshAt} delay={0.36} className="flex">
          <StageMachine name={t("memory:decoder")} hint={t("memory:adaptsTheAbstractRuleToThisProjectSStructureAnd")} expand />
        </RiseIn>

        {/* Station 5 — the localized memory, wearing the LANDING scope's
            color (switches live with the picker below). Bound values chip. */}
        <RiseIn freshAt={freshAt} delay={0.48} className="flex min-w-0 flex-col">
          <StageLabel icon={Target}>{t("memory:inThisProject")}</StageLabel>
          <div
            className={cn(
              "flex flex-1 flex-col rounded-lg border p-2.5",
              decoded ? SCOPE_CARD_TINT[scope] : "border-border/70",
            )}
          >
            {!decoded ? (
              <>
                <div className="memory-review-skeleton h-6 rounded-lg" />
                <AnimatedShinyText className="mx-0 mt-1.5 max-w-none text-[11px] italic">
                  {t("memory:localizingForThisProject")}</AnimatedShinyText>
              </>
            ) : editing ? (
              <Textarea
                value={content}
                onChange={(e) => setContentDraft(e.target.value)}
                rows={3}
                className="bg-card/70 text-sm"
              />
            ) : (
              <p className="text-sm leading-snug text-foreground">
                <ValueChippedText text={content} marks={content === suggestion.content ? suggestion.bound : undefined} />
              </p>
            )}
          </div>
        </RiseIn>
      </div>

      <LandingNote landing={landing} />

      {/* One footer row: the landing picker left, the actions right. The
          scope's consequence lives in each segment's title. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {reinforcing || !decoded ? null : (
          <>
            <span className="text-[11px] font-medium text-muted-foreground">{t("memory:landsIn")}</span>
            <ScopeControl value={scope} onValueChange={setScopeChoice} />
          </>
        )}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void decline()}>
            {busy === "decline" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            {t("memory:notThisOne")}</Button>
          {!reinforcing ? (
            <Button variant="secondary" size="xs" disabled={busy !== null || !decoded} onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-3 w-3" />
              {editing ? t("memory:doneEditing") : t("common:edit")}
            </Button>
          ) : null}
          <Button
            variant="default"
            size="xs"
            disabled={busy !== null || !decoded || (!reinforcing && !content.trim())}
            onClick={() => void accept()}
          >
            {busy === "accept" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ArrowDownToLine className="h-3 w-3" />
            )}
            {acceptLabel}
          </Button>
        </div>
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{translateUiText(error)}</p> : null}
    </div>
  )
}

function LandingNote({ landing }: { landing: MemoryTransferSuggestionSnapshot["landing"] | undefined }) {
  useI18n()
  if (!landing) return null
  if (landing.route === "reinforces") {
    return (
      <div className="mt-2 flex items-start gap-1.5 py-0.5 text-sm leading-snug text-muted-foreground">
        <GitMerge className="mt-0.5 h-3 w-3 shrink-0 text-success-foreground dark:text-success-foreground" />
        <span>
          {t("memory:thisProjectAlreadyKnowsThis")}{landing.targetContent ? <> — “{landing.targetContent}”</> : null}{t("memory:acceptingReinforcesThatMemoryInsteadOfAddingADuplicate")}</span>
      </div>
    )
  }
  if (landing.route === "conflicts") {
    return (
      <div className="mt-2 flex items-start gap-2 rounded-lg border border-cand-border bg-cand-surface p-3 text-sm leading-snug text-muted-foreground">
        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-cand-fg dark:text-cand-fg" />
        <span>
          {t("memory:mayConflictWithAnExistingMemory")}{landing.targetContent ? <> — “{landing.targetContent}”</> : null}{t("memory:bothAreKeptAndFlaggedForYou")}</span>
      </div>
    )
  }
  return null
}
