// MemoSync brand elements used across the application.
import { PanelLeft } from "lucide-react"
import { useEffect, useState } from "react"
import { DISPLAY_NAME } from "../../shared/branding"
import { cn } from "../lib/utils"
import { MemoSyncIcon } from "./MemoSyncIcon"

export function useBrandName(): string {
  return DISPLAY_NAME
}

interface BrandIconProps {
  className?: string
  animated?: "hover" | "loop" | "none"
}

export function BrandIcon({ className, animated }: BrandIconProps) {
  return <MemoSyncIcon className={className} animated={animated} />
}

const IDLE_FAN_EVERY_MS = 14_000
const IDLE_FAN_HOLD_MS = 1_100

/**
 * The mark as a small living thing: the cards fan out as the app arrives and every
 * so often after, and keep shuffling while an agent is at work. Timers, not a
 * running CSS loop, so an idle window costs nothing between gestures.
 */
export function LivingBrandIcon({ className, busy = false }: { className?: string; busy?: boolean }) {
  const [spread, setSpread] = useState(false)
  useEffect(() => {
    if (busy || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let settle: ReturnType<typeof setTimeout> | undefined
    const fan = () => {
      if (document.hidden) return
      setSpread(true)
      clearTimeout(settle)
      settle = setTimeout(() => setSpread(false), IDLE_FAN_HOLD_MS)
    }
    const first = setTimeout(fan, 500)
    const every = setInterval(fan, IDLE_FAN_EVERY_MS)
    return () => {
      clearTimeout(first)
      clearTimeout(settle)
      clearInterval(every)
      setSpread(false)
    }
  }, [busy])
  return <MemoSyncIcon className={className} animated={busy ? "loop" : "hover"} spread={spread} />
}

export function useBrandFavicon(): void {
  useEffect(() => {
    for (const el of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) el.remove()
    const add = (rel: string, href: string, attrs: Record<string, string> = {}) => {
      const link = document.createElement("link")
      link.rel = rel
      link.href = href
      for (const [key, value] of Object.entries(attrs)) link.setAttribute(key, value)
      document.head.appendChild(link)
    }
    add("icon", "/icon.svg", { type: "image/svg+xml" })
    add("icon", "/favicon.png", { type: "image/png", sizes: "96x96" })
    add("icon", "/icon-192.png", { type: "image/png", sizes: "192x192" })
    add("apple-touch-icon", "/apple-touch-icon.png", { sizes: "180x180" })
  }, [])
}

/**
 * With the sidebar away, the mark itself brings it back: it stays the logo until
 * you reach for it, then becomes the panel icon, so the corner never holds two buttons.
 */
export function SidebarRevealButton({ onClick, label, className }: { onClick: () => void; label: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "group/reveal relative hidden size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground md:flex dark:hover:bg-white/[0.08]",
        className,
      )}
    >
      <LivingBrandIcon className="size-[22px] transition-opacity duration-150 group-hover/reveal:opacity-0 group-focus-visible/reveal:opacity-0" />
      <PanelLeft className="absolute size-[18px] opacity-0 transition-opacity duration-150 group-hover/reveal:opacity-100 group-focus-visible/reveal:opacity-100" />
    </button>
  )
}
