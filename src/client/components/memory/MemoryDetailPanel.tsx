import { translateUiText } from "../../i18n/uiText"
import { memoryStatusLabel } from "../../i18n/labels"
import { traceVerdictLabel } from "../../i18n/labels"
import { getLocale, t, useI18n } from "../../i18n"
import { Trans } from "react-i18next"
import { MemoryBadge } from "./MemoryBadge"
// Right-side detail panel for a selected memory (SPEC §4.9, §4.11). Two tabs:
// "Details" (editable fields + scope move + provenance/usage/sensitive) and
// "History" (the per-item version/usage timeline with rollback, option 乙).
import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRightLeft,
  Check,
  Clock3,
  FileWarning,
  History as HistoryIcon,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Users,
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
import { Chip, ScopeBadge, SCOPE_ICONS, TeamBadge } from "./ScopeBadge"
import { MemoryHistoryPanel } from "./MemoryHistoryPanel"
import { auditRecord } from "../../lib/auditRecord"
import { TRACE_DOT_CLASSES } from "./memoryVocab"
import { MemoryExpiryPicker } from "./MemoryExpiryPicker"
import { driftedFileRefs, fileChangedAgo } from "../../lib/memoryFileDrift"
import { useTranscriptRenderOptions } from "../messages/render-context"
import type { MemoryEvent } from "../../lib/memoriesApi"

const MOVE_SCOPES: MemoryScope[] = ["personal", "project"]

interface MemoryDetailPanelProps {
  item: MemoryItem
  allItems: MemoryItem[]
  /** The active transcript chat that owns this user Monitoring act. */
  chatId?: string
  onClose: () => void
  onUpdated: (item: MemoryItem) => void
  onAccept: (item: MemoryItem, reviewedPatch?: Partial<CreateMemoryBody> & { status: "active" }) => Promise<void>
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
  const [expiresAt, setExpiresAt] = useState<string | null>(item.expiresAt ?? null)
  const [archiveArmed, setArchiveArmed] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [teamWritten, setTeamWritten] = useState<"publish" | "propose" | null>(null)
  const [unshareArmed, setUnshareArmed] = useState(false)
  const [shareArmed, setShareArmed] = useState(false)
  const [canShare, setCanShare] = useState(false)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const [sanitized, setSanitized] = useState<Array<{ placeholder: string; kind: string }> | null>(null)
  // Monitoring-act beacon: opening an item's detail is a monitoring behavior.
  useEffect(() => {
    if (chatId) recordUiMonitor("detail_open", { ids: [item.id], sessionId: chatId, interaction: "open" })
  }, [chatId, item.id])
  const [busy, setBusy] = useState<"save" | "scope" | "sensitive" | "sanitize" | "accept" | "archive" | "file-check" | "team" | null>(null)
  const { readonly, previewDemo } = useTranscriptRenderOptions()
  const [error, setError] = useState<string | null>(null)
  const [auditEvents, setAuditEvents] = useState<MemoryEvent[]>([])
  useEffect(() => {
    let current = true
    setAuditEvents([])
    if (item.status !== "candidate") void memoriesApi.history(item.id).then(history => { if (current) setAuditEvents(history.events) }).catch(() => {})
    return () => { current = false }
  }, [item])
  const record = useMemo(() => auditRecord(auditEvents), [auditEvents])
  useEffect(() => {
    let live = true
    setCanShare(false)
    if (!readonly && !previewDemo && !item.team && item.status === "active" && !item.sensitive && item.scope === "project" && item.projectId) {
      void memoriesApi.teamStatus(item.projectId).then(status => { if (live) setCanShare(status.canShare) }).catch(() => {})
    }
    return () => { live = false }
  }, [item.id, item.projectId, item.scope, item.status, item.sensitive, item.team, readonly, previewDemo])
  useEffect(() => { if (proposing) contentRef.current?.focus() }, [proposing])
  useEffect(() => { setProposing(false); setTeamWritten(null); setUnshareArmed(false) }, [item.id])

