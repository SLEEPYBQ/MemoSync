import { useEffect, useRef, useState } from "react"
import { Ban, Check, Clock3, Eye, FilePenLine, Hand, ListTodo, Loader2, ShieldOff, Sparkles, type LucideIcon } from "lucide-react"
import type { ChatHarnessSnapshot, NativeExecutionPolicy, PolicyStatus } from "../../../shared/harness-capabilities"
import { t, useI18n } from "../../i18n"
import { cn } from "../../lib/utils"
import { NativeUiInfo } from "../native-ui/NativeUiInfo"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

export function executionPolicyKey(policy: NativeExecutionPolicy | null): string {
  if (!policy) return "unconfirmed"
  switch (policy.engine) {
    case "claude": return `claude:${policy.permissionMode}`
    case "codex": return `codex:${policy.approvalPolicy}:${policy.approvalsReviewer}:${policy.sandbox}`
    case "pi": return `pi:${policy.toolGate}`
    case "opencode": return `opencode:${policy.permission}`
  }
}

export function executionPolicyLabel(policy: NativeExecutionPolicy | null): string {
  if (!policy) return t("harness:notApplied")
  switch (policy.engine) {
    case "claude":
      switch (policy.permissionMode) {
        case "default": return t("harness:manual")
        case "acceptEdits": return t("harness:acceptEdits")
        case "dontAsk": return t("harness:dontAsk")
        case "bypassPermissions": return t("harness:bypassPermissions")
        case "auto": return t("harness:auto")
      }
    case "codex": {
      // The presets Codex desktop shows; any other combination keeps its explicit parts.
      if (policy.sandbox === "workspace-write" && policy.approvalsReviewer === "auto_review") return t("harness:codexAutoApprove")
      if (policy.sandbox === "workspace-write" && policy.approvalPolicy === "on-request") return t("harness:codexAskApproval")
      if (policy.sandbox === "danger-full-access" && policy.approvalPolicy === "never") return t("harness:codexFullAccess")
      if (policy.sandbox === "read-only" && policy.approvalPolicy === "never") return t("harness:readOnly")
      const sandbox = policy.sandbox === "read-only" ? t("harness:readOnly") : policy.sandbox === "workspace-write" ? t("harness:workspaceWrite") : t("harness:fullAccess")
      const approval = policy.approvalsReviewer === "auto_review" ? t("harness:autoReview") : policy.approvalPolicy === "never" ? t("harness:dontAsk") : policy.approvalPolicy === "untrusted" ? t("harness:askUntrusted") : t("harness:ask")
      return `${sandbox} / ${approval}`
    }
    case "pi":
      return policy.toolGate === "read-only" ? t("harness:readOnlyTools") : policy.toolGate === "ask" ? t("harness:askTools") : t("harness:allowTools")
    case "opencode":
      return policy.permission === "ask" ? t("harness:ask") : policy.permission === "allow" ? t("harness:allowTools") : t("harness:denyTools")
  }
}

export function policyStatusLabel(status: PolicyStatus): string {
  switch (status) {
    case "applied": return t("harness:applied")
    case "pending": return t("harness:pending")
    case "partial": return t("harness:partial")
    case "rejected": return t("harness:rejected")
    case "unknown": return t("harness:unknown")
    case "unsupported": return t("harness:unsupported")
  }
}

/** One icon per meaning, shared across engines. */
export function policyIcon(policy: NativeExecutionPolicy): LucideIcon {
  switch (policy.engine) {
    case "claude": return policy.permissionMode === "default" ? Hand : policy.permissionMode === "acceptEdits" ? FilePenLine
      : policy.permissionMode === "auto" ? Sparkles : policy.permissionMode === "dontAsk" ? Ban : ShieldOff
    case "codex": return policy.approvalsReviewer === "auto_review" ? Sparkles : policy.sandbox === "read-only" ? Eye
      : policy.sandbox === "danger-full-access" ? ShieldOff : Hand
    case "pi": return policy.toolGate === "read-only" ? Eye : policy.toolGate === "ask" ? Hand : ShieldOff
    case "opencode": return policy.permission === "deny" ? Ban : policy.permission === "ask" ? Hand : ShieldOff
  }
}

