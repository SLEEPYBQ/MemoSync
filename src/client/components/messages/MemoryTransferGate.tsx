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
  type MemoryBoardActionContext,
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
  boardResolution?: MemoryBoardActionContext
  /** Session-start Board: every resurfaced row must be handled before leaving. */
  requireAllRows?: boolean
  /** Shared when the same active gate is expanded in the Memory Board. */
  settledRows?: ReadonlyMap<string, string>
  onSuggestionSettled?: (sourceId: string, outcome: string) => void
}

const DECISION_LABELS: Record<Exclude<NonNullable<MemoryTransferHydratedMessage["decision"]>, "empty">, string> = {
  handled: "handled",
  skipped: "skipped for now",
  cancelled: "cancelled with the turn",
  expired: "expired (the server restarted mid-review)",
}

const SCOPE_ICONS = { session: MessagesSquare, project: FolderGit2, personal: User } as const

export const MEMORY_TRANSFER_HELP_COPY =
  "These are memories saved in other projects or conversations that could help here. The Encoder removes source-specific details and the Decoder adapts the rule to this project. Bring in saves the result to the Visible Memory Pool. Before Claude starts, the Working Memory review decides whether that saved memory is focused for this turn."

/** Both memory cards wear their scope's color — the same three hues the
 * MemoSync icon fans out. The localized card switches live with the picker. */
const SCOPE_CARD_TINT: Record<MemoryScope, string> = {
  session: "border-session-border bg-session-surface",
  project: "border-project-border bg-project-surface",
  personal: "border-personal-border bg-personal-surface",
}

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g

/** Inline color swatches for hex values in memory text — a palette you can
 * SEE beats one you have to imagine. Tiny enough that no library earns its
 * dependency here. */
function ColorizedText({ text }: { text: string }) {
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
  return (
    <p className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
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
  // Rounded funnel: the polygon is drawn inset and fattened by a same-color
  // stroke with round joins — clip-path corners cannot round, a stroked SVG
  // path can. Encoder narrows rightward (compressing), decoder widens
  // (re-binding).
  const points = expand ? "8,26 48,10 48,86 8,70" : "8,10 48,26 48,70 8,86"
  return (
    <>
      <div className="hidden w-full self-stretch sm:flex sm:flex-col" title={hint}>
        <div aria-hidden className="h-[21px]" />
        <div className="relative flex min-h-[86px] flex-1 flex-col items-center justify-center gap-1 text-violet-600 dark:text-violet-300">
          <svg
            aria-hidden
            className="absolute inset-0 h-full w-full text-violet-500 opacity-10 dark:text-violet-400 dark:opacity-15"
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
          <span className="relative text-[10px] font-medium">{name}</span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 text-[10px] font-medium text-violet-600 sm:hidden dark:text-violet-300" title={hint}>
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
  boardResolution,
  requireAllRows = false,
  settledRows,
  onSuggestionSettled,
}: Props) {
  const renderOptions = useTranscriptRenderOptions()
  const suggestions = message.suggestions
  const [localSettledRows, setLocalSettledRows] = useState<Map<string, string>>(() => new Map())
  const [submitting, setSubmitting] = useState(false)
  const [reopening, setReopening] = useState(false)
  const effectiveSettledRows = settledRows ?? localSettledRows

  if (renderOptions.readonly) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Step {stepNumber} · Transfer Suggestions — {suggestions.length} omitted from this export for privacy.
      </div>
    )
  }

  // A visible search that found nothing settles into one quiet line. A task
  // that completes empty before presentation never publishes a card at all.
  if (message.decision === "empty" || (!message.pending && suggestions.length === 0 && !message.decision)) {
    if (!message.pending && suggestions.length === 0 && message.decision === undefined) return null
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Step {stepNumber} · Transfer Suggestions</span>
        <span className="ml-1">✓ Nothing worth bringing in from your other projects or conversations.</span>
      </div>
    )
  }

  // "empty" already returned above — TS narrows the record lookup below.
  if (message.decision) {
    const mayReopen = canReopen && onReopen && (message.decision === "handled" || message.decision === "skipped")
    return (
      <MemoryReviewStepSummary
        title={`Step ${stepNumber} · Transfer Suggestions`}
        outcome={<>✓ {suggestions.length} {suggestions.length === 1 ? "suggestion" : "suggestions"}, {DECISION_LABELS[message.decision]}.</>}
        consequence="Review again rechecks the current saved state. Previous saved actions remain. Any new changes regenerate Step 3 and Working Memory."
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
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm" data-memory-control-surface={surface}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <ArrowRightLeft className="h-3 w-3" /> Step {stepNumber}
        </span>
        <span className="text-sm font-medium text-foreground">Transfer Suggestions</span>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label="What is a transfer?"
              className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="text-xs leading-5 text-muted-foreground">
            {MEMORY_TRANSFER_HELP_COPY}
          </HoverCardContent>
        </HoverCard>
        {suggestions.length > 0 ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {suggestions.length - pendingCount} of {suggestions.length} handled
          </span>
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
                  boardResolution={boardResolution}
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
              label="Searching for transferable memories"
              status="searching your other projects and conversations…"
            />
          </div>
        ) : null
      ) : (
        <div className="mt-3 flex items-center justify-end">
          {stale ? (
            <p className="text-xs text-muted-foreground">This card belongs to an earlier turn and is no longer active.</p>
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
      )}
    </div>
  )
}

