import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GuidePanelSurface } from "./GuidePanelSurface"

describe("GuidePanelSurface", () => {
  test("keeps a read-only Guide panel hit-testable so its visible scrollbar can scroll", () => {
    const html = renderToStaticMarkup(
      <GuidePanelSurface readOnly className="overflow-y-auto">
        <button type="button">Demo action</button>
      </GuidePanelSurface>,
    )
    const openingTag = html.slice(0, html.indexOf(">") + 1)

    expect(openingTag).toContain("overflow-y-auto")
    expect(openingTag).toContain("touch-pan-y")
    expect(openingTag).not.toContain("pointer-events-none")
    expect(openingTag).toContain('data-guide-read-only="true"')
  })

  test("owns every Guide panel instead of disabling a scroll ancestor", async () => {
    const source = await Bun.file(new URL("./GuideTour.tsx", import.meta.url)).text()

    for (const panel of [
      "board",
      "studySessionSetup",
      "studySessions",
      "studyBrief",
      "studySubmit",
      "studyPostSession",
    ]) {
      expect(source).toContain(`step?.panel === "${panel}"`)
    }
    expect(source).toContain("{sidePanel ? (")
    expect(source.match(/<GuidePanelSurface/g)?.length ?? 0).toBeGreaterThanOrEqual(7)
    expect(source).not.toContain('!panelInteractive && "pointer-events-none')
  })
})
