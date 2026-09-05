import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import {
  deriveBoardReviewStepNumbers,
  deriveMemoryBoardModel,
  MemoryBoardPage,
  type MemoryBoardOverlayMode,
  memoryBoardSectionVisibility,
  openingMemoryBoardGateModel,
  openingMemoryBoardCopy,
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
        overlay: chatId ? { blocking: false, chatId } : undefined,
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

describe("manual Memory Board backlog copy", () => {
  test("keeps the opening gate blocking while the mid-session view remains closable", async () => {
    const source = await Bun.file(new URL("./MemoryBoardPage.tsx", import.meta.url)).text()
    expect(source).toContain("gateModel.showContinue")
    expect(source).toContain("overlay && !overlay.blocking && overlay.onClose")
  })

  test("shows only the approved sentence while pending work remains", async () => {
    expect(openingMemoryBoardGateModel({ pending: 4, submitting: false })).toEqual({
      message: "Your first message is waiting. Handle 4 pending long-term memory items below. After this review, the same message continues and Working Memory is selected separately for this turn.",
      showContinue: false,
      continueLabel: null,
    })

    const source = await Bun.file(new URL("./MemoryBoardPage.tsx", import.meta.url)).text()
    expect(source).toContain('data-opening-memory-board-gate="true"')
    expect(source).not.toContain("Waiting message:")
    expect(source).not.toContain("Candidates {overlay.status.pending.candidates}")
    expect(source).not.toContain("Handle ${overlay.status.pending.total} pending first")
    expect(source).not.toContain("rounded-lg border border-border bg-muted/20")
  })

  test("renders no alternate banner copy before the authoritative pending count loads", () => {
    expect(openingMemoryBoardGateModel({ pending: null, submitting: false })).toEqual({
      message: null,
      showContinue: false,
      continueLabel: null,
    })
  })

  test("keeps Continue hidden until the current prompt's full Long-term review is server-ready", () => {
    expect(openingMemoryBoardGateModel({
      pending: 0,
      openingPhase: "preparing",
      submitting: false,
    })).toEqual({
      message: "Your first message is waiting. Review its Long-term Memory steps below. Working Memory will be selected separately after this review.",
      showContinue: false,
      continueLabel: null,
    })
    expect(openingMemoryBoardGateModel({
      pending: 0,
      openingPhase: "long_term_ready",
      submitting: false,
    })).toEqual({
      message: "Your first message is waiting. Long-term Memory review is complete. Continue with the same message, then select Working Memory separately for this turn.",
      showContinue: true,
      continueLabel: "Continue with this message",
    })
    expect(openingMemoryBoardGateModel({
      pending: 2,
      openingPhase: "long_term_ready",
      submitting: false,
    }).showContinue).toBe(true)
  })
})

describe("opening Long-term Memory review", () => {
  test("keeps Transfer and Checkup at fixed steps in the one Board", () => {
    expect(deriveBoardReviewStepNumbers({ hasTransfer: true })).toEqual({ transfer: 2, checkup: 3 })
    expect(deriveBoardReviewStepNumbers({ hasTransfer: false })).toEqual({ transfer: 2, checkup: 3 })
  })

  test("opens the same complete Memory Board from the blocking and manual entrances", () => {
    expect(memoryBoardSectionVisibility(true)).toEqual({
      pendingBacklog: true,
      candidates: true,
      searchAndCreate: true,
      activeLibrary: true,
      archived: true,
      muted: true,
      markdown: true,
      workingMemory: false,
    })
    expect(memoryBoardSectionVisibility(false)).toEqual(memoryBoardSectionVisibility(true))
  })

  test("explains that the sent message is waiting and Working Memory comes next", () => {
    const copy = openingMemoryBoardCopy(0)
    expect(copy.heading).toBe("Long-term Memory Management")
    expect(copy.message).toContain("first message is waiting")
    expect(copy.message).toContain("Working Memory")
    expect(copy.cta).toBe("Continue with this message")
  })
})

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
    expect(source).toContain("onChanged={overlay?.onBacklogChanged}")
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
    expect(source).toContain("Permanently removed")
  })
})
