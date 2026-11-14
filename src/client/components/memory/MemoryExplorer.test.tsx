import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemoryItem } from "../../lib/memoriesApi"
import { MemoryExplorer, memoryMatchesLens, type MemoryLens } from "./MemoryExplorer"

const item = { id: "M-01", content: "Synthetic rule", status: "active", scope: "project", projectId: "P1", fileRefs: [{ path: "src/a.ts", kind: "mention", drift: "changed" }] } as MemoryItem

function render(items: MemoryItem[], lens: MemoryLens) {
  return renderToStaticMarkup(<MemoryExplorer items={items} lens={lens} onLensChange={() => {}} query="" onQueryChange={() => {}} projectTitles={{}} chatTitles={{}} pendingCount={0} archivedCount={0} mutedCount={null} onOpenReview={() => {}} />)
}

test("drift lens counts active drift and remains visible while selected at zero", () => {
  const clean = { ...item, fileRefs: [{ path: "src/a.ts", kind: "mention", drift: null }] } as MemoryItem
  expect(render([clean], { kind: "all" })).not.toContain("Needs check")
  expect(render([clean], { kind: "drift" })).toContain("Needs check")
  const two = render([item, { ...item, id: "M-02" }], { kind: "drift" })
  expect(two).toContain("Needs check")
  expect(two).toContain("text-cand-fg")
  expect(memoryMatchesLens(item, { kind: "drift" })).toBe(true)
  expect(memoryMatchesLens(clean, { kind: "drift" })).toBe(false)
  expect(render([{ ...item, status: "candidate" }], { kind: "all" })).toContain("Needs check")
  expect(render([{ ...item, status: "archived" }], { kind: "all" })).not.toContain("Needs check")
})
