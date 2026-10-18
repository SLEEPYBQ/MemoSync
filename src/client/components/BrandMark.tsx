// MemoSync brand elements used across the application.
import { useEffect } from "react"
import { DISPLAY_NAME } from "../../shared/branding"
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