function LegacyWideningReceipt({ suggestion }: { suggestion: MemoryTransferSuggestionSnapshot }) {
  return (
    <div className="flex items-center gap-2 py-2.5 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[11px]">{suggestion.sourceId}</span>
      <span>— Automatic scope-widening flow is retired; no further action is available in this card.</span>
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
    landingRoute: suggestion.landing?.route,
    landingTargetId: suggestion.landing?.targetId,
    landingTargetVersion: suggestion.landing?.targetVersion,
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
  boardResolution,
}: {
  suggestion: MemoryTransferSuggestionSnapshot
  freshAt?: string
  settledText?: string
  onSettled: (text: string) => void
  surface: MemoryControlSurface
  boardResolution?: MemoryBoardActionContext
}) {
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
  const landing = suggestion.landing
  const reinforcing = landing?.route === "reinforces"
  const SourceIcon = SCOPE_ICONS[suggestion.sourceScope] ?? MessagesSquare
  const acceptLabel = reinforcing ? "Reinforce" : "Bring in"

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
          boardResolution,
        },
      )
      await loadAll()
      onSettled(
        reinforcing
          ? `reinforced ${created.id}; this turn's focus is reviewed in Working Memory`
          : `saved as ${created.id} in the ${scope} pool; this turn's focus is reviewed in Working Memory`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "transfer failed")
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
        boardResolution,
      )
      onSettled("passed — won't be suggested again")
    } catch (err) {
      setError(err instanceof Error ? err.message : "decline failed")
    } finally {
      setBusy(null)
    }
  }

  if (settledText) {
    return (
      <div className="flex items-center gap-2 py-2.5 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="font-mono text-[11px]">{suggestion.sourceId}</span>
        <span>— {settledText}</span>
      </div>
    )
  }

  return (
    <div className="py-3">
      <div className="grid grid-cols-1 items-stretch gap-1.5 sm:grid-cols-[1fr_56px_1.15fr_56px_1.05fr]">
        {/* Station 1 — the source, wearing ITS scope's color. Stripped
            values render as chips: compare them with the last card's chips
            and the move is visible. */}
        <RiseIn freshAt={freshAt} delay={0} className="flex min-w-0 flex-col">
          <StageLabel icon={SourceIcon}>
            <span className="truncate">Source · {suggestion.sourceLabel}</span>
            <span
              className={cn(
                "ml-0.5 inline-flex w-fit items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none",
                MEMORY_SCOPE_CHIP_CLASSES[suggestion.sourceScope],
              )}
            >
              {suggestion.sourceId}
            </span>
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
          <StageMachine name="Encoder" hint="Removes source-specific details and extracts the stable idea." />
        </RiseIn>

        {/* Station 3 — the abstract representation: a card of its own kind
            (amber = metadata, never a memory item). */}
        <RiseIn freshAt={freshAt} delay={0.24} className="flex min-w-0 flex-col">
          <StageLabel icon={Lightbulb}>Abstract rule</StageLabel>
          <div className="flex flex-1 flex-col rounded-lg border border-amber-500/35 bg-amber-500/[0.07] p-2.5">
            {suggestion.rule ? (
              <p className="text-sm italic leading-snug text-foreground">
                <ColorizedText text={suggestion.rule} />
              </p>
            ) : (
              <>
                <div className="memory-review-skeleton h-6 rounded-lg" />
                <AnimatedShinyText className="mx-0 mt-1.5 max-w-none text-[11px] italic">
                  encoding the source…
                </AnimatedShinyText>
              </>
            )}
          </div>
        </RiseIn>

        <RiseIn freshAt={freshAt} delay={0.36} className="flex">
          <StageMachine name="Decoder" hint="Adapts the abstract rule to this project's structure and task." expand />
        </RiseIn>

        {/* Station 5 — the localized memory, wearing the LANDING scope's
            color (switches live with the picker below). Bound values chip. */}
        <RiseIn freshAt={freshAt} delay={0.48} className="flex min-w-0 flex-col">
          <StageLabel icon={Target}>In this project</StageLabel>
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
                  localizing for this project…
                </AnimatedShinyText>
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
            <span className="text-[11px] font-medium text-muted-foreground">Lands in</span>
            <ScopeControl value={scope} onValueChange={setScopeChoice} />
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void decline()}>
            {busy === "decline" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Not this one
          </Button>
          {!reinforcing ? (
            <Button variant="secondary" size="xs" disabled={busy !== null || !decoded} onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-3 w-3" />
              {editing ? "Done editing" : "Edit"}
            </Button>
          ) : null}
          <Button
            variant="juicy"
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
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function LandingNote({ landing }: { landing: MemoryTransferSuggestionSnapshot["landing"] | undefined }) {
  if (!landing) return null
  if (landing.route === "reinforces") {
    return (
      <div className="mt-2 flex items-start gap-1.5 border-l-2 border-emerald-500/50 py-0.5 pl-2 text-[11px] leading-snug text-muted-foreground">
        <GitMerge className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span>
          This project already knows this
          {landing.targetContent ? <> — “{landing.targetContent}”</> : null}. Accepting reinforces that memory
          instead of adding a duplicate.
        </span>
      </div>
    )
  }
  if (landing.route === "conflicts") {
    return (
      <div className="mt-2 flex items-start gap-1.5 border-l-2 border-amber-500/50 py-0.5 pl-2 text-[11px] leading-snug text-muted-foreground">
        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          May conflict with an existing memory
          {landing.targetContent ? <> — “{landing.targetContent}”</> : null}. Both are kept and flagged for you.
        </span>
      </div>
    )
  }
  return null
}
