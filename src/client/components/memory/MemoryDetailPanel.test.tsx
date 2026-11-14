import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemoryItem } from "../../lib/memoriesApi"
import { buildReviewedSensitiveCandidatePatch, MemoryDetailPanel } from "./MemoryDetailPanel"

const sensitiveCandidate = {
  id: "M-07",
  content: "deploy key sk-secret",
  detail: "owner@example.com",
  abstractionLevel: "concrete",
  sensitive: true,
  scope: "personal",
  type: "fact",
  status: "candidate",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  usageCount: 0,
  reinforcedCount: 0,
  version: 1,
} satisfies MemoryItem

test("a sensitive Candidate only builds an atomic accept patch from a changed reviewed draft", () => {
  expect(buildReviewedSensitiveCandidatePatch(sensitiveCandidate, {
    content: sensitiveCandidate.content,
    detail: sensitiveCandidate.detail ?? "",
  })).toBeNull()
  expect(buildReviewedSensitiveCandidatePatch(sensitiveCandidate, { content: "  ", detail: "" })).toBeNull()
  expect(buildReviewedSensitiveCandidatePatch(sensitiveCandidate, {
    content: sensitiveCandidate.content,
    detail: "owner [REDACTED]",
  })).toBeNull()
  expect(buildReviewedSensitiveCandidatePatch(sensitiveCandidate, {
    content: "deploy key [REDACTED]",
    detail: "",
  })).toEqual({
    content: "deploy key [REDACTED]",
    detail: "",
    status: "active",
  })
})

test("the Board detail surface offers sanitize, manual review, and dismiss without a raw Accept or separate Save", () => {
  const html = renderToStaticMarkup(
    <MemoryDetailPanel
      item={sensitiveCandidate}
      allItems={[sensitiveCandidate]}
      onClose={() => {}}
      onUpdated={() => {}}
      onAccept={async () => {}}
      onArchive={async () => {}}
      surface="board"
    />,
  )

  expect(html).toContain("Prepare sanitized")
  expect(html).toContain("Accept reviewed")
  expect(html).toContain("Dismiss")
  expect(html).toContain("disabled")
  expect(html).not.toContain(">Accept</button>")
  expect(html).not.toContain(">Save</button>")
})

for (const status of ["active", "archived"] as const) {
  test(`${status} detail shows only valid movement and archive actions`, () => {
    const item: MemoryItem = {
      ...sensitiveCandidate,
      id: "M-01",
      content: "Synthetic navigation rule",
      detail: "",
      sensitive: false,
      status,
    }
    const html = renderToStaticMarkup(
      <MemoryDetailPanel
        item={item}
        allItems={[item]}
        onClose={() => {}}
        onUpdated={() => {}}
        onAccept={async () => {}}
        onArchive={async () => {}}
        surface="board"
      />,
    )
    expect(html.includes("Transfer…")).toBe(status === "active")
    expect(html.includes(">Archive</button>")).toBe(status === "active")
    expect(html.includes("Restore this memory from Archived before moving or transferring it.")).toBe(status === "archived")
    const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
    for (const scope of ["Personal", "Project"]) {
      const button = buttons.find(value => value.endsWith(`>${scope}</button>`))
      expect(button).toBeDefined()
      expect(button!.includes('disabled=""')).toBe(status === "archived")
    }
  })
}
