import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  BrowserPreviewLoading,
  BrowserPreviewRecovery,
  classifyPreviewVisualSnapshot,
  effectivePreviewFeedbackStatus,
  isInspectablePreviewAddress,
} from "./browserPreviewFeedback"

describe("Browser preview feedback", () => {
  it("inspects only the same-origin MemoSync path preview", () => {
    const origin = "https://memosync.example.com"

    expect(isInspectablePreviewAddress(`${origin}/__memosync/preview/5173/`, origin)).toBe(true)
    expect(isInspectablePreviewAddress(`${origin}/__memosync/preview/5173/apartments/42`, origin)).toBe(true)
    expect(isInspectablePreviewAddress("https://other.example/__memosync/preview/5173/", origin)).toBe(false)
    expect(isInspectablePreviewAddress(`${origin}/ordinary-page`, origin)).toBe(false)
    expect(isInspectablePreviewAddress(`${origin}/__memosync/preview/99999/`, origin)).toBe(false)
    expect(isInspectablePreviewAddress("not a URL", origin)).toBe(false)
  })

  it("calls an empty app root blank but accepts text, elements, and visual roots", () => {
    expect(classifyPreviewVisualSnapshot({
      bodyPresent: true,
      bodyMeaningfulChildCount: 0,
      bodyText: "",
      rootPresent: true,
      rootChildCount: 0,
      rootHasVisualStyle: false,
      rootText: "",
    })).toBe("blank")

    expect(classifyPreviewVisualSnapshot({
      bodyPresent: true,
      bodyMeaningfulChildCount: 0,
      bodyText: "",
      rootPresent: true,
      rootChildCount: 1,
      rootHasVisualStyle: false,
      rootText: "",
    })).toBe("visible")

    expect(classifyPreviewVisualSnapshot({
      bodyPresent: true,
      bodyMeaningfulChildCount: 0,
      bodyText: "Rendered directly",
      rootPresent: true,
      rootChildCount: 0,
      rootHasVisualStyle: false,
      rootText: "Rendered directly",
    })).toBe("visible")

    expect(classifyPreviewVisualSnapshot({
      bodyPresent: true,
      bodyMeaningfulChildCount: 0,
      bodyText: "",
      rootPresent: true,
      rootChildCount: 0,
      rootHasVisualStyle: true,
      rootText: "",
    })).toBe("visible")
  })

  it("does not call an unavailable document blank", () => {
    expect(classifyPreviewVisualSnapshot({
      bodyPresent: false,
      bodyMeaningfulChildCount: 0,
      bodyText: "",
      rootPresent: false,
      rootChildCount: 0,
      rootHasVisualStyle: false,
      rootText: "",
    })).toBe("uninspectable")
  })

  it("shows loading immediately when navigation changes and accepts the matching load", () => {
    expect(effectivePreviewFeedbackStatus(
      { key: "old-address-0", status: "ready" },
      "new-address-0",
      true,
    )).toBe("loading")
    expect(effectivePreviewFeedbackStatus(
      { key: "new-address-0", status: "ready" },
      "new-address-0",
      true,
    )).toBe("ready")
    expect(effectivePreviewFeedbackStatus(
      { key: "old-address-0", status: "warning" },
      "-0",
      false,
    )).toBe("idle")
  })

  it("renders immediate loading and non-blocking recovery actions", () => {
    const loading = renderToStaticMarkup(<BrowserPreviewLoading />)
    const recovery = renderToStaticMarkup(
      <BrowserPreviewRecovery onRefresh={() => undefined} onHome={() => undefined} />,
    )

    expect(loading).toContain("Loading app preview")
    expect(recovery).toContain("Preview looks blank")
    expect(recovery).toContain("The Browser server card opens, but the page is blank.")
    expect(recovery).toContain(" Refresh</button>")
    expect(recovery).toContain(" Home</button>")
    expect(recovery).toContain('data-browser-preview-recovery="true"')
  })
})
