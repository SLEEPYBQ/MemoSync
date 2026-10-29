import { translateUiText } from "../../i18n/uiText"
import { memoryStatusLabel } from "../../i18n/labels"
import { t, useI18n } from "../../i18n"
import { MemoryBadge } from "./MemoryBadge"
// Right-side detail panel for a selected memory (SPEC §4.9, §4.11). Two tabs:
// "Details" (editable fields + scope move + provenance/usage/sensitive) and
// "History" (the per-item version/usage timeline with rollback, option 乙).
import { useEffect, useMemo, useState } from "react"
import {
  ArrowRightLeft,
  Check,
  History as HistoryIcon,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  X,
} from "lucide-react"
import {
  memoriesApi,
  recordUiMonitor,
  type CreateMemoryBody,
  type MemoryControlSurface,
  type MemoryItem,
  type MemoryScope,
} from "../../lib/memoriesApi"
import { TransferMemoryDialog } from "./TransferMemoryDialog"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { SegmentedControl } from "../ui/segmented-control"
import { cn } from "../../lib/utils"
import { Chip, ScopeBadge, SCOPE_ICONS } from "./ScopeBadge"
import { MemoryHistoryPanel } from "./MemoryHistoryPanel"

const MOVE_SCOPES: MemoryScope[] = ["personal", "project"]

interface MemoryDetailPanelProps {
  item: MemoryItem
  allItems: MemoryItem[]
  /** The active transcript chat that owns this participant Monitoring act. */
  chatId?: string
  onClose: () => void
  onUpdated: (item: MemoryItem) => void
  onAccept: (item: MemoryItem, reviewedPatch?: ReviewedSensitiveCandidatePatch) => Promise<void>
  onArchive: (item: MemoryItem) => Promise<void>
  surface?: MemoryControlSurface
}

export type ReviewedSensitiveCandidatePatch = Partial<CreateMemoryBody> & {
  content: string
  detail: string
  status: "active"
}

export function buildReviewedSensitiveCandidatePatch(
  item: MemoryItem,
  draft: { content: string; detail: string },
): ReviewedSensitiveCandidatePatch | null {
  if (item.status !== "candidate" || !item.sensitive) return null
  const content = draft.content.trim()
  const detail = draft.detail.trim()
  if (!content) return null
  // The captured sensitive Content itself must be replaced. A Detail-only
  // edit would otherwise let the original raw Content become active.
  if (content === item.content.trim()) return null
  return { content, detail, status: "active" }
}

