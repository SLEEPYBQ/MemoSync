import { memoryScopeLabel } from "../../lib/memoryCitations"
import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
import { MemoryBadge } from "../memory/MemoryBadge"
// Review cards for capture-surfaced memory candidates (SPEC §4.1, §4.10).
// Rendered in-transcript, one card per candidate the forced capture hook
// proposed after a turn. Accept / Edit / Dismiss talk to the memory HTTP API
// directly and reconcile against the shared memory store.
import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Check, Inbox, Loader2, Pencil, RefreshCw, ShieldCheck, Undo2, X, Zap } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import {
  memoriesApi,
  type CreateMemoryBody,
  type MemoryControlSurface,
  type MemoryItem,
  type MemoryScope,
} from "../../lib/memoriesApi"
import { isMemoryScope } from "../../lib/memoryCitations"
import { useMemoryStore } from "../../stores/memoryStore"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScopeControl } from "../memory-chat/ScopeControl"
import { MemoryLegendButton } from "../memory/MemoryLegend"
import { RiseIn, StampIn } from "../ui/motion-primitives"
import { ExpandableRow, useEnsureMemoriesLoaded } from "./shared"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"

type MemoryCandidatesHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_candidates" }>

interface Props {
  message: MemoryCandidatesHydratedMessage
}

export function buildCandidateDraftPatch(content: string, detail: string) {
  return { content: content.trim(), detail: detail.trim() }
}

export function buildCandidateActivationScopePatch(input: {
  scope: MemoryScope
  contextProjectId?: string
  contextChatId?: string
  candidateProjectId?: string
  candidateSessionId?: string
}):
  | { patch: Partial<CreateMemoryBody> & { status: "active"; scope: MemoryScope } }
  | { error: string } {
  const patch: Partial<CreateMemoryBody> & { status: "active"; scope: MemoryScope } = {
    status: "active",
    scope: input.scope,
  }
  if (input.scope === "project") {
    const projectId = input.contextProjectId ?? input.candidateProjectId
    if (!projectId) return { error: t("memory:chooseAProjectBeforeAcceptingThisMemory") }
    patch.projectId = projectId
  }
  if (input.scope === "session") {
    const sessionId = input.contextChatId ?? input.candidateSessionId
    if (!sessionId) return { error: t("memory:chooseAConversationBeforeAcceptingThisMemory") }
    patch.sessionId = sessionId
  }
  return { patch }
}

export async function runCandidateMutation<T>(
  mutation: () => Promise<T>,
  onChanged?: () => Promise<void> | void,
): Promise<T> {
  const result = await mutation()
  await onChanged?.()
  return result
}

export function MemoryCandidatesMessage({ message }: Props) {
  useI18n()
  const renderOptions = useTranscriptRenderOptions()
  if (message.candidates.length === 0) return null
  if (renderOptions.readonly) {
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        {t("memory:candidateCount", { count: message.candidates.length })} {t("memory:omittedFromThisExportForPrivacy")}</div>
    )
  }
  return <LiveMemoryCandidatesMessage message={message} />
}

function LiveMemoryCandidatesMessage({ message }: Props) {
  useI18n()
  useEnsureMemoriesLoaded()
  const items = useMemoryStore((s) => s.items)
  const status = useMemoryStore((s) => s.status)
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [refreshAttempted, setRefreshAttempted] = useState(false)
  const [locallyDismissedIds, setLocallyDismissedIds] = useState<Set<string>>(() => new Set())
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const hasMissingCandidate = message.candidates.some((candidate) => !itemsById.has(candidate.id))

  // The store may already be hydrated before a post-turn capture finishes.
  // Refresh once so an id-only transcript row can resolve the newly created
  // candidate. A still-missing id after that refresh is a dismissed tombstone.
  useEffect(() => {
    if (status !== "ready" || !hasMissingCandidate || refreshAttempted) return
    setRefreshAttempted(true)
    void loadAll()
  }, [hasMissingCandidate, loadAll, refreshAttempted, status])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <MemoryLegendButton sections={["scope"]} label={t("memory:whatDoTheColorsMean")} />
      </div>
      {message.candidates.map((candidate, index) => {
        const liveCandidate = itemsById.get(candidate.id)
        if (liveCandidate) {
          return (
            // Birth move: each capture rises into the stream, siblings stagger.
            <RiseIn key={candidate.id} freshAt={message.timestamp} delay={index * 0.12}>
              <MemoryCandidateCard
                candidate={liveCandidate}
                autoApplied={candidate.auto === true}
                resurfaced={candidate.resurfaced === true}
                freshAt={message.timestamp}
                onDismissed={() => setLocallyDismissedIds((current) => new Set(current).add(candidate.id))}
              />
            </RiseIn>
          )
        }
        if (locallyDismissedIds.has(candidate.id)) {
          return <ResolvedCandidate key={candidate.id} resolved="dismissed" id={candidate.id} />
        }
        if (status === "error") {
          return <UnavailableCandidate key={candidate.id} />
        }
        if (status !== "ready" || !refreshAttempted) {
          return <LoadingCandidate key={candidate.id} />
        }
        return <ResolvedCandidate key={candidate.id} resolved="dismissed" id={candidate.id} />
      })}
    </div>
  )
}

