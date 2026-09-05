import { afterEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemoryItem } from "../../lib/memoriesApi"
import { useMemoryStore } from "../../stores/memoryStore"
import { CurrentTurnMemoryCitationProvider, MemoryCitationChip, TurnInterruptContext } from "./shared"

const ITEM = {
  id: "M-77",
  content: "Always change the cart through CartContext actions",
  scope: "project",
  type: "constraint",
  status: "active",
} as unknown as MemoryItem

// renderToStaticMarkup reads zustand's INITIAL snapshot (v5 server render), so
// the test seeds the initial state in place instead of setState.
function seedInitialItems(items: MemoryItem[]) {
  const initial = useMemoryStore.getInitialState()
  initial.items.length = 0
  initial.items.push(...items)
}

afterEach(() => {
  seedInitialItems([])
})

function renderChip({ active, currentTurn }: { active: boolean; currentTurn: boolean }) {
  seedInitialItems([ITEM])
  const chip = <MemoryCitationChip id="M-77" />
  const scoped = currentTurn ? (
    <CurrentTurnMemoryCitationProvider>{chip}</CurrentTurnMemoryCitationProvider>
  ) : (
    chip
  )
  return renderToStaticMarkup(
    <TurnInterruptContext.Provider value={{ active, interrupt: () => {}, resume: async () => {} }}>
      {scoped}
    </TurnInterruptContext.Provider>,
  )
}

// 2026-08-19 evening revision (C1): the per-memory stop entry must be
// DISCOVERABLE — a visible button right next to the chip while the turn runs,
// not only a row inside the hover card.
test("a current-turn chip shows a visible stop button while the turn runs", () => {
  const html = renderChip({ active: true, currentTurn: true })
  expect(html).toContain("Stop the turn over this memory")
  expect(html).toContain('data-memory-interrupt="visible"')
  expect(html).toContain(">Stop</button>")
})

test("historical chips get no visible stop button", () => {
  expect(renderChip({ active: true, currentTurn: false })).not.toContain(
    "Stop the turn over this memory",
  )
})

test("a settled turn gets no visible stop button", () => {
  expect(renderChip({ active: false, currentTurn: true })).not.toContain(
    "Stop the turn over this memory",
  )
})
