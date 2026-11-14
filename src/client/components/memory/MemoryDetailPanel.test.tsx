import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemoryItem } from "../../lib/memoriesApi"
import { buildReviewedSensitiveCandidatePatch, MemoryDetailPanel } from "./MemoryDetailPanel"
import { TranscriptRenderOptionsProvider } from "../messages/render-context"

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

test("team details are read-only and hide ordinary editing and actions", () => {
  const item: MemoryItem = { ...sensitiveCandidate, content: "Synthetic team rule", sensitive: false, status: "active", scope: "project", projectId: "P1", team: { id: "T-abcd" } }
  const render = (memory: MemoryItem, readonly = false) => renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{ readonly }}><MemoryDetailPanel item={memory} allItems={[memory]} onClose={() => {}} onUpdated={() => {}} onAccept={async () => {}} onArchive={async () => {}} /></TranscriptRenderOptionsProvider>)
  const active = render(item)
  expect(active).toContain('data-team-rule-text')
  expect(active).toContain('>Synthetic team rule</p>')
  expect(active).not.toContain("<textarea")
  expect(active).toContain(">Project</span>")
  expect(active).toContain('title="Shared in .memosync/team.md"')
  expect(active.indexOf(">Project</span>")).toBeLessThan(active.indexOf('title="Shared in .memosync/team.md"'))
  expect(active).toContain("Propose a change")
  expect(active).toContain("Turn off on this machine")
  expect(active).toContain("Remove from team file…")
  expect(active).not.toContain("detailed form")
  expect(active).not.toContain("Transfer")
  expect(active).not.toContain("Not sensitive")
  const archived = render({ ...item, status: "archived" })
  expect(archived).toContain("Turned off on this machine.")
  expect(archived).toContain("Turn back on")
  expect(archived).not.toContain("Propose a change")
  const drift = render({ ...item, fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }] })
  const callout = drift.slice(drift.indexOf("changed after this memory"), drift.indexOf("data-team-rule-text"))
  expect(callout).toContain("Still applies")
  expect(callout).toContain("Propose a change")
  expect(callout).not.toContain(">Archive</button>")
  const readonly = render(item, true)
  expect(readonly).not.toContain("Propose a change")
  expect(readonly).not.toContain("Turn off on this machine")
  expect(readonly).not.toContain("Remove from team file…")
})

test("file reference detail shows changed and removed-source actions only on editable items", () => {
  const render = (item: MemoryItem, readonly = false) => renderToStaticMarkup(
    <TranscriptRenderOptionsProvider value={{ readonly }}>
      <MemoryDetailPanel item={item} allItems={[item]} onClose={() => {}} onUpdated={() => {}} onAccept={async () => {}} onArchive={async () => {}} />
    </TranscriptRenderOptionsProvider>,
  )
  const item: MemoryItem = { ...sensitiveCandidate, content: "Synthetic rule", sensitive: false, status: "active",
    fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }, { path: "src/stable.ts", kind: "mention", drift: null }] }
  const changed = render(item)
  expect(changed).toContain("Referenced files")
  expect(changed).toContain("src/auth.ts")
  expect(changed).toContain("Unchanged")
  expect(changed).toContain("Still applies")
  expect(changed).toContain("changed after this memory was recorded. Does the rule still hold?")
  expect(changed).toContain('<code class="break-all font-mono text-[11px]">src/auth.ts</code>')
  expect(changed.indexOf("changed after this memory")).toBeLessThan(changed.indexOf("<textarea"))
  expect(changed).not.toContain("Keep as its own memory")
  const missing = render({ ...item, fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "missing" }] })
  expect(missing).toContain("was moved or deleted after this memory was recorded.")
  expect(missing).toContain("Still applies")
  const multiple = render({ ...item, fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }, { path: "src/config.ts", kind: "mention", drift: "missing" }] })
  expect(multiple).toContain("2 files this memory refers to changed after it was recorded.")
  const removed = render({ ...item, fileRefs: [{ path: "AGENTS.md", kind: "source", drift: "line_removed" }] })
  expect(removed).toContain("This line was removed from")
  expect(removed).toContain(">AGENTS.md</code>. Keep following it anyway?")
  expect(removed).toContain("Imported from")
  expect(removed).toContain("Keep as its own memory")
  expect(removed).not.toContain("Still applies")
  expect(render({ ...item, status: "archived" })).not.toContain("Still applies")
  expect(render(item, true)).not.toContain("Still applies")
  expect(render({ ...item, status: "archived" })).toContain("Referenced files")
  const removedItem: MemoryItem = { ...item, fileRefs: [{ path: "AGENTS.md", kind: "source", drift: "line_removed" }] }
  expect(render({ ...removedItem, status: "archived" })).not.toContain("Keep as its own memory")
  expect(render(removedItem, true)).not.toContain("Keep as its own memory")
})

test("file references render relative change time and fall back when the timestamp is invalid", () => {
  const now = Date.now()
  const item: MemoryItem = { ...sensitiveCandidate, content: "Synthetic rule", sensitive: false, status: "active",
    fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed", changedAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString() }] }
  const render = (memory: MemoryItem) => renderToStaticMarkup(<MemoryDetailPanel item={memory} allItems={[memory]} onClose={() => {}} onUpdated={() => {}} onAccept={async () => {}} onArchive={async () => {}} />)
  expect(render(item)).toContain("Changed 3 days ago")
  expect(render({ ...item, fileRefs: [{ ...item.fileRefs![0]!, changedAt: "invalid" }] })).toContain(">Changed</span>")
})

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