type ResolvedState = "pending" | "accepted" | "dismissed"

function LoadingCandidate() {
  useI18n()
  return (
    <div className="flex items-center gap-2 memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("memory:loadingMemoryCandidate")}</div>
  )
}

function UnavailableCandidate() {
  useI18n()
  return (
    <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
      {t("memory:memoryCandidateUnavailableRefreshToTryAgain")}</div>
  )
}

function ResolvedCandidate({ resolved, id }: { resolved: Exclude<ResolvedState, "pending">; id: string }) {
  useI18n()
  return (
    <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
      {resolved === "accepted" ? t("memory:savedAsValue0ThisTurnSFocusIsDecidedIn", { v0: id }) : t("memory:dismissed")}
    </div>
  )
}

/**
 * The post-decision card is still a monitoring surface: what exactly did I
 * just admit? Expand to re-read the accepted text, and "Undo accept" is the
 * one-click inverse (back to the review lane; a revision's archived target
 * comes back with it). The inverse refuses if the item was edited after
 * acceptance — that rollback belongs to the Board's history.
 */
function AcceptedCandidateCard({
  candidate,
  surface,
  onChanged,
}: {
  candidate: MemoryItem
  surface: MemoryControlSurface
  onChanged?: () => Promise<void> | void
}) {
  useI18n()
  const loadAll = useMemoryStore((s) => s.loadAll)
  const { chatId } = useTranscriptChatContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUndo() {
    setBusy(true)
    setError(null)
    try {
      await runCandidateMutation(async () => {
        await memoriesApi.revertAutoAccept(candidate.id, { sessionId: chatId, surface })
        // Back to candidate: the canonical store makes every mounted review
        // and Board destination flip in the same render.
        await loadAll()
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToUndo"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={MEMORY_CARD}>
      <ExpandableRow
        expandedContent={
          <div className="mt-2 flex flex-col gap-2">
            <p className="whitespace-pre-wrap text-sm text-foreground">{candidate.content}</p>
            {candidate.detail ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{candidate.detail}</p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {memoryScopeLabel(candidate.scope)}
                {candidate.status === "archived" ? t("memory:sinceArchived") : ""}
              </span>
              {candidate.status === "active" ? (
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => void handleUndo()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                  {t("memory:undoAccept")}</Button>
              ) : null}
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        }
      >
        <span className="inline-flex items-start gap-2 text-left text-sm text-muted-foreground">
          <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success-foreground" />
          {t("memory:savedAs")}{candidate.id} {t("memory:thisTurnSFocusIsDecidedInWorkingMemory")}</span>
      </ExpandableRow>
    </div>
  )
}

function AutoAppliedCard({
  candidate,
  revisionOf,
  freshAt,
  surface,
  onChanged,
}: {
  candidate: MemoryItem
  revisionOf?: MemoryItem["revisionOf"]
  freshAt?: string | number
  surface: MemoryControlSurface
  onChanged?: () => Promise<void> | void
}) {
  useI18n()
  const loadAll = useMemoryStore((s) => s.loadAll)
  const { chatId } = useTranscriptChatContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevert() {
    setBusy(true)
    setError(null)
    try {
      await runCandidateMutation(async () => {
        await memoriesApi.revertAutoAccept(candidate.id, { sessionId: chatId, surface })
        // The item is a candidate again (and a reverted revision's target is
        // active again) — refetch so this card flips back to a pending review.
        await loadAll()
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToRevert"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={MEMORY_CARD}>
      <div className="flex flex-wrap items-center gap-2">
        {/* Delegation move: the stamp pops into place — quick and confident. */}
        <StampIn freshAt={freshAt}>
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-success-foreground">
            <Zap aria-hidden className="h-4 w-4 text-muted-foreground" />
            {t("memory:autoApplied")}</span>
        </StampIn>
        {revisionOf ? (
          <MemoryBadge className="inline-flex items-center gap-1 rounded-md border border-info/30 bg-info/10 px-1.5 py-0.5 text-[11px] font-medium text-info-foreground dark:text-info-foreground">
            <RefreshCw className="h-3 w-3" />
            {t("memory:revisionReplaced")}{revisionOf.id}
          </MemoryBadge>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{candidate.content}</p>
      <div className="mt-2 flex items-center justify-end gap-2">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void handleRevert()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} {t("memory:revert")}</Button>
      </div>
    </div>
  )
}

export function MemoryCandidateCard({
  candidate,
  autoApplied = false,
  resurfaced = false,
  freshAt,
  onDismissed,
  onChanged,
  allowRestore = false,
  surface = "chat_gate",
}: {
  candidate: MemoryItem
  /** Delegating/Auto mode applied this proposal without asking. */
  autoApplied?: boolean
  /** This card re-surfaces an EARLIER, still-unreviewed proposal. */
  resurfaced?: boolean
  /** The transcript entry's timestamp — gates the one-shot entrance moves. */
  freshAt?: string | number
  onDismissed?: () => void
  onChanged?: () => Promise<void> | void
  /** Only an explicitly reopened Candidate gate exposes this inverse. */
  allowRestore?: boolean
  surface?: MemoryControlSurface
}) {
  useI18n()
  const storeStatus = candidate.status
  const upsertLocal = useMemoryStore((s) => s.upsertLocal)
  const removeLocal = useMemoryStore((s) => s.removeLocal)
  const loadAll = useMemoryStore((s) => s.loadAll)
  // A REVISION proposal (self-evolution M3/M4): accepting it also archives the
  // memory it replaces — the card must say so before the user commits.
  const revisionOf = candidate.revisionOf

  const { chatId, projectId } = useTranscriptChatContext()
  const [scope, setScope] = useState<MemoryScope>(isMemoryScope(candidate.scope) ? candidate.scope : "session")
  const [editing, setEditing] = useState(false)
  const [draftContent, setDraftContent] = useState(candidate.content)
  const [draftDetail, setDraftDetail] = useState(candidate.detail ?? "")
  // The captured snapshot is immutable; track the latest saved text so the card
  // reflects an edit after Save instead of snapping back to the original (MSG-3).
  const [displayContent, setDisplayContent] = useState(candidate.content)
  const [displayDetail, setDisplayDetail] = useState(candidate.detail)
  const [busy, setBusy] = useState<"accept" | "dismiss" | "restore" | "save" | "sanitize" | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A pending LLM redaction proposal: content shown in the edit box, detail
  // carried along, redactions listed so the user sees what was replaced.
  const [sanitized, setSanitized] = useState<{
    redactions: Array<{ placeholder: string; kind: string }>
  } | null>(null)

  // Reconcile against the live store: if this item was already resolved
  // elsewhere (Board, or a reload of a prior session), prefer that truth.
  // 'archived' means it WAS accepted and later archived (a candidate can only
  // reach archived through active) — rendering that as "dismissed" rewrote
  // the review's history.
  const resolved: ResolvedState =
    storeStatus === "active" || storeStatus === "archived"
      ? "accepted"
      : storeStatus === "discarded"
        ? "dismissed"
        : "pending"

  useEffect(() => {
    if (editing) return
    setDisplayContent(candidate.content)
    setDisplayDetail(candidate.detail)
    setDraftContent(candidate.content)
    setDraftDetail(candidate.detail ?? "")
  }, [candidate.content, candidate.detail, editing])

  async function handleAccept() {
    setBusy("accept")
    setError(null)
    try {
      const trimmed = draftContent.trim()
      // Editing (incl. a sanitize proposal) with an empty box must NOT silently
      // fall back to the original text — that would store the pre-edit content,
      // and for a sensitive candidate the still-unredacted original (MSG-12).
      if ((editing || sanitized) && !trimmed) {
        setError(t("memory:memoryContentCanTBeEmpty"))
        return
      }
      // Changing the scope to project/session requires the matching id, or the
      // server 400s and the candidate can never be accepted into that scope
      // (MSG-1). Bind to the chat this candidate was captured in / its project.
      const activation = buildCandidateActivationScopePatch({
        scope,
        contextProjectId: projectId,
        contextChatId: chatId,
        candidateProjectId: candidate.projectId,
        candidateSessionId: candidate.sessionId,
      })
      if ("error" in activation) {
        setError(activation.error)
        return
      }
      const patch = activation.patch
      // Apply both edited fields in the same act. An empty detail is explicit:
      // it erases the old value instead of preserving a sensitive original.
      if ((editing || sanitized) && trimmed) {
        Object.assign(patch, buildCandidateDraftPatch(trimmed, draftDetail))
      }
      const updated = await runCandidateMutation(async () => {
        const result = await memoriesApi.update(candidate.id, patch, { surface })
        upsertLocal(result)
        // Accepting a revision archived its target server-side — refetch so
        // the replaced memory leaves every active list in the same beat.
        if (revisionOf) await loadAll()
        return result
      }, onChanged)
      setDisplayContent(updated.content)
      setDisplayDetail(updated.detail)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToAccept"))
    } finally {
      setBusy(null)
    }
  }

  // DG1 "confirm" branch: ask the LLM for a redacted version and stage it in
  // the edit box for review — the user still decides whether it becomes active.
  async function handleSanitize() {
    setBusy("sanitize")
    setError(null)
    try {
      const proposal = await memoriesApi.sanitizePreview(candidate.id)
      setDraftContent(proposal.content)
      setDraftDetail(proposal.detail ?? "")
      setSanitized({ redactions: proposal.redactions })
      setEditing(true)
    } catch (err) {
      setError(err instanceof Error ? t("memory:redactionUnavailableEditManuallyValue0", { v0: err.message }) : t("memory:redactionUnavailableEditManually"))
    } finally {
      setBusy(null)
    }
  }

  async function handleDismiss() {
    setBusy("dismiss")
    setError(null)
    try {
      await runCandidateMutation(async () => {
        await memoriesApi.remove(candidate.id, { surface })
        onDismissed?.()
        if (candidate.sensitive) removeLocal(candidate.id)
        else upsertLocal({ ...candidate, status: "discarded" })
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToDismiss"))
    } finally {
      setBusy(null)
    }
  }

  async function handleRestore() {
    setBusy("restore")
    setError(null)
    try {
      await runCandidateMutation(async () => {
        const restored = await memoriesApi.restoreCandidate(candidate.id, { surface })
        upsertLocal(restored)
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToRestoreTheCandidate"))
    } finally {
      setBusy(null)
    }
  }

  async function handleSaveEdit() {
    const { content, detail } = buildCandidateDraftPatch(draftContent, draftDetail)
    if (!content) return
    setBusy("save")
    setError(null)
    try {
      const updated = await runCandidateMutation(async () => {
        const result = await memoriesApi.update(candidate.id, { content, detail }, { surface })
        upsertLocal(result)
        return result
      }, onChanged)
      setDisplayContent(updated.content)
      setDisplayDetail(updated.detail)
      setEditing(false)
      setSanitized(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToSave"))
    } finally {
      setBusy(null)
    }
  }

  if (resolved !== "pending") {
    // Auto mode applied this proposal without asking — monitoring stays on:
    // the card says so and offers the one-click inverse. A revert puts the
    // item back into the review lane, and this card becomes a pending review.
    if (autoApplied && storeStatus === "active") {
      return <AutoAppliedCard candidate={candidate} revisionOf={revisionOf} freshAt={freshAt} surface={surface} onChanged={onChanged} />
    }
    if (resolved === "accepted") {
      return <AcceptedCandidateCard candidate={candidate} surface={surface} onChanged={onChanged} />
    }
    return (
      <div className="flex items-center justify-between gap-3 memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        <span>{t("memory:dismissed")}</span>
        {allowRestore && !candidate.sensitive ? (
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void handleRestore()}>
            {busy === "restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
            {t("memory:restoreForReview")}</Button>
        ) : null}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
    )
  }

  const busyState = busy !== null

  return (
    <div className={MEMORY_CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <Inbox aria-hidden className="h-4 w-4 text-muted-foreground" />
          {t("memory:memoryCandidate")}<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cand-dot" />
        </span>
        {revisionOf ? (
          <MemoryBadge className="inline-flex items-center gap-1 rounded-md border border-info/30 bg-info/10 px-1.5 py-0.5 text-[11px] font-medium text-info-foreground dark:text-info-foreground">
            <RefreshCw className="h-3 w-3" />
            {t("memory:revisionReplaces")}{revisionOf.id}
          </MemoryBadge>
        ) : null}
        {candidate.sensitive ? (
          <MemoryBadge className="inline-flex items-center gap-1 rounded-md border border-cand-border bg-cand-surface px-1.5 py-0.5 text-[11px] font-medium text-cand-fg">
            <AlertTriangle className="h-3 w-3" />
            {t("memory:sensitiveNeedsYourConfirmation")}</MemoryBadge>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
      </div>

      {resurfaced ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-info/25 bg-info/5 px-2 py-1 text-xs text-muted-foreground">
          <RefreshCw className="mt-0.5 h-3 w-3 shrink-0 text-info-foreground dark:text-info-foreground" />
          <span className="min-w-0 flex-1">
            {t("memory:proposedBefore")}{candidate.provenanceSessionId && candidate.provenanceSessionId !== chatId ? t("memory:inAnotherChat") : t("memory:inThisChat")} {t("memory:andStillWaitingForYourReviewThisIsTheSame")}</span>
        </p>
      ) : null}

      {revisionOf ? (
        // Two clean versions, stacked — readable prose beats a red/green line
        // diff (user decision 2026-07-16). While editing, only the current
        // version stays as reference; the textarea is the proposed text.
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="memory-reference rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 px-3 py-2">
            <p className="text-[11px] font-medium text-muted-foreground">
              {t("memory:current")}<span className="font-mono normal-case">{revisionOf.id}</span>
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{revisionOf.content}</p>
          </div>
          {!editing ? (
            <div className="memory-reference rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 px-3 py-2">
              <p className="text-[11px] font-medium text-info-foreground dark:text-info-foreground">{t("memory:proposed")}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{displayContent}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3">
        {editing ? (
          <div className="space-y-2">
            {sanitized ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-success-foreground dark:text-success-foreground" />
                {t("memory:redactionProposalReviewEditThenAcceptToActivateIt")}{sanitized.redactions.map((r) => (
                  <MemoryBadge key={r.placeholder} className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {r.placeholder} {r.kind}
                  </MemoryBadge>
                ))}
              </p>
            ) : null}
            <Textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              className="min-h-16 text-sm"
              autoFocus
            />
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t("memory:detailOptional")}</span>
              <Textarea
                value={draftDetail}
                onChange={(e) => setDraftDetail(e.target.value)}
                className="min-h-20 text-sm text-foreground"
                placeholder={t("memory:clearThisFieldToRemoveTheDetail")}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={busyState}
                onClick={() => {
                  setEditing(false)
                  setSanitized(null)
                  setDraftContent(displayContent)
                  setDraftDetail(displayDetail ?? "")
                }}
              >
                {t("common:cancel")}</Button>
              <Button variant="outline" size="xs" disabled={busyState || !draftContent.trim()} onClick={() => void handleSaveEdit()}>
                {t("common:save")}</Button>
            </div>
          </div>
        ) : revisionOf ? null : ( // for revisions the "proposed" card above carries the text
          <p className="whitespace-pre-wrap text-sm text-foreground">{displayContent}</p>
        )}
      </div>

      {displayDetail && !editing ? (
        <div className="mt-2">
          <ExpandableRow
            expandedContent={<p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{displayDetail}</p>}
          >
            <span className="text-xs text-muted-foreground">{t("memory:detail2")}</span>
          </ExpandableRow>
        </div>
      ) : null}

      <div className="mt-3 flex flex-col items-stretch gap-3 @lg:flex-row @lg:flex-wrap @lg:items-end">
        <ScopeControl value={scope} onValueChange={setScope} disabled={busyState} showConsequence />
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {!editing && candidate.sensitive ? (
            <Button variant="ghost" size="xs" disabled={busyState} onClick={() => void handleSanitize()}>
              {busy === "sanitize" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              {t("memory:prepareSanitized")}</Button>
          ) : null}
          {!editing ? (
            <Button variant="ghost" size="xs" disabled={busyState} onClick={() => {
              setDraftContent(displayContent)
              setDraftDetail(displayDetail ?? "")
              setEditing(true)
            }}>
              <Pencil className="h-3.5 w-3.5" />{t("common:edit")}</Button>
          ) : null}
          <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" disabled={busyState} onClick={() => void handleDismiss()}>
            <X className="h-3.5 w-3.5" />{t("common:dismiss")}</Button>
          <Button
            variant="default"
            size="xs"
            disabled={busyState}
            title={revisionOf ? t("memory:acceptingArchivesValue0AndReplacesItWithThisText", { v0: revisionOf.id }) : undefined}
            onClick={() => void handleAccept()}
          >
            <Check className="h-3.5 w-3.5" /> {revisionOf ? t("memory:acceptReplace") : t("common:accept")}
          </Button>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
