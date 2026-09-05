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
      setError(err instanceof Error ? err.message : "Failed to save")
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
          setError("Use Transfer… to move this into a specific project.")
          return
        }
        patch.projectId = item.projectId
      }
      const updated = await memoriesApi.update(item.id, patch, { surface })
      onUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move")
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
      setError(err instanceof Error ? err.message : "Failed to update")
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
          setError("Edit or prepare a sanitized version before accepting.")
          return
        }
        await onAccept(item, reviewedSensitivePatch)
      } else {
        await onAccept(item)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept")
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
      setError(err instanceof Error ? `Redaction unavailable — edit manually (${err.message})` : "Redaction unavailable — edit manually")
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
      setError(err instanceof Error ? err.message : "Failed")
      setBusy(null)
    }
  }

  const busyState = busy !== null
  const provenance = item.provenanceSessionId || item.provenanceTurn !== undefined
    ? `from ${item.provenanceSessionId ? item.provenanceSessionId.slice(0, 8) : "unknown session"}${item.provenanceTurn !== undefined ? ` · turn ${item.provenanceTurn}` : ""}`
    : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Chip className="font-mono">{item.id}</Chip>
        <Chip className={item.status === "candidate" ? "border-cand-border bg-cand-surface text-cand-fg" : undefined}>
          {item.status}
        </Chip>
        <Button variant="ghost" size="icon-sm" aria-label="Close" className="ml-auto" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-2 px-4 pt-3">
        <ScopeBadge scope={item.scope} />
        <SegmentedControl<"details" | "history">
          size="sm"
          className="ml-auto"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "details", label: "Details", icon: SlidersHorizontal },
            { value: "history", label: "History", icon: HistoryIcon },
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
                    Review this sensitive draft here. Prepare a redacted proposal or edit it manually; the original text cannot be accepted unchanged.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" disabled={busyState} onClick={() => void handleSanitize()}>
                      {busy === "sanitize" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      Prepare sanitized
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busyState} onClick={() => void handleArchive()}>
                      <X className="h-3.5 w-3.5" /> Dismiss
                    </Button>
                    <Button
                      variant="juicy"
                      size="sm"
                      disabled={busyState || !reviewedSensitivePatch}
                      onClick={() => void handleAccept()}
                    >
                      <Check className="h-3.5 w-3.5" /> Accept reviewed
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="juicy" size="sm" disabled={busyState} onClick={() => void handleAccept()}>
                    <Check className="h-3.5 w-3.5" /> Accept
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busyState} onClick={() => void handleArchive()}>
                    <X className="h-3.5 w-3.5" /> Dismiss
                  </Button>
                </div>
              )
            ) : null}

            {sanitized ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Redaction proposal staged for your review
                {sanitized.map((redaction) => (
                  <span key={redaction.placeholder} className="rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    {redaction.placeholder} {redaction.kind}
                  </span>
                ))}
              </p>
            ) : null}

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">content</label>
              <Textarea
                value={draft.content}
                onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                className="min-h-16 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">detailed form</label>
              <Textarea
                value={draft.detail}
                onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                placeholder="Loaded on demand by the agent — optional"
                className="min-h-20 text-sm"
              />
            </div>

            {sensitiveCandidate ? null : (
              <div className="flex justify-end">
                <Button variant="juicy" size="sm" disabled={busyState || !isDirty || !draft.content.trim()} onClick={() => void handleSave()}>
                  Save
                </Button>
              </div>
            )}

            <div className="border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {item.scope === "session" ? "session-scoped — move to widen reach" : "scope"}
              </label>
              <div className="inline-flex items-center rounded-lg border border-border p-[3px]">
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
                      {scope === "personal" ? "Personal" : "Project"}
                    </button>
                  )
                })}
              </div>
            </div>

            {provenance ? <p className="text-xs text-muted-foreground">{provenance}</p> : null}
            <p className="text-xs text-muted-foreground">used {item.usageCount}×</p>

            {sensitiveCandidate ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-cand-border bg-cand-surface px-2.5 py-1 text-xs font-medium text-cand-fg">
                <ShieldAlert className="h-3.5 w-3.5" /> Sensitive
              </span>
            ) : (
              <button
                type="button"
                disabled={busyState}
                onClick={() => void handleToggleSensitive()}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                  item.sensitive ? "border-cand-border bg-cand-surface text-cand-fg" : "border-border bg-muted text-muted-foreground",
                )}
              >
                {item.sensitive ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
                {item.sensitive ? "Sensitive" : "Not sensitive"}
              </button>
            )}

            {item.status !== "candidate" ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setTransferOpen(true)}>
                  <ArrowRightLeft className="h-3.5 w-3.5" /> Transfer…
                </Button>
                {archiveArmed ? (
                  <div className="flex items-center gap-2">
                    <Button variant="destructive" size="sm" disabled={busyState} onClick={() => void handleArchive()}>
                      Confirm archive
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setArchiveArmed(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" disabled={busyState} onClick={() => setArchiveArmed(true)}>
                    Archive
                  </Button>
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

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : (
          <MemoryHistoryPanel itemId={item.id} onReverted={onUpdated} surface={surface} />
        )}
      </div>
    </div>
  )
}
