import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import {
  deriveMemoryBoardModel,
  MemoryBoardPage,
  type MemoryBoardOverlayMode,
  projectMemoryBoardScopes,
} from "./MemoryBoardPage"
import type { MemoryItem } from "../lib/memoriesApi"
import {
  candidateReviewCohortItems,
  extendCandidateReviewCohort,
} from "../components/messages/MemoryChangesReviewFlow"

function renderMemoryBoard(chatId?: string) {
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, "window", {
    value: {
      location: { search: "" },
      localStorage: { getItem: () => null },
    },
    configurable: true,
    writable: true,
  })

  try {
    return renderToStaticMarkup(createElement(
      MemoryRouter,
      { initialEntries: ["/memory"] },
      createElement<{ overlay?: MemoryBoardOverlayMode }>(MemoryBoardPage, {
        overlay: chatId ? { chatId } : undefined,
      }),
    ))
  } finally {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    })
  }
}

describe("one Memory Board", () => {
  test("shows the current empty chat as a Session drop target", () => {
    const html = renderMemoryBoard("chat-current")

    expect(html).toContain('data-memory-session-drop-target="chat-current"')
    expect(html).toContain("Current session")
    expect(html).toContain("Drop a memory here to keep it only for this session.")
  })

  test("does not invent a Session target when the Board is not bound to a chat", () => {
    const html = renderMemoryBoard()

    expect(html).not.toContain("data-memory-session-drop-target")
  })

  test("has one fixed station order and no current-review/library view switch", async () => {
    const source = await Bun.file(new URL("./MemoryBoardPage.tsx", import.meta.url)).text()
    const candidates = source.indexOf('data-memory-board-section="candidates"')
    const library = source.indexOf('data-memory-board-section="library"')
    const transfer = source.indexOf('data-memory-board-section="transfer"')
    const checkup = source.indexOf('data-memory-board-section="checkup"')

    expect(candidates).toBeGreaterThan(-1)
    expect(candidates).toBeLessThan(library)
    expect(library).toBeLessThan(transfer)
    expect(transfer).toBeLessThan(checkup)
    expect(source).not.toContain("Current turn review")
    expect(source).not.toContain("Full memory library")
    expect(source).not.toContain("border-violet-500/40")
    expect(source).toContain("onChanged={overlay?.onChanged}")
  })

  test("projects candidates as placeholders and the same ids as active memories after acceptance", () => {
    const candidate = {
      id: "M-12",
      content: "Bind the dev server to 0.0.0.0",
      scope: "project",
      status: "candidate",
    } as MemoryItem

    expect(projectMemoryBoardScopes([candidate]).project).toEqual([
      { kind: "candidate-placeholder", item: candidate },
    ])

    const accepted = { ...candidate, status: "active" } as MemoryItem
    expect(projectMemoryBoardScopes([accepted]).project).toEqual([
      { kind: "memory", item: accepted },
    ])
  })

  test("never lets the three-column search or project lens hide authoritative Step 1 candidates", () => {
    const candidate = {
      id: "M-20",
      content: "Review this candidate even while searching",
      scope: "project",
      projectId: "project-other",
      status: "candidate",
    } as MemoryItem
    const active = {
      id: "M-21",
      content: "Matching saved memory",
      scope: "project",
      projectId: "project-current",
      status: "active",
    } as MemoryItem

    const model = deriveMemoryBoardModel([candidate, active], {
      query: "Matching",
      projectFilter: "project-current",
    })

    expect(model.candidateStation.map((item) => item.id)).toEqual([candidate.id])
    expect(model.scopes.project).toEqual([{ kind: "memory", item: active }])
  })

  test("retains only candidates seen by this Board after accept or dismiss", () => {
    const item = (id: string, status: MemoryItem["status"]) => ({
      id,
      content: id,
      scope: "personal",
      status,
    } as MemoryItem)
    const pending = item("M-pending", "candidate")
    const bornActive = item("M-born-active", "active")
    const cohort = extendCandidateReviewCohort(new Set(), [pending, bornActive])

    expect([...cohort]).toEqual([pending.id])
    expect(candidateReviewCohortItems([
      item(pending.id, "active"),
      bornActive,
    ], cohort).map((candidate) => candidate.id)).toEqual([pending.id])
  })

  test("does not offer Unmute for a permanently erased sensitive proposal", async () => {
    const source = await Bun.file(new URL("./MemoryBoardPage.tsx", import.meta.url)).text()
    expect(source).toContain("m.canUnmute ? (")
    expect(source).toContain('t("board:permanentlyRemoved")')
  })
})
