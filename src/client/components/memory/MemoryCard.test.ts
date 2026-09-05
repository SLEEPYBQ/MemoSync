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
