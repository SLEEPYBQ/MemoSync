import { translateUiText, translateServerUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { MemoryBadge } from "./MemoryBadge"
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
  type TransferTargetBody,
} from "../../lib/memoriesApi"
import { workspaceApi } from "../../lib/workspaceApi"
import { useMemoryStore } from "../../stores/memoryStore"
import { isMemoryScope, MEMORY_SCOPE_CHIP_CLASSES, memoryScopeLabel } from "../../lib/memoryCitations"
import { defaultTransferScope, transferScopeDisabled } from "../../lib/transferTarget"
import { cn } from "../../lib/utils"

const VERDICT_META: Record<TransferProposal["verdict"], { label: string; className: string }> = {
  as_is: { get label() { return t("memory:transfersAsIs") }, className: "bg-success/10 text-success-foreground dark:text-success-foreground" },
  rewrite: { get label() { return t("memory:adaptedForTheTarget") }, className: "bg-cand-surface text-cand-fg dark:text-cand-fg" },
  context_bound: { get label() { return t("memory:contextBoundNotRecommended") }, className: "border-cand-border bg-cand-surface text-cand-fg" },
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

export function buildManualTransferCommitBody(input: {
  proposal: TransferProposal
  target: Pick<TransferTargetBody, "targetScope" | "targetProjectId" | "targetSessionId">
  content: string
  archiveOriginal: boolean
  surface?: MemoryControlSurface
}): Parameters<typeof memoriesApi.transfer>[1] {
  const { proposal, target, archiveOriginal, surface } = input
  const content = input.content.trim()
  return {
    ...target,
    sourceVersion: proposal.sourceVersion,
    content,
    detail: proposal.detail,
    abstractionLevel: proposal.abstractionLevel,
    verdict: proposal.verdict,
    edited: content !== proposal.content,
    archiveOriginal,
    landingRoute: proposal.landing.route,
    landingTargetId: proposal.landing.targetId,
    landingTargetVersion: proposal.landing.targetVersion,
    rule: proposal.portable,
    applicability: proposal.applicability,
    surface,
  }
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
  useI18n()
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
  const [proposalTargetKey, setProposalTargetKey] = useState<string | null>(null)
  const [loadingProposal, setLoadingProposal] = useState(false)
  const [content, setContent] = useState("")
  const [archiveOriginal, setArchiveOriginal] = useState(defaultArchiveOriginal)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scope = isMemoryScope(item.scope) ? item.scope : "session"
  const targetKey = JSON.stringify([targetScope, targetProjectId ?? null, targetSessionId ?? null])
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
    setProposal(null)
    setProposalTargetKey(null)
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
      setProposalTargetKey(null)
      return
    }
    if (targetScope === "session" && !targetSessionId) {
      setProposal(null)
      setProposalTargetKey(null)
      return
    }
    let cancelled = false
    const requestedTargetKey = targetKey
    setLoadingProposal(true)
    setProposal(null)
    setProposalTargetKey(null)
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
        setProposalTargetKey(requestedTargetKey)
        setContent(p.content)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("memory:transferPreviewFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoadingProposal(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id, targetKey])

  const landing = proposal?.landing
  const reinforcing = landing?.route === "reinforces"

  async function handleConfirm() {
    if (!proposal || proposalTargetKey !== targetKey || (!reinforcing && !content.trim())) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await memoriesApi.transfer(
        item.id,
        buildManualTransferCommitBody({
          proposal,
          target: {
            targetScope,
            targetProjectId: targetScope === "project" ? targetProjectId : undefined,
            targetSessionId: targetScope === "session" ? targetSessionId : undefined,
          },
          content,
          archiveOriginal,
          surface,
        }),
      )
      await loadAll()
      onDone?.(created)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("memory:transferFailed"))
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
        ? (sessionLabel ?? t("memory:thisSession"))
        : t("common:personal")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="memory-ui @container max-w-lg rounded-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {t("memory:transfer2")}{item.id}
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            {targetLabel}
          </DialogTitle>
          <DialogDescription>
            {t("memory:reviewHowThisMemoryShouldBeAdaptedBeforeCreatingIt")}{targetLabel}.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-sm">
            <MemoryBadge
              className={cn(
                "mt-0.5 inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-4",
                MEMORY_SCOPE_CHIP_CLASSES[scope],
              )}
            >
              {item.id}
            </MemoryBadge>
            <span className="min-w-0 flex-1 text-muted-foreground">{item.content}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("memory:to")}</span>
            {targetScope === "session" ? (
              // The session is fixed by the drop — no picker, just name it.
              <MemoryBadge
                className={cn(
                  "inline-flex items-center rounded-md border px-1.5 py-0.5 text-sm",
                  MEMORY_SCOPE_CHIP_CLASSES.session,
                )}
              >
                {memoryScopeLabel("session")} · {sessionLabel ?? targetSessionId}
              </MemoryBadge>
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
                    <option value="">{t("memory:chooseProject")}</option>
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
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("memory:abstractingAndReInstantiating")}</p>
          ) : proposal && proposalTargetKey === targetKey ? (
            <div className="flex flex-col gap-2">
              <MemoryBadge
                className={cn(
                  "inline-flex w-fit items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                  VERDICT_META[proposal.verdict].className,
                )}
              >
                {VERDICT_META[proposal.verdict].label}
              </MemoryBadge>

              {/* The encode → decode pipeline (Transfer design 2026-08-08):
                  show the abstract rule the source was encoded to (dashed =
                  metadata, never a standalone item), then the localized form
                  the developer edits. Skipped for as_is (the two coincide) —
                  the item just moves verbatim. */}
              {proposal.verdict !== "as_is" && proposal.portable !== proposal.content ? (
                <div className="flex flex-col gap-1.5">
                  <div className="rounded-lg border border-dashed border-border bg-muted/20 px-2.5 py-1.5">
                    <p className="text-[11px] font-medium text-muted-foreground">{t("memory:abstractRule")}</p>
                    <p className="text-sm text-muted-foreground">{proposal.portable}</p>
                    {proposal.applicability ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                        <span className="font-medium">{t("memory:appliesWhen")}</span> {proposal.applicability}
                      </p>
                    ) : null}
                  </div>
                  <ArrowDown className="mx-auto h-3.5 w-3.5 text-muted-foreground/60" />
                </div>
              ) : null}

              <div className="flex flex-col gap-1">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t("memory:in")}{targetLabel}
                </p>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={3}
                  disabled={reinforcing}
                  className={cn("text-sm", reinforcing && "opacity-50")}
                />
              </div>
              {proposal.note ? <p className="text-sm leading-relaxed text-muted-foreground">{translateServerUiText(proposal.noteUiText, proposal.note)}</p> : null}

              {/* Landing: how the instantiated form meets what already lives
                  in the target context (same vocabulary as capture). */}
              {landing?.route === "reinforces" ? (
                <div className="flex items-start gap-2 py-1 text-sm">
                  <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-foreground dark:text-success-foreground" />
                  <p className="min-w-0 flex-1 text-muted-foreground">
                    {targetLabel} {t("memory:alreadyKnowsThis")}{landing.targetContent ? (
                      <> — <span className="text-foreground">“{landing.targetContent}”</span></>
                    ) : null}
                    {t("memory:transferringWillReinforceThatMemoryInsteadOfAddingADuplicate")}</p>
                </div>
              ) : landing?.route === "conflicts" ? (
                <div className="flex items-start gap-2 rounded-lg border border-cand-border bg-cand-surface px-2.5 py-2 text-sm">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cand-fg dark:text-cand-fg" />
                  <p className="min-w-0 flex-1 text-muted-foreground">
                    {t("memory:thisMayConflictWithAnExistingMemoryIn")}{targetLabel}
                    {landing.targetContent ? (
                      <> — <span className="text-foreground">“{landing.targetContent}”</span></>
                    ) : null}
                    {t("memory:bothAreKeptAndFlaggedForYouToResolve")}</p>
                </div>
              ) : null}
            </div>
          ) : targetScope === "project" && !targetProjectId ? (
            <p className="py-1 text-sm text-muted-foreground">{t("memory:pickATargetProject")}</p>
          ) : null}

          {!reinforcing ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={archiveOriginal}
                onChange={(e) => setArchiveOriginal(e.target.checked)}
                className="h-3.5 w-3.5 accent-foreground"
              />
              {t("memory:archiveTheOriginalIn")}{item.scope === "project" ? (projects[item.projectId ?? ""] ?? t("memory:itsProject")) : memoryScopeLabel(scope)}
            </label>
          ) : null}

          {error ? <p className="text-xs text-destructive">{translateUiText(error)}</p> : null}
        </DialogBody>
        <DialogFooter>
          <DialogGhostButton onClick={() => onOpenChange(false)}>{t("common:cancel")}</DialogGhostButton>
          <Button
            variant="default"
            size="sm"
            disabled={
              submitting ||
              loadingProposal ||
              !proposal ||
              proposalTargetKey !== targetKey ||
              (!reinforcing && !content.trim()) ||
              (targetScope === "project" && !targetProjectId) ||
              (targetScope === "session" && !targetSessionId)
            }
            onClick={() => void handleConfirm()}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {reinforcing
              ? t("memory:reinforceInValue0", { v0: targetLabel })
              : proposal?.verdict === "context_bound"
                ? t("memory:transferAnyway")
                : t("memory:createInValue0", { v0: targetLabel })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
