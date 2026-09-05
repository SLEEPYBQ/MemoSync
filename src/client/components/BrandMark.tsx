// Condition-aware brand mark. The baseline arms (auto/static) are the study's
// comparison agents, not the MemoSync product — showing them under the
// MemoSync name and flower icon would tell participants they are using the
// same system twice. Baselines render a neutral "Agent" identity instead;
// every brand surface (sidebar, navbar, tab title, favicon, empty state) goes
// through this module. Until the condition policy resolves the mark renders
// nothing at all, so a baseline page never flashes the MemoSync identity.
import { useEffect } from "react"
import { Bot } from "lucide-react"
import { DISPLAY_NAME } from "../../shared/branding"
import { useConditionPolicyResolved } from "../lib/conditionApi"
import { MemoSyncIcon } from "./MemoSyncIcon"

export const NEUTRAL_BRAND_NAME = "Agent"

/** "" while the policy is unresolved — callers skip title writes until then. */
export function useBrandName(): string {
  const policy = useConditionPolicyResolved()
  if (policy === null) return ""
  return policy.condition === "memosync" ? DISPLAY_NAME : NEUTRAL_BRAND_NAME
}

interface BrandIconProps {
  className?: string
  animated?: "hover" | "loop" | "none"
}

export function BrandIcon({ className, animated }: BrandIconProps) {
  const policy = useConditionPolicyResolved()
  if (policy === null) return null
  if (policy.condition === "memosync") return <MemoSyncIcon className={className} animated={animated} />
  return <Bot aria-hidden="true" className={className} />
}

/**
 * Install the condition's favicon. index.html ships with NO icon links at all
 * (a static link would flash the MemoSync flower on a baseline tab before
 * React loads) — both identities get their icon here, on policy resolve.
 */
export function useBrandFavicon(): void {
  const policy = useConditionPolicyResolved()
  const identity = policy === null ? null : policy.condition === "memosync" ? "memosync" : "neutral"
  useEffect(() => {
    if (identity === null) return
    for (const el of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) el.remove()
    const add = (rel: string, href: string, attrs: Record<string, string> = {}) => {
      const link = document.createElement("link")
      link.rel = rel
      link.href = href
      for (const [key, value] of Object.entries(attrs)) link.setAttribute(key, value)
      document.head.appendChild(link)
    }
    if (identity === "memosync") {
      add("icon", "/icon.svg", { type: "image/svg+xml" })
      add("icon", "/favicon.png", { type: "image/png", sizes: "96x96" })
      add("icon", "/icon-192.png", { type: "image/png", sizes: "192x192" })
      add("apple-touch-icon", "/apple-touch-icon.png", { sizes: "180x180" })
    } else {
      add("icon", "/agent-icon.svg", { type: "image/svg+xml" })
    }
  }, [identity])
}