  // A fresh selection (or an update landing from elsewhere) resets the draft
  // and any armed confirmations.
  useEffect(() => {
    setDraft({ content: item.content, detail: item.detail ?? "" })
    setExpiresAt(item.expiresAt ?? null)
    setSanitized(null)
    setArchiveArmed(false)
    setShareArmed(false)
    setError(null)
  }, [item.id, item.updatedAt])

  const dirtyPatch = useMemo(() => {
    const patch: Partial<CreateMemoryBody> = {}
    const content = draft.content.trim()
    if (content && content !== item.content) patch.content = content
    const detail = draft.detail.trim()
    if (detail !== (item.detail ?? "")) patch.detail = detail
    if (expiresAt !== (item.expiresAt ?? null)) patch.expiresAt = expiresAt
    return patch
  }, [draft, expiresAt, item])

  const isDirty = Object.keys(dirtyPatch).length > 0
  const shareBlocked = isDirty || draft.content.trim() !== item.content.trim()
  const expiryDirty = expiresAt !== (item.expiresAt ?? null)
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
      const updated = item.team ? await memoriesApi.proposeTeam(item.id, draft.content) : await memoriesApi.update(item.id, dirtyPatch, { surface })
      onUpdated(updated)
      if (item.team) { setProposing(false); setTeamWritten("propose") }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToSave"))
    } finally {
      setBusy(null)
    }
  }

  async function handleTeam(action: "publish" | "unshare" | "toggle") {
    setBusy("team")
    setError(null)
    try {
      const updated = action === "publish" ? await memoriesApi.publishTeam(item.id)
        : action === "unshare" ? await memoriesApi.unshareTeam(item.id)
          : await memoriesApi.update(item.id, { status: item.status === "active" ? "archived" : "active" }, { surface })
      onUpdated(updated)
      setTeamWritten(action === "publish" ? "publish" : null)
      setUnshareArmed(false)
      setShareArmed(false)
      setProposing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failedToUpdate"))
    } finally {
      setBusy(null)
    }
  }

  async function handleMoveScope(target: MemoryScope) {
    if (expiryDirty || target === item.scope) return
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
    if (expiryDirty) return
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
        await onAccept(item, { ...reviewedSensitivePatch, expiresAt })
      } else {
        await onAccept(item, { status: "active", expiresAt })
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

  async function handleFileCheck() {
    setBusy("file-check")
    setError(null)
    try {
      onUpdated(await memoriesApi.acknowledgeFileRefs(item.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:failed"))
    } finally {
      setBusy(null)
    }
  }

  const busyState = busy !== null
  const drifted = driftedFileRefs(item)
  const removedSource = drifted.find(ref => ref.drift === "line_removed")
  const driftPathCount = new Set(drifted.map(ref => ref.path)).size
  const canReviewFiles = (item.status === "active" || item.status === "candidate") && !readonly && !previewDemo
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
        {item.team ? <TeamBadge /> : null}
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
            {item.team ? <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
              <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-5 text-muted-foreground">{item.status === "archived" ? <span className="font-medium text-foreground">{t("memory:teamOffHere")} </span> : null}<Trans ns="memory" i18nKey="teamDetail" components={{ code: <code className="font-mono text-[11px]" /> }} /></p>
                {!readonly && !previewDemo && !proposing ? <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {item.status === "active" ? <Button variant="outline" size="xs" className="bg-background" disabled={busyState} onClick={() => { setTeamWritten(null); setProposing(true) }}>{t("memory:teamPropose")}</Button> : null}
                  <Button variant={item.status === "archived" ? "outline" : "ghost"} size="xs" className={item.status === "archived" ? "bg-background" : undefined} disabled={busyState} onClick={() => void handleTeam("toggle")}>{busy === "team" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{item.status === "archived" ? t("memory:teamTurnOn") : t("memory:teamTurnOff")}</Button>
                </div> : null}
                {teamWritten === "publish" ? <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground"><Check className="h-3 w-3 text-success" />{t("memory:teamWritten")}</p> : null}
              </div>
            </div> : null}
            {drifted.length > 0 && canReviewFiles ? <div className="flex items-start gap-2 rounded-lg border border-cand-fg/20 bg-cand-surface px-3 py-2.5">
              <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cand-fg" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-5 text-cand-fg">
                  {removedSource ? <Trans ns="memory" i18nKey="sourceLineRemovedCallout" values={{ path: removedSource.path }} components={{ code: <code className="break-all font-mono text-[11px]" /> }} />
                    : driftPathCount > 1 ? t("memory:filesChangedCallout", { count: driftPathCount })
                      : <Trans ns="memory" i18nKey={drifted[0]!.drift === "missing" ? "fileMissingCallout" : "fileChangedCallout"} values={{ path: drifted[0]!.path }} components={{ code: <code className="break-all font-mono text-[11px]" /> }} />}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {removedSource ? <>
                    <Button variant="outline" size="xs" className="bg-background" disabled={busyState} onClick={() => void handleArchive()}>{busy === "archive" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t("common:archive")}</Button>
                    <Button variant="ghost" size="xs" disabled={busyState} onClick={() => void handleFileCheck()}>{busy === "file-check" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t("memory:keepOwnMemory")}</Button>
                  </> : <>
                    <Button variant="outline" size="xs" className="bg-background" disabled={busyState} onClick={() => void handleFileCheck()}>{busy === "file-check" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t("memory:stillApplies")}</Button>
                    {item.team ? (proposing ? null : <Button variant="ghost" size="xs" disabled={busyState} onClick={() => { setTeamWritten(null); setProposing(true) }}>{t("memory:teamPropose")}</Button>)
                      : <Button variant="ghost" size="xs" disabled={busyState} onClick={() => void handleArchive()}>{busy === "archive" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t("common:archive")}</Button>}
                  </>}
                </div>
              </div>
            </div> : null}
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
              {item.team && !proposing ? <p data-team-rule-text className="whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm leading-6 text-foreground">{item.content}</p> : <Textarea
                ref={contentRef}
                value={draft.content}
                onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                className="min-h-16 text-sm"
              />}
              {item.team && teamWritten === "propose" ? <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Check className="h-3 w-3 text-success" />{t("memory:teamWritten")}</p> : null}
            </div>

            {!item.team ? <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("memory:detailedForm")}</label>
              <Textarea
                value={draft.detail}
                onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                placeholder={t("memory:loadedOnDemandByTheAgentOptional")}
                className="min-h-20 text-sm"
              />
            </div> : null}

            {sensitiveCandidate || (item.team && !proposing) ? null : (
              <div className="flex justify-end">
                {item.team ? <Button variant="ghost" size="sm" onClick={() => { setProposing(false); setDraft({ content: item.content, detail: item.detail ?? "" }) }}>{t("common:cancel")}</Button> : null}
                <Button variant={item.status === "candidate" ? "outline" : "default"} size="sm" disabled={busyState || !isDirty || !draft.content.trim()} onClick={() => void handleSave()}>
                  {item.team ? t("memory:teamWrite") : t("common:save")}</Button>
              </div>
            )}

            {!item.team ? <div className="border-t border-border pt-3">
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
                      disabled={busyState || item.status === "archived" || expiryDirty}
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
              {item.status === "archived" ? <p className="mt-1 text-[11px] text-muted-foreground">{t("memory:restoreBeforeMoving")}</p> : null}
              {expiryDirty ? <p className="mt-1 text-[11px] text-muted-foreground">{t("memory:saveExpiryBeforeScopeOrSensitivity")}</p> : null}
            </div> : null}

            {item.team ? <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-3 w-3" />{t("memory:keep")}: {item.expiresAt ? t("memory:teamExpiryUntil", { date: new Date(item.expiresAt).toLocaleDateString(getLocale(), { month: "short", day: "numeric", year: "numeric" }) }) : t("memory:forever")}</div>
              : <MemoryExpiryPicker value={expiresAt} onChange={setExpiresAt} disabled={busyState} />}
            {item.fileRefs?.length ? <div>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t("memory:referencedFiles")}</span>
              <div className="space-y-1">{item.fileRefs.map(ref => <div key={`${ref.kind}:${ref.path}`} className="flex min-w-0 items-center gap-2 text-[11px]">
                {ref.kind === "source" ? <span className="shrink-0 text-muted-foreground">{t("memory:importedFrom")}</span> : null}
                <span title={ref.path} dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono text-muted-foreground">{ref.path}</span>
                <span className={ref.drift ? "shrink-0 text-cand-fg" : "shrink-0 text-muted-foreground"}>{ref.drift === "changed" && fileChangedAgo(ref.changedAt) ? t("memory:fileStatusChangedAgo", { when: fileChangedAgo(ref.changedAt) }) : t(ref.drift === "changed" ? "memory:fileStatusChanged" : ref.drift === "missing" ? "memory:fileStatusMissing" : ref.drift === "line_removed" ? "memory:fileStatusLineRemoved" : "memory:fileStatusUnchanged")}</span>
              </div>)}</div>
            </div> : null}
            {provenance ? <p className="text-xs text-muted-foreground">{provenance}</p> : null}
            <p className="text-xs text-muted-foreground">{t("memory:usedTimes", { count: item.usageCount })}</p>
            {item.status !== "candidate" && record.total ? <div>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t("memory:auditRecord")}</span>
              <div className="flex flex-wrap items-center gap-1">
                {record.verdicts.map((verdict, index) => <span key={index}
                  title={verdict.corrected ? `${traceVerdictLabel(verdict.auditLabel)} → ${t("memory:youVerdict", { v0: traceVerdictLabel(verdict.effectiveLabel) })}` : traceVerdictLabel(verdict.auditLabel)}
                  className={cn("h-2.5 w-2.5 rounded-[3px]", TRACE_DOT_CLASSES[verdict.effectiveLabel], verdict.corrected && "outline outline-1 outline-offset-1 outline-foreground/40")} />)}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{record.corrected ? t("memory:auditRecordCorrected", { n: record.corrected, m: record.total }) : t("memory:auditRecordNone", { m: record.total })}</p>
            </div> : null}

            {item.team ? null : sensitiveCandidate ? (
              <MemoryBadge className="inline-flex items-center gap-1.5 rounded-md border border-cand-border bg-cand-surface px-1.5 py-1 text-[11px] font-medium text-cand-fg">
                <ShieldAlert className="h-3.5 w-3.5" /> {t("memory:sensitive")}</MemoryBadge>
            ) : (
              <button
                type="button"
                disabled={busyState || expiryDirty}
                title={expiryDirty ? t("memory:saveExpiryBeforeScopeOrSensitivity") : undefined}
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

            {item.team && !readonly && !previewDemo ? <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              {unshareArmed ? <p className="w-full text-[11px] leading-4 text-muted-foreground">{t("memory:teamRemoveHint")}</p> : null}
              {unshareArmed ? <><Button variant="ghost" size="sm" className="text-destructive" disabled={busyState} onClick={() => void handleTeam("unshare")}>{t("memory:teamRemoveConfirm")}</Button><Button variant="ghost" size="sm" onClick={() => setUnshareArmed(false)}>{t("common:cancel")}</Button></>
                : <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busyState} onClick={() => setUnshareArmed(true)}>{t("memory:teamRemove")}</Button>}
            </div> : null}
            {!item.team && item.status === "active" ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                {shareArmed ? <p className="w-full text-[11px] leading-4 text-muted-foreground">{t("memory:teamShareDetailHint")}</p> : null}
                <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setTransferOpen(true)}>
                  <ArrowRightLeft className="h-3.5 w-3.5" /> {t("memory:transfer")}</Button>
                {canShare ? <Button variant="ghost" size="sm" disabled={busyState || shareBlocked} title={shareBlocked ? t("memory:teamShareSaveFirst") : undefined} onClick={() => {
                  if (!shareArmed && (item.detail?.trim() || draft.detail.trim())) setShareArmed(true)
                  else void handleTeam("publish")
                }}><Users className="h-3.5 w-3.5" />{t("memory:teamShare")}</Button> : null}
                {shareArmed ? <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setShareArmed(false)}>{t("common:cancel")}</Button> : null}
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
          <MemoryHistoryPanel itemId={item.id} onReverted={onUpdated} surface={surface} readOnly={Boolean(item.team || readonly || previewDemo)} />
        )}
      </div>
    </div>
  )
}