/** What choosing the mode means, in one line. Risky modes state their consequence here. */
function policyDescription(policy: NativeExecutionPolicy): string {
  switch (policy.engine) {
    case "claude": return t(`harness:desc_claude_${policy.permissionMode}`)
    case "codex":
      if (policy.approvalsReviewer === "auto_review") return t("harness:desc_codex_auto")
      if (policy.sandbox === "danger-full-access") return t("harness:desc_codex_full")
      if (policy.sandbox === "read-only") return t("harness:desc_codex_readOnly")
      return t("harness:desc_codex_ask")
    case "pi": return t(`harness:desc_pi_${policy.toolGate}`)
    case "opencode": return t(`harness:desc_opencode_${policy.permission}`)
  }
}

const CLAUDE_ORDER = ["auto", "default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]

interface Props {
  chatId: string
  snapshot: ChatHarnessSnapshot
  disabled?: boolean
  onChange: (policy: NativeExecutionPolicy, expectedRevision: number) => Promise<unknown>
  /** Engines whose own mode list includes Plan (Claude) show it here. */
  planMode?: boolean
  onPlanModeChange?: (planMode: boolean) => void
}

interface Row { key: string; label: string; description: string; icon: LucideIcon; unavailable: boolean; reason?: string; select: () => void }

/** Show the launch selection before startup; active native application comes from snapshots. */
export function ExecutionPolicyControl({ chatId, snapshot, disabled, onChange, planMode, onPlanModeChange }: Props) {
  useI18n()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ownerRef = useRef<object>({})
  useEffect(() => {
    const owner = {}
    ownerRef.current = owner
    setSaving(false)
    setError(null)
    setOpen(false)
    return () => { if (ownerRef.current === owner) ownerRef.current = {} }
  }, [chatId])
  const { policy, capabilities } = snapshot
  const effectiveKey = executionPolicyKey(policy.effective)
  const desiredKey = executionPolicyKey(policy.desired)
  const currentLabel = executionPolicyLabel(policy.effective)
  // Nothing older is in effect: the selection is simply what the session starts or continues with.
  const configuringLaunch = snapshot.nativeRuntime === "absent" || policy.effective === null && policy.status === "pending"
  const startingRuntime = snapshot.nativeRuntime === "starting"
  const hasProblem = policy.status === "partial" || policy.status === "rejected" || policy.status === "unknown" || policy.status === "unsupported"
  const policyKey = configuringLaunch ? desiredKey : effectiveKey
  const planInMenu = capabilities.engine === "claude" && Boolean(onPlanModeChange)
  const planSelected = planInMenu && Boolean(planMode)
  const selectedKey = planSelected ? "plan" : policyKey
  const shownPolicy = configuringLaunch || startingRuntime ? policy.desired : policy.effective
  const displayLabel = planSelected ? t("harness:plan") : configuringLaunch || startingRuntime ? executionPolicyLabel(policy.desired) : currentLabel
  const DisplayIcon = planSelected ? ListTodo : shownPolicy ? policyIcon(shownPolicy) : Hand
  const processBoundaries = policy.boundaries.filter(boundary => boundary.boundary === "existing-processes" && boundary.status !== "applied")

  async function choose(next: NativeExecutionPolicy) {
    if (planInMenu) onPlanModeChange?.(false)
    setOpen(false)
    if (saving || disabled || executionPolicyKey(next) === policyKey) return
    const owner = ownerRef.current
    setSaving(true)
    setError(null)
    try {
      await onChange(next, policy.desiredRevision)
    } catch (err) {
      if (ownerRef.current === owner) { setError(err instanceof Error ? err.message : t("harness:changeFailed")); setOpen(true) }
    } finally {
      if (ownerRef.current === owner) setSaving(false)
    }
  }

  const rows: Row[] = capabilities.executionPolicies.map(choice => ({
    key: executionPolicyKey(choice.policy),
    label: executionPolicyLabel(choice.policy),
    description: policyDescription(choice.policy),
    icon: policyIcon(choice.policy),
    unavailable: choice.availability === "unavailable",
    reason: choice.reason,
    select: () => void choose(choice.policy),
  }))
  if (planInMenu) rows.push({ key: "plan", label: t("harness:plan"), description: t("harness:desc_claude_plan"), icon: ListTodo, unavailable: false,
    select: () => { onPlanModeChange?.(true); setOpen(false) } })
  if (capabilities.engine === "claude") rows.sort((a, b) => CLAUDE_ORDER.indexOf(a.key.replace(/^claude:/, "")) - CLAUDE_ORDER.indexOf(b.key.replace(/^claude:/, "")))

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" aria-label={t("harness:permissions")} disabled={disabled} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        {saving || startingRuntime ? <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : <DisplayIcon aria-hidden className="size-3.5" />}
        <span className="max-w-32 truncate">{displayLabel}</span>
        {startingRuntime ? <span className="sr-only">{t("harness:starting")}</span> : (!configuringLaunch || hasProblem) && policy.status !== "applied" ? <Clock3 aria-label={policyStatusLabel(policy.status)} className="size-3 text-muted-foreground/70" /> : null}
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" collisionPadding={12}
      onKeyDown={event => {
        const row = /^[1-9]$/.test(event.key) ? rows[Number(event.key) - 1] : undefined
        if (row && !row.unavailable && !saving) { event.preventDefault(); row.select() }
      }}
      className="w-[300px] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain p-1.5">
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-1.5">
        <h3 className="flex-1 text-xs text-muted-foreground">{t("harness:mode")}</h3>
        {capabilities.engine === "pi" ? <NativeUiInfo label={t("harness:mode")}>{t("harness:piBoundary")}</NativeUiInfo> : null}
      </div>
      {startingRuntime ? <div role="status" className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />{t("harness:starting")}</div> : configuringLaunch && hasProblem ? <div role="status" className="mx-1 mb-1.5 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5"><p>{policyStatusLabel(policy.status)}</p>{policy.reason ? <p>{policy.reason}</p> : null}</div> : !configuringLaunch && (effectiveKey !== desiredKey || policy.status !== "applied") ? <div className="mx-1 mb-1.5 rounded-lg bg-muted/60 px-3 py-2">
        <dl className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">{t("harness:effective")}</dt><dd className="text-right font-medium">{currentLabel}</dd></div>
          {effectiveKey !== desiredKey ? <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">{t("harness:requested")}</dt><dd className="text-right">{executionPolicyLabel(policy.desired)}</dd></div> : null}
        </dl>
        {policy.status !== "applied" ? <div role="status" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 aria-hidden className="size-3" />{policyStatusLabel(policy.status)}{policy.reason ? <NativeUiInfo label={policyStatusLabel(policy.status)}>{policy.reason}</NativeUiInfo> : null}</div> : null}
      </div> : null}
      <div role="menu" aria-label={t("harness:mode")}>
        {rows.length === 0 ? <p className="px-3 py-4 text-[13px] text-muted-foreground">{t("harness:noVerifiedPolicies")}</p> : null}
        {rows.map((row, index) => {
          const selected = row.key === selectedKey
          return <div key={row.key} className="flex items-center rounded-lg">
            <button type="button" role="menuitemradio" aria-checked={selected} aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
              disabled={row.unavailable || saving || disabled} onClick={row.select}
              className={cn("flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40", selected && "bg-muted/60")}>
              <row.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block text-[13px] leading-5">{row.label}</span><span className="block text-xs leading-4 text-muted-foreground">{row.description}</span></span>
              <span className="mt-0.5 flex w-9 shrink-0 items-center justify-end gap-2 text-xs text-muted-foreground">
                {selected ? <Check aria-hidden className="size-3.5 text-foreground" /> : row.key === desiredKey && !planSelected ? <Clock3 aria-label={t("harness:requested")} className="size-3.5" /> : null}
                {index < 9 ? <span aria-hidden className="tabular-nums">{index + 1}</span> : null}
              </span>
            </button>
            {row.unavailable ? <NativeUiInfo label={row.label}>{row.reason ?? t("harness:capabilityUnverified")}</NativeUiInfo> : null}
          </div>
        })}
      </div>
      {processBoundaries.length ? <div className="mt-1.5 flex flex-wrap gap-1 border-t border-border px-2 pb-1 pt-2">
        {processBoundaries.map(boundary => {
          const label = t("harness:existingProcesses")
          return <div key={boundary.boundary} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground"><span className="size-1 rounded-full bg-current opacity-50" />{label}<NativeUiInfo label={label}>{policyStatusLabel(boundary.status)}{boundary.reason ? `\n${boundary.reason}` : ""}</NativeUiInfo></div>
        })}
      </div> : null}
      {error ? <p role="alert" className="px-3 py-2 text-xs leading-5 text-destructive">{error}</p> : null}
    </PopoverContent>
  </Popover>
}
