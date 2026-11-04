import { useEffect, useRef, useState } from "react"
import { Check, Loader2, Shield } from "lucide-react"
import type { ChatHarnessSnapshot, NativeExecutionPolicy, PolicyStatus } from "../../../shared/harness-capabilities"
import { t, useI18n } from "../../i18n"
import { cn } from "../../lib/utils"
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
        case "default": return t("harness:ask")
        case "acceptEdits": return t("harness:acceptEdits")
        case "dontAsk": return t("harness:dontAsk")
        case "bypassPermissions": return t("harness:bypassPermissions")
        case "auto": return t("harness:autoReview")
      }
    case "codex": {
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

interface Props {
  chatId: string
  snapshot: ChatHarnessSnapshot
  disabled?: boolean
  onChange: (policy: NativeExecutionPolicy, expectedRevision: number) => Promise<unknown>
}

/** Native state comes exclusively from snapshots. A command ACK never marks it applied. */
export function ExecutionPolicyControl({ chatId, snapshot, disabled, onChange }: Props) {
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
  const pending = policy.status === "pending"

  async function choose(next: NativeExecutionPolicy) {
    if (saving || disabled) return
    const owner = ownerRef.current
    setSaving(true)
    setError(null)
    try {
      await onChange(next, policy.desiredRevision)
    } catch (err) {
      if (ownerRef.current === owner) setError(err instanceof Error ? err.message : t("harness:changeFailed"))
    } finally {
      if (ownerRef.current === owner) setSaving(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("harness:permissions")}
          disabled={disabled}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {saving || pending ? <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Shield aria-hidden className="size-3.5" />}
          <span className="max-w-40 truncate">{currentLabel}</span>
          {policy.status !== "applied" ? <span className="text-[11px]">{policyStatusLabel(policy.status)}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={12} className="max-h-[var(--radix-popover-content-available-height)] w-80 overflow-y-auto overscroll-contain p-2">
        <div className="space-y-2 px-2 pb-3 pt-1">
          <h3 className="text-sm font-semibold">{t("harness:permissions")}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("harness:effective")}</dt>
            <dd className="break-words">{currentLabel}</dd>
            {desiredKey !== effectiveKey ? <>
              <dt className="text-muted-foreground">{t("harness:requested")}</dt>
              <dd className="break-words">{executionPolicyLabel(policy.desired)}</dd>
            </> : null}
          </dl>
          {policy.status !== "applied" || policy.reason ? <p role="status" className="text-xs leading-5 text-muted-foreground">{policyStatusLabel(policy.status)}{policy.reason ? `: ${policy.reason}` : ""}</p> : null}
          {capabilities.engine === "pi" ? <p className="text-xs leading-5 text-muted-foreground">{t("harness:piBoundary")}</p> : null}
        </div>
        <div className="space-y-1 border-t border-border pt-2" aria-label={t("harness:availablePolicies")}>
          {capabilities.executionPolicies.length === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">{t("harness:noVerifiedPolicies")}</p> : null}
          {capabilities.executionPolicies.map(choice => {
            const key = executionPolicyKey(choice.policy)
            const unavailable = choice.availability !== "available"
            const label = executionPolicyLabel(choice.policy)
            return (
              <button
                key={choice.id}
                type="button"
                disabled={unavailable || saving || disabled}
                onClick={() => void choose(choice.policy)}
                title={choice.reason}
                className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", key === effectiveKey && "bg-muted")}
              >
                <span className="mt-0.5 size-4 shrink-0">{key === effectiveKey ? <Check aria-hidden className="size-4" /> : null}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{label}</span>
                  {key === desiredKey && key !== effectiveKey ? <span className="block text-xs text-muted-foreground">{t("harness:requested")}</span> : null}
                  {unavailable || choice.reason ? <span className="block text-xs leading-5 text-muted-foreground">{choice.reason ?? t("harness:capabilityUnverified")}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
        {policy.boundaries.some(boundary => boundary.status !== "applied") ? <div className="mt-2 space-y-1 border-t border-border px-2 pt-2">
          {policy.boundaries.filter(boundary => boundary.status !== "applied").map(boundary => <p key={boundary.boundary} className="text-xs leading-5 text-muted-foreground">
            {boundary.boundary === "host-dispatch" ? t("harness:hostTools") : boundary.boundary === "native-runtime" ? t("harness:nativeSession") : t("harness:existingProcesses")}: {policyStatusLabel(boundary.status)}{boundary.reason ? `: ${boundary.reason}` : ""}
          </p>)}
        </div> : null}
        {error ? <p role="alert" className="mt-2 px-2 text-xs leading-5 text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
  )
}