export function MemoryDetailPanel({ item, allItems, chatId, onClose, onUpdated, onAccept, onArchive, surface }: MemoryDetailPanelProps) {
  useI18n()
  const [tab, setTab] = useState<"details" | "history">("details")
  const [draft, setDraft] = useState({ content: item.content, detail: item.detail ?? "" })
  const [archiveArmed, setArchiveArmed] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [sanitized, setSanitized] = useState<Array<{ placeholder: string; kind: string }> | null>(null)
  // Monitoring-act beacon: opening an item's detail is a monitoring behavior.
  useEffect(() => {
    if (chatId) recordUiMonitor("detail_open", { ids: [item.id], sessionId: chatId, interaction: "open" })
  }, [chatId, item.id])
  const [busy, setBusy] = useState<"save" | "scope" | "sensitive" | "sanitize" | "accept" | "archive" | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A fresh selection (or an update landing from elsewhere) resets the draft
  // and any armed confirmations.
  useEffect(() => {
    setDraft({ content: item.content, detail: item.detail ?? "" })
    setSanitized(null)
    setArchiveArmed(false)
    setError(null)
  }, [item.id, item.updatedAt])

  const dirtyPatch = useMemo(() => {
    const patch: Partial<CreateMemoryBody> = {}
    const content = draft.content.trim()
    if (content && content !== item.content) patch.content = content
    const detail = draft.detail.trim()
    if (detail !== (item.detail ?? "")) patch.detail = detail
    return patch
  }, [draft, item])

  const isDirty = Object.keys(dirtyPatch).length > 0
  const sensitiveCandidate = item.status === "candidate" && item.sensitive
  const reviewedSensitivePatch = useMemo(
    () => buildReviewedSensitiveCandidatePatch(item, draft),
    [draft, item],
  )

  async function handleSave() {
    if (!draft.content.trim() || !isDirty) return
    setBusy("save")
    setError(null)
    try {
      const updated = await memoriesApi.update(item.id, dirtyPatch, { surface })
      onUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToSave"))
    } finally {
      setBusy(null)
    }
  }

  async function handleMoveScope(target: MemoryScope) {
    if (target === item.scope) return
    setBusy("scope")
    setError(null)
    try {
      const patch: Partial<CreateMemoryBody> = { scope: target }
      if (target === "project") {
        // Only the item's OWN project binding counts — guessing a project
        // (e.g. the first one in the list) would land the memory somewhere
        // the user never chose. Transfer… has the explicit project picker.
        if (!item.projectId) {
          setError(t("memory:useTransferToMoveThisIntoASpecificProject"))
          return
        }
        patch.projectId = item.projectId
      }
      const updated = await memoriesApi.update(item.id, patch, { surface })
      onUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToMove"))
    } finally {
      setBusy(null)
    }
  }

  async function handleToggleSensitive() {
    setBusy("sensitive")
    setError(null)
    try {
      // `sensitive` isn't (yet) in CreateMemoryBody's declared keys — the
      // server forwards unrecognized PATCH fields through untyped, so this
      // intersection keeps the call typed without touching memoriesApi.ts.
      const patch: Partial<CreateMemoryBody> & { sensitive: boolean } = { sensitive: !item.sensitive }
      const updated = await memoriesApi.update(item.id, patch, { surface })
      onUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToUpdate"))
    } finally {
      setBusy(null)
    }
  }

  async function handleAccept() {
    setBusy("accept")
    setError(null)
    try {
      if (sensitiveCandidate) {
        if (!reviewedSensitivePatch) {
          setError(t("memory:editOrPrepareASanitizedVersionBeforeAccepting"))
          return
        }
        await onAccept(item, reviewedSensitivePatch)
      } else {
        await onAccept(item)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToAccept"))
    } finally {
      setBusy(null)
    }
  }

  async function handleSanitize() {
    setBusy("sanitize")
    setError(null)
    try {
      const proposal = await memoriesApi.sanitizePreview(item.id)
      setDraft({ content: proposal.content, detail: proposal.detail ?? "" })
      setSanitized(proposal.redactions)
    } catch (err) {
      setError(err instanceof Error ? t("memory:redactionUnavailableEditManuallyValue0", { v0: err.message }) : t("memory:redactionUnavailableEditManually"))
    } finally {
      setBusy(null)
    }
  }

  async function handleArchive() {
    setBusy("archive")
    setError(null)
    try {
      await onArchive(item)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failed"))
      setBusy(null)
    }
  }

  const busyState = busy !== null
  const provenance = item.provenanceSessionId || item.provenanceTurn !== undefined
    ? `from ${item.provenanceSessionId ? item.provenanceSessionId.slice(0, 8) : t("memory:unknownSession")}${item.provenanceTurn !== undefined ? t("memory:turnValue0", { v0: item.provenanceTurn }) : ""}`
    : null

  return (
    <div className="memory-ui @container min-w-0 flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Chip className="font-mono">{item.id}</Chip>
        <Chip className={item.status === "candidate" ? "border-cand-border bg-cand-surface text-cand-fg" : undefined}>
          {memoryStatusLabel(item.status)}
        </Chip>
        <Button variant="ghost" size="icon-sm" aria-label={t("common:close")} className="ml-auto" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <ScopeBadge scope={item.scope} />
        <SegmentedControl<"details" | "history">
          size="sm"
          className="ml-auto"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "details", label: t("common:details"), icon: SlidersHorizontal },
            { value: "history", label: t("memory:history"), icon: HistoryIcon },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {tab === "details" ? (
          <div className="mt-3 space-y-4">
            {item.status === "candidate" ? (
              sensitiveCandidate ? (
                <div className="rounded-lg border border-cand-border bg-cand-surface/60 p-3">
                  <p className="text-xs text-cand-fg">
                    {t("memory:reviewThisSensitiveDraftHerePrepareARedactedProposalOr")}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" disabled={busyState} onClick={() => void handleSanitize()}>
                      {busy === "sanitize" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      {t("memory:prepareSanitized")}</Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={busyState} onClick={() => void handleArchive()}>
                      <X className="h-3.5 w-3.5" /> {t("common:dismiss")}</Button>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={busyState || !reviewedSensitivePatch}
                      onClick={() => void handleAccept()}
                    >
                      <Check className="h-3.5 w-3.5" /> {t("memory:acceptReviewed")}</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={busyState} onClick={() => void handleArchive()}>
                    <X className="h-3.5 w-3.5" /> {t("common:dismiss")}</Button>
                  <Button variant="default" size="sm" disabled={busyState} onClick={() => void handleAccept()}>
                    <Check className="h-3.5 w-3.5" /> {t("common:accept")}</Button>
                </div>
              )
            ) : null}

            {sanitized ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-success-foreground dark:text-success-foreground" />
                {t("memory:redactionProposalStagedForYourReview")}{sanitized.map((redaction) => (
                  <MemoryBadge key={redaction.placeholder} className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {redaction.placeholder} {redaction.kind}
                  </MemoryBadge>
                ))}
              </p>
            ) : null}

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("memory:content")}</label>
              <Textarea
                value={draft.content}
                onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                className="min-h-16 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("memory:detailedForm")}</label>
              <Textarea
                value={draft.detail}
                onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                placeholder={t("memory:loadedOnDemandByTheAgentOptional")}
                className="min-h-20 text-sm"
              />
            </div>

            {sensitiveCandidate ? null : (
              <div className="flex justify-end">
                <Button variant={item.status === "candidate" ? "outline" : "default"} size="sm" disabled={busyState || !isDirty || !draft.content.trim()} onClick={() => void handleSave()}>
                  {t("common:save")}</Button>
              </div>
            )}

            <div className="border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {item.scope === "session" ? t("memory:sessionScopedMoveToWidenReach") : t("memory:scopeLabel")}
              </label>
              <div className="inline-flex max-w-full flex-wrap items-center rounded-lg border border-border p-[3px]">
                {MOVE_SCOPES.map((scope) => {
                  const Icon = SCOPE_ICONS[scope]
                  const active = scope === item.scope
                  return (
                    <button
                      key={scope}
                      type="button"
                      disabled={busyState}
                      onClick={() => void handleMoveScope(scope)}
                      aria-pressed={active}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                        active
                          ? scope === "personal"
                            ? "bg-personal-surface text-personal-fg"
                            : "bg-project-surface text-project-fg"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-card",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {scope === "personal" ? t("common:personal") : t("common:project")}
                    </button>
                  )
                })}
              </div>
            </div>

            {provenance ? <p className="text-xs text-muted-foreground">{provenance}</p> : null}
            <p className="text-xs text-muted-foreground">{t("memory:usedTimes", { count: item.usageCount })}</p>

            {sensitiveCandidate ? (
              <MemoryBadge className="inline-flex items-center gap-1.5 rounded-md border border-cand-border bg-cand-surface px-1.5 py-1 text-[11px] font-medium text-cand-fg">
                <ShieldAlert className="h-3.5 w-3.5" /> {t("memory:sensitive")}</MemoryBadge>
            ) : (
              <button
                type="button"
                disabled={busyState}
                onClick={() => void handleToggleSensitive()}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                  item.sensitive ? "border-cand-border bg-cand-surface text-cand-fg" : "border-border bg-muted text-muted-foreground",
                )}
              >
                {item.sensitive ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
                {item.sensitive ? t("memory:sensitive") : t("memory:notSensitive")}
              </button>
            )}

            {item.status !== "candidate" ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setTransferOpen(true)}>
                  <ArrowRightLeft className="h-3.5 w-3.5" /> {t("memory:transfer")}</Button>
                {archiveArmed ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" className="text-destructive hover:text-destructive" size="sm" disabled={busyState} onClick={() => void handleArchive()}>
                      {t("memory:confirmArchive")}</Button>
                    <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setArchiveArmed(false)}>
                      {t("common:cancel")}</Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={busyState} onClick={() => setArchiveArmed(true)}>
                    {t("common:archive")}</Button>
                )}
              </div>
            ) : null}
            {transferOpen ? (
              <TransferMemoryDialog
                item={item}
                open={transferOpen}
                onOpenChange={setTransferOpen}
                onDone={(created) => onUpdated(created)}
                surface={surface}
              />
            ) : null}

            {error ? <p className="text-xs text-destructive">{translateUiText(error)}</p> : null}
          </div>
        ) : (
          <MemoryHistoryPanel itemId={item.id} onReverted={onUpdated} surface={surface} />
        )}
      </div>
    </div>
  )
}
