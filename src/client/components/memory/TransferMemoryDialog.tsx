// Cross-context transfer instrument (DG3 / the title's "Across Context"):
// moving a memory across a scope or project boundary goes through a judged,
// mixed-initiative step — the LLM says as-is / rewrite / context-bound and
// proposes the adapted form; the developer edits and decides. Commit derives
// a NEW memory linked to the source (the source keeps serving its own
// context unless "archive original" is checked).
import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowRight, GitMerge, Loader2, TriangleAlert } from "lucide-react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogGhostButton,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { SegmentedControl } from "../ui/segmented-control"
import {
  memoriesApi,
  type MemoryControlSurface,
  type MemoryItem,
  type TransferProposal,
} from "../../lib/memoriesApi"
import { workspaceApi } from "../../lib/workspaceApi"
import { useMemoryStore } from "../../stores/memoryStore"
import { isMemoryScope, MEMORY_SCOPE_CHIP_CLASSES, memoryScopeLabel } from "../../lib/memoryCitations"
import { defaultTransferScope, transferScopeDisabled } from "../../lib/transferTarget"
import { cn } from "../../lib/utils"

const VERDICT_META: Record<TransferProposal["verdict"], { label: string; className: string }> = {
  as_is: { label: "transfers as-is", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  rewrite: { label: "adapted for the target", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  context_bound: { label: "context-bound — not recommended", className: "bg-red-500/10 text-red-700 dark:text-red-300" },
}

/**
 * A concrete transfer destination, e.g. from a Board drag onto a column or a
 * scope group. A session target is always fixed (dropped onto one session's
 * group) — there is no session picker in this dialog.
 */
export type TransferInitialTarget =
  | { scope: "personal" }
  | { scope: "project"; projectId?: string }
  | { scope: "session"; sessionId: string; sessionLabel?: string }

interface TransferMemoryDialogProps {
  item: MemoryItem
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Preselected target (e.g. from a Board drag). */
  initialTarget?: TransferInitialTarget
  /** Drags mean "move" (archive source); hover/panel default to "copy". */
  defaultArchiveOriginal?: boolean
  onDone?: (created: MemoryItem) => void
  surface?: MemoryControlSurface
}

export function TransferMemoryDialog({
  item,
  open,
  onOpenChange,
  initialTarget,
  defaultArchiveOriginal = false,
  onDone,
  surface,
}: TransferMemoryDialogProps) {
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [projects, setProjects] = useState<Record<string, string>>({})
  const [targetScope, setTargetScope] = useState<"personal" | "project" | "session">(
    initialTarget?.scope ?? defaultTransferScope(item.scope),
  )
  const [targetProjectId, setTargetProjectId] = useState<string | undefined>(
    initialTarget?.scope === "project" ? initialTarget.projectId : undefined,
  )
  // Session targets are fixed by the drop (one session's group); there is no
  // way to pick a different session here, so scope is locked when set.
  const [targetSessionId, setTargetSessionId] = useState<string | undefined>(
    initialTarget?.scope === "session" ? initialTarget.sessionId : undefined,
  )
  const sessionLabel = initialTarget?.scope === "session" ? initialTarget.sessionLabel : undefined
  const [proposal, setProposal] = useState<TransferProposal | null>(null)
  const [loadingProposal, setLoadingProposal] = useState(false)
  const [content, setContent] = useState("")
  const [archiveOriginal, setArchiveOriginal] = useState(defaultArchiveOriginal)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scope = isMemoryScope(item.scope) ? item.scope : "session"
  const projectOptions = useMemo(() => {
    const opts = Object.entries(projects).filter(([id]) => !(item.scope === "project" && item.projectId === id))
    // A project preselected by a drop must be selectable even if the titles
    // fetch hasn't caught up (or failed) — otherwise the picker silently
    // resets to "choose project…" and the target reads as unset.
    if (targetProjectId && !opts.some(([id]) => id === targetProjectId)) {
      opts.push([targetProjectId, projects[targetProjectId] ?? targetProjectId])
    }
    return opts
  }, [projects, item, targetProjectId])

  useEffect(() => {
    if (!open) return
    setTargetScope(initialTarget?.scope ?? defaultTransferScope(item.scope))
    setTargetProjectId(initialTarget?.scope === "project" ? initialTarget.projectId : undefined)
    setTargetSessionId(initialTarget?.scope === "session" ? initialTarget.sessionId : undefined)
    setArchiveOriginal(defaultArchiveOriginal)
    setError(null)
    workspaceApi
      .projectTitles()
      .then(setProjects)
      .catch(() => setProjects({}))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id])

  // Re-judge whenever the target changes.
  useEffect(() => {
    if (!open) return
    if (targetScope === "project" && !targetProjectId) {
      setProposal(null)
      return
    }
    if (targetScope === "session" && !targetSessionId) {
      setProposal(null)
      return
    }
    let cancelled = false
    setLoadingProposal(true)
    setProposal(null)
    memoriesApi
      .transferPreview(item.id, {
        targetScope,
        targetProjectId: targetScope === "project" ? targetProjectId : undefined,
        targetSessionId: targetScope === "session" ? targetSessionId : undefined,
        targetProjectTitle: targetScope === "project" && targetProjectId ? projects[targetProjectId] : undefined,
        sourceProjectTitle: item.projectId ? projects[item.projectId] : undefined,
      })
      .then((p) => {
        if (cancelled) return
        setProposal(p)
        setContent(p.content)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "transfer preview failed")
      })
      .finally(() => {
        if (!cancelled) setLoadingProposal(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id, targetScope, targetProjectId, targetSessionId])

  const landing = proposal?.landing
  const reinforcing = landing?.route === "reinforces"

  async function handleConfirm() {
    if (!proposal || (!reinforcing && !content.trim())) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await memoriesApi.transfer(item.id, {
        targetScope,
        targetProjectId: targetScope === "project" ? targetProjectId : undefined,
        targetSessionId: targetScope === "session" ? targetSessionId : undefined,
        content: content.trim(),
        detail: proposal.detail,
        abstractionLevel: proposal.abstractionLevel,
        verdict: proposal.verdict,
        edited: content.trim() !== proposal.content,
        archiveOriginal,
        landingRoute: proposal.landing.route,
        landingTargetId: proposal.landing.targetId,
        rule: proposal.portable,
        applicability: proposal.applicability,
        surface,
      })
      await loadAll()
      onDone?.(created)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "transfer failed")
    } finally {
      setSubmitting(false)
    }
  }

  const targetLabel =
    targetScope === "project"
      ? targetProjectId
        ? (projects[targetProjectId] ?? "project")
        : "project"
      : targetScope === "session"
        ? (sessionLabel ?? "this session")
        : "Personal"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            Transfer {item.id}
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            {targetLabel}
          </DialogTitle>
          <DialogDescription>
            Review how this memory should be adapted before creating it in {targetLabel}.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-sm">
            <span
              className={cn(
                "mt-0.5 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[0.7em] leading-none",
                MEMORY_SCOPE_CHIP_CLASSES[scope],
              )}
            >
              {item.id}
            </span>
            <span className="min-w-0 flex-1 text-muted-foreground">{item.content}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">to</span>
            {targetScope === "session" ? (
              // The session is fixed by the drop — no picker, just name it.
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-sm",
                  MEMORY_SCOPE_CHIP_CLASSES.session,
                )}
              >
                {memoryScopeLabel("session")} · {sessionLabel ?? targetSessionId}
              </span>
            ) : (
              <>
                <SegmentedControl
                  value={targetScope === "project" ? "project" : "personal"}
                  onValueChange={(v) => setTargetScope(v)}
                  options={[
                    {
                      value: "personal" as const,
                      label: memoryScopeLabel("personal"),
                      disabled: transferScopeDisabled(item.scope, "personal"),
                    },
                    {
                      value: "project" as const,
                      label: memoryScopeLabel("project"),
                      disabled: transferScopeDisabled(item.scope, "project"),
                    },
                  ]}
                  size="sm"
                />
                {targetScope === "project" ? (
                  <select
                    value={targetProjectId ?? ""}
                    onChange={(e) => setTargetProjectId(e.target.value || undefined)}
                    className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="">choose project…</option>
                    {projectOptions.map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                ) : null}
              </>
            )}
          </div>

          {loadingProposal ? (
            <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Abstracting and re-instantiating…
            </p>
          ) : proposal ? (
            <div className="flex flex-col gap-2">
              <span
                className={cn(
                  "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  VERDICT_META[proposal.verdict].className,
                )}
              >
                {VERDICT_META[proposal.verdict].label}
              </span>

              {/* The encode → decode pipeline (Transfer design 2026-08-08):
                  show the abstract rule the source was encoded to (dashed =
                  metadata, never a standalone item), then the localized form
                  the developer edits. Skipped for as_is (the two coincide) —
                  the item just moves verbatim. */}
              {proposal.verdict !== "as_is" && proposal.portable !== proposal.content ? (
                <div className="flex flex-col gap-1.5">
                  <div className="rounded-lg border border-dashed border-border bg-muted/20 px-2.5 py-1.5">
                    <p className="text-[10px] font-medium text-muted-foreground">Abstract rule</p>
                    <p className="text-sm text-muted-foreground">{proposal.portable}</p>
                    {proposal.applicability ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                        <span className="font-medium">Applies when:</span> {proposal.applicability}
                      </p>
                    ) : null}
                  </div>
                  <ArrowDown className="mx-auto h-3.5 w-3.5 text-muted-foreground/60" />
                </div>
              ) : null}

              <div className="flex flex-col gap-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  In {targetLabel}
                </p>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={3}
                  disabled={reinforcing}
                  className={cn("text-sm", reinforcing && "opacity-50")}
                />
              </div>
              {proposal.note ? <p className="text-xs text-muted-foreground">{proposal.note}</p> : null}

              {/* Landing: how the instantiated form meets what already lives
                  in the target context (same vocabulary as capture). */}
              {landing?.route === "reinforces" ? (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2 text-xs">
                  <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="min-w-0 flex-1 text-muted-foreground">
                    {targetLabel} already knows this
                    {landing.targetContent ? (
                      <> — <span className="text-foreground">“{landing.targetContent}”</span></>
                    ) : null}
                    . Transferring will reinforce that memory instead of adding a duplicate.
                  </p>
                </div>
              ) : landing?.route === "conflicts" ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="min-w-0 flex-1 text-muted-foreground">
                    This may conflict with an existing memory in {targetLabel}
                    {landing.targetContent ? (
                      <> — <span className="text-foreground">“{landing.targetContent}”</span></>
                    ) : null}
                    . Both are kept and flagged for you to resolve.
                  </p>
                </div>
              ) : null}
            </div>
          ) : targetScope === "project" && !targetProjectId ? (
            <p className="py-1 text-sm text-muted-foreground">Pick a target project.</p>
          ) : null}

          {!reinforcing ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={archiveOriginal}
                onChange={(e) => setArchiveOriginal(e.target.checked)}
                className="h-3.5 w-3.5 accent-foreground"
              />
              Archive the original in {item.scope === "project" ? (projects[item.projectId ?? ""] ?? "its project") : memoryScopeLabel(scope)}
            </label>
          ) : null}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <DialogGhostButton onClick={() => onOpenChange(false)}>Cancel</DialogGhostButton>
          <Button
            variant={proposal?.verdict === "context_bound" ? "destructive" : "juicy"}
            size="sm"
            disabled={
              submitting ||
              loadingProposal ||
              !proposal ||
              (!reinforcing && !content.trim()) ||
              (targetScope === "project" && !targetProjectId) ||
              (targetScope === "session" && !targetSessionId)
            }
            onClick={() => void handleConfirm()}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {reinforcing
              ? `Reinforce in ${targetLabel}`
              : proposal?.verdict === "context_bound"
                ? "Transfer anyway"
                : `Create in ${targetLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
