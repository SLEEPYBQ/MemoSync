import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryCard } from "./MemoryCard"
import type { MemoryItem } from "../../lib/memoriesApi"

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "M-01",
    content: "Run tests with bun test only",
    scope: "project",
    type: "constraint",
    status: "active",
    createdAt: "",
    updatedAt: "",
    usageCount: 0,
    citedInCurrentSession: 0,
    abstractionLevel: "contextual",
    sensitive: false,
    projectId: "p-1",
    ...over,
  } as MemoryItem
}

describe("MemoryCard", () => {
  test("shows a clock badge with remaining days", () => {
    const html = renderToStaticMarkup(createElement(MemoryCard, { item: item({ expiresAt: new Date(Date.now() + 6 * 86400000 - 1000).toISOString() }), variant: "scoped" }))
    expect(html).toContain("6 days left")
    expect(html).toContain("lucide-clock")
  })
  test("uses today only below 24 hours", () => {
    const originalNow = Date.now
    const now = Date.parse("2030-01-01T12:00:00.000Z")
    Date.now = () => now
    try {
      const exactDay = renderToStaticMarkup(createElement(MemoryCard, { item: item({ expiresAt: new Date(now + 86400000).toISOString() }), variant: "scoped" }))
      const underDay = renderToStaticMarkup(createElement(MemoryCard, { item: item({ expiresAt: new Date(now + 86399000).toISOString() }), variant: "scoped" }))
      expect(exactDay).toContain("1 day left")
      expect(underDay).toContain("Expires today")
    } finally { Date.now = originalNow }
  })
  test("rings a corrected audit dot", () => {
    const html = renderToStaticMarkup(createElement(MemoryCard, { item: item({ lastTraceLabel: "violated", lastTraceCorrected: true }), variant: "scoped" }))
    expect(html).toContain("outline-offset-1")
    expect(html).toContain("corrected by you")
  })
  test("shows the origin label chip when provided (which project/chat this binds to)", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryCard, { item: item(), variant: "scoped", originLabel: "MemoSync" }),
    )
    expect(html).toContain("MemoSync")
  })

  test("shows a health dot for the latest trace verdict", () => {
    const violated = renderToStaticMarkup(
      createElement(MemoryCard, { item: item({ lastTraceLabel: "violated" }), variant: "scoped" }),
    )
    expect(violated).toContain("last trace: violated")
    const none = renderToStaticMarkup(createElement(MemoryCard, { item: item(), variant: "scoped" }))
    expect(none).not.toContain("last trace")
  })

  test("shows a NEW/CHANGED pill for items touched since the last board visit", () => {
    const fresh = renderToStaticMarkup(
      createElement(MemoryCard, { item: item(), variant: "scoped", freshness: "new" }),
    )
    expect(fresh).toContain("new")
    const changed = renderToStaticMarkup(
      createElement(MemoryCard, { item: item(), variant: "scoped", freshness: "changed" }),
    )
    expect(changed).toContain("changed")
    const plain = renderToStaticMarkup(createElement(MemoryCard, { item: item(), variant: "scoped" }))
    expect(plain).not.toContain("changed")
  })

  test("shows age and captured-in provenance when provided", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryCard, {
        item: item({ createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() }),
        variant: "scoped",
        capturedIn: "访问百桥",
      }),
    )
    expect(html).toContain("2h")
    expect(html).toContain("访问百桥")
  })
})
