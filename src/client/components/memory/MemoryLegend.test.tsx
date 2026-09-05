import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryLegend } from "./MemoryLegend"
import { TRACE_DOT_CLASSES, FRESHNESS_CLASSES } from "./memoryVocab"

describe("MemoryLegend", () => {
  test("names the red status dot as 'violated' — not a recent-update marker", () => {
    const html = renderToStaticMarkup(createElement(MemoryLegend))
    // The dot swatch uses the same class the card renders, and it sits next to
    // the 'violated' meaning — the misreading the review flagged.
    expect(html).toContain(TRACE_DOT_CLASSES.violated)
    expect(html).toContain("acted against it last time")
    // Freshness ('changed', blue) is the actual "recent update" marker, kept
    // visually distinct from the red dot.
    expect(html).toContain(FRESHNESS_CLASSES.changed)
    expect(html).toContain("Edited since your last visit")
  })

  test("explains every scope by default", () => {
    const html = renderToStaticMarkup(createElement(MemoryLegend))
    expect(html).toContain("Applies across all your projects")
    expect(html).toContain("Applies only inside this project")
  })

  test("sections prop subsets the vocabulary (capture card shows scope only)", () => {
    const html = renderToStaticMarkup(createElement(MemoryLegend, { sections: ["scope"] }))
    // status + freshness groups are omitted
    expect(html).not.toContain("acted against it last time")
    expect(html).not.toContain("Edited since your last visit")
  })
})
