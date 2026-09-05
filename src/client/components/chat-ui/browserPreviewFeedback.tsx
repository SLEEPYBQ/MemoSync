import { AlertTriangle, Home, Loader2, RefreshCw } from "lucide-react"
import { PREVIEW_PROXY_PATH_PREFIX } from "../../../shared/preview-proxy"
import { Button } from "../ui/button"

export interface PreviewVisualSnapshot {
  bodyPresent: boolean
  bodyMeaningfulChildCount: number
  bodyText: string
  rootPresent: boolean
  rootChildCount: number
  rootHasVisualStyle: boolean
  rootText: string
}

export type PreviewInspection = "blank" | "uninspectable" | "visible"
export type BrowserPreviewFeedbackStatus = "idle" | "loading" | "ready" | "warning"

export function effectivePreviewFeedbackStatus(
  feedback: { key: string; status: BrowserPreviewFeedbackStatus },
  navigationKey: string,
  hasAddress: boolean,
): BrowserPreviewFeedbackStatus {
  if (feedback.key === navigationKey) return feedback.status
  return hasAddress ? "loading" : "idle"
}

const PREVIEW_PATH_PATTERN = new RegExp(
  `^${PREVIEW_PROXY_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d{1,5})(?:/|$)`,
)

export function isInspectablePreviewAddress(address: string, currentOrigin: string) {
  try {
    const url = new URL(address)
    if (url.origin !== new URL(currentOrigin).origin) return false
    const match = url.pathname.match(PREVIEW_PATH_PATTERN)
    if (!match) return false
    const port = Number(match[1])
    return Number.isInteger(port) && port > 0 && port <= 65_535
  } catch {
    return false
  }
}

export function classifyPreviewVisualSnapshot(snapshot: PreviewVisualSnapshot): PreviewInspection {
  if (!snapshot.bodyPresent) return "uninspectable"
  if (snapshot.rootPresent) {
    if (
      snapshot.rootChildCount > 0
      || snapshot.rootText.trim().length > 0
      || snapshot.rootHasVisualStyle
      || snapshot.bodyMeaningfulChildCount > 0
      || snapshot.bodyText.trim().length > 0
    ) return "visible"
    return "blank"
  }
  if (snapshot.bodyMeaningfulChildCount > 0 || snapshot.bodyText.trim().length > 0) return "visible"
  return "blank"
}

function rootHasVisibleStyle(root: Element, document: Document) {
  const view = document.defaultView
  if (!view) return false
  const style = view.getComputedStyle(root)
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
  const rect = root.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const hasBackground = style.backgroundImage !== "none"
    || (style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)")
  const hasBorder = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .some((width) => Number.parseFloat(width) > 0)
  return hasBackground || hasBorder
}

export function inspectPreviewDocument(document: Document): PreviewInspection {
  const body = document.body
  if (!body) {
    return classifyPreviewVisualSnapshot({
      bodyPresent: false,
      bodyMeaningfulChildCount: 0,
      bodyText: "",
      rootPresent: false,
      rootChildCount: 0,
      rootHasVisualStyle: false,
      rootText: "",
    })
  }

  const root = document.querySelector("#root, #app, #__next, [data-reactroot]")
  const inertTags = new Set(["BASE", "LINK", "META", "NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE", "TITLE"])
  const bodyMeaningfulChildCount = Array.from(body.children)
    .filter((element) => element !== root && !inertTags.has(element.tagName))
    .length

  return classifyPreviewVisualSnapshot({
    bodyPresent: true,
    bodyMeaningfulChildCount,
    bodyText: body.innerText ?? "",
    rootPresent: Boolean(root),
    rootChildCount: root?.childElementCount ?? 0,
    rootHasVisualStyle: root ? rootHasVisibleStyle(root, document) : false,
    rootText: root instanceof HTMLElement ? root.innerText : (root?.textContent ?? ""),
  })
}

export function BrowserPreviewLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center bg-background"
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading app preview…
      </span>
    </div>
  )
}

export function BrowserPreviewRecovery({
  onRefresh,
  onHome,
}: {
  onRefresh: () => void
  onHome: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
      <div
        data-browser-preview-recovery="true"
        role="status"
        aria-live="polite"
        className="pointer-events-auto w-full max-w-md rounded-xl border border-amber-500/30 bg-background/95 p-3 shadow-lg backdrop-blur"
      >
        <div className="flex gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Preview looks blank</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              The page loaded, but the app did not show visible content. Press Refresh once. If it
              stays blank, tell the assistant: “The Browser server card opens, but the page is blank.”
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="xs" onClick={onRefresh}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={onHome}>
                <Home className="h-3.5 w-3.5" /> Home
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
