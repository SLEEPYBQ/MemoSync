import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import { OpenLocalLinkProvider } from "../components/messages/shared"
import { ViolatedCitationsMapProvider } from "../components/messages/render-context"
import type { HydratedTranscriptMessage } from "../../shared/types"
import { MemoryBoardLauncherProvider } from "./study/MemoryBoardLauncher"
import {
  areChatTranscriptRowPropsEqual,
  buildResolvedTranscriptRows,
  computeStableResolvedTranscriptRows,
  ChatTranscriptRow,
  getCurrentTurnAssistantMessageIds,
  getTrailingSdkStatus,
  type StableResolvedTranscriptRowsState,
} from "./ChatTranscript"

const ROW_WRAPPER_CLASS = "mx-auto w-full max-w-[800px] pb-5"

// Renders the same pipeline the app uses: buildResolvedTranscriptRows feeding
// ChatTranscriptRow inside the per-row wrapper — keep in sync with
// ChatTranscriptViewport's renderItem.
function renderTranscript(messages: HydratedTranscriptMessage[]) {
  const rows = buildResolvedTranscriptRows(messages, {
    isLoading: false,
    latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
  })
  return renderToStaticMarkup(
    <MemoryBoardLauncherProvider onOpenMemoryBoard={() => undefined}>
      <OpenLocalLinkProvider onOpenLocalLink={() => undefined}>
        <ViolatedCitationsMapProvider value={null}>
          {rows.map((row) => (
            <div key={row.id} className={ROW_WRAPPER_CLASS} data-transcript-row-id={row.id}>
              <ChatTranscriptRow
                row={row}
                toolGroupExpanded={row.kind === "tool-group" ? true : undefined}
                onToolGroupExpandedChange={() => undefined}
                onAskUserQuestionSubmit={() => undefined}
                onExitPlanModeConfirm={() => undefined}
              />
            </div>
          ))}
        </ViolatedCitationsMapProvider>
      </OpenLocalLinkProvider>
    </MemoryBoardLauncherProvider>
  )
}

function countRowWrappers(html: string) {
  return html.split(ROW_WRAPPER_CLASS).length - 1
}

function createToolMessage(id: string, toolId = id): HydratedTranscriptMessage {
  return {
    id,
    kind: "tool",
    toolKind: "bash",
    toolName: "Bash",
    toolId,
    input: {
      command: `echo ${id}`,
      description: `Run ${id}`,
    },
    timestamp: new Date().toISOString(),
  }
}

describe("ChatTranscript", () => {
  test("keeps persisted assistant segments interruptible until the active turn settles", () => {
    const messages = [{
      id: "prompt-1",
      kind: "user_prompt",
      content: "Build it",
      timestamp: new Date().toISOString(),
    }, {
      id: "answer-1",
      kind: "assistant_text",
      text: "Starting with [M-21].",
      timestamp: new Date().toISOString(),
    }, createToolMessage("tool-1"), {
      id: "answer-2",
      kind: "assistant_text",
      text: "Still using [M-21].",
      timestamp: new Date().toISOString(),
    }] as HydratedTranscriptMessage[]

    expect([...getCurrentTurnAssistantMessageIds(messages, true)]).toEqual(["answer-1", "answer-2"])
    expect([...getCurrentTurnAssistantMessageIds(messages, false)]).toEqual([])
  })

  test("does not treat a stale running status after a terminal result as a live reply", () => {
    const messages = [{
      id: "prompt-1",
      kind: "user_prompt",
      content: "Build it",
      timestamp: new Date().toISOString(),
    }, {
      id: "answer-1",
      kind: "assistant_text",
      text: "Done with [M-21].",
      timestamp: new Date().toISOString(),
    }, {
      id: "result-1",
      kind: "result",
      success: true,
      result: "Done",
      durationMs: 1_000,
      timestamp: new Date().toISOString(),
    }] as HydratedTranscriptMessage[]

    expect([...getCurrentTurnAssistantMessageIds(messages, true)]).toEqual([])
  })

  test("renders user attachment cards outside the user bubble", () => {
    const html = renderTranscript([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "What are these files about?",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec.pdf",
          absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
          relativePath: "./.kanna/uploads/spec.pdf",
          contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
          mimeType: "application/pdf",
          size: 1234,
        }],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("spec.pdf")
    expect(html).toContain("application/pdf")
    expect(html).toContain("What are these files about?")
  })

  test("renders uploaded image attachments using the server content URL", () => {
    const html = renderTranscript([
      {
        id: "user-2",
        kind: "user_prompt",
        content: "",
        attachments: [{
          id: "image-1",
          kind: "image",
          displayName: "mock.png",
          absolutePath: "/tmp/project/.kanna/uploads/mock.png",
          relativePath: "./.kanna/uploads/mock.png",
          contentUrl: "/api/projects/project-1/uploads/mock.png/content",
          mimeType: "image/png",
          size: 512,
        }],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("/api/projects/project-1/uploads/mock.png/content")
    expect(html).toContain("mock.png")
    expect(html).toContain("max-h-[300px]")
    expect(html).toContain("min-w-[200px]")
  })

  test("renders images before file attachments and user text", () => {
    const html = renderTranscript([
      {
        id: "user-3",
        kind: "user_prompt",
        content: "Please review these.",
        attachments: [
          {
            id: "image-2",
            kind: "image",
            displayName: "mock.png",
            absolutePath: "/tmp/project/.kanna/uploads/mock.png",
            relativePath: "./.kanna/uploads/mock.png",
            contentUrl: "/api/projects/project-1/uploads/mock.png/content",
            mimeType: "image/png",
            size: 512,
          },
          {
            id: "file-2",
            kind: "file",
            displayName: "spec.pdf",
            absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
            relativePath: "./.kanna/uploads/spec.pdf",
            contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
            mimeType: "application/pdf",
            size: 1234,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("justify-end gap-3")
    expect(html).toContain("justify-end gap-2")
    expect(html).toContain("Please review these.")
  })

  test("hides steer system-message text and renders a steer icon left of the user bubble", () => {
    const html = renderTranscript([
      {
        id: "user-steer-1",
        kind: "user_prompt",
        content: `<system-message>
The user would like you to know the following. Please address the message as you see fit then continue with what you were doing
</system-message>

Please check the latest error first.`,
        steered: true,
        attachments: [],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).not.toContain("The user would like you to know the following.")
    expect(html).toContain("Please check the latest error first.")
    expect(html).toContain('aria-label="Sent mid-turn"')
  })

  test("does not render wrappers for context window updates", () => {
    const html = renderTranscript([
      {
        id: "context-window-1",
        kind: "context_window_updated",
        usage: { usedTokens: 100, maxTokens: 1000, compactsAutomatically: false },
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(0)
  })

  test("renders only the final status row", () => {
    const html = renderTranscript([
      {
        id: "status-1",
        kind: "status",
        status: "working",
        timestamp: new Date().toISOString(),
      },
      {
        id: "status-2",
        kind: "status",
        status: "done",
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("done")
    expect(html).not.toContain("working")
  })

  test("does not render a wrapper for results hidden by context cleared", () => {
    const html = renderTranscript([
      {
        id: "result-1",
        kind: "result",
        success: true,
        result: "Completed",
        durationMs: 100,
        timestamp: new Date().toISOString(),
      },
      {
        id: "context-cleared-1",
        kind: "context_cleared",
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("Context Cleared")
    expect(html).not.toContain("Completed")
  })

  test("does not render wrappers for short successful result rows", () => {
    const html = renderTranscript([
      {
        id: "result-short-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Hey! 👋",
        durationMs: 2562,
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(0)
  })

  test("renders wrappers for long successful result rows", () => {
    const html = renderTranscript([
      {
        id: "result-long-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 61000,
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
  })

  test("does not render wrappers for duplicate system and account rows", () => {
    const html = renderTranscript([
      {
        id: "system-1",
        kind: "system_init",
        provider: "codex",
        model: "gpt-5",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "system-2",
        kind: "system_init",
        provider: "codex",
        model: "gpt-5",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "account-1",
        kind: "account_info",
        accountInfo: { email: "a@example.com", subscriptionType: "Pro" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "account-2",
        kind: "account_info",
        accountInfo: { email: "a@example.com", subscriptionType: "Pro" },
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(2)
  })

  test("renders one wrapper for visible transcript rows", () => {
    const html = renderTranscript([
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Visible text",
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("Visible text")
  })

  test("keeps tool-group row ids stable when the grouped run grows", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const initialRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds,
    })
    const updatedRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
      createToolMessage("tool-3"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    expect(initialRows).toHaveLength(1)
    expect(updatedRows).toHaveLength(1)
    expect(initialRows[0]?.kind).toBe("tool-group")
    expect(updatedRows[0]?.kind).toBe("tool-group")
    expect(initialRows[0]?.id).toBe("tool-group:tool-1")
    expect(updatedRows[0]?.id).toBe("tool-group:tool-1")
  })

  test("groups long-term review Steps 1 and 3 but keeps Working Memory separate", () => {
    const timestamp = new Date().toISOString()
    const messages: HydratedTranscriptMessage[] = [
      {
        id: "proposal-1",
        kind: "memory_proposals",
        proposalsId: "proposal-gate-1",
        candidates: [],
        decision: "empty",
        turn: 3,
        timestamp,
      },
      {
        id: "checkup-1",
        kind: "memory_checkup",
        checkupId: "checkup-gate-1",
        suggestions: [],
        turn: 3,
        timestamp,
      },
      {
        id: "preview-1",
        kind: "memory_preview",
        previewId: "preview-gate-1",
        memories: [],
        decision: "go_on",
        turn: 3,
        timestamp,
      },
    ]

    const rows = buildResolvedTranscriptRows(messages, {
      isLoading: false,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.kind).toBe("memory-changes-review")
    expect(rows[1]?.kind).toBe("single")
    if (rows[1]?.kind !== "single") throw new Error("expected a standalone preview row")
    expect(rows[1].message.kind).toBe("memory_preview")

    const html = renderTranscript(messages)
    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Long-term Memory Management")
    expect(html).toContain("Go to Memory Board")
    expect(html).toContain('data-memory-board-source="chat_long_term"')
    expect(html).toContain("canonical saved memories together")
    expect(html).toContain("Working Memory remains the separate next step")
    expect(html).not.toContain("Prepare Memories for This Turn")
    expect(html.indexOf("Step 1 · Review New Memory Candidates")).toBeLessThan(
      html.indexOf("Step 3 · Review Suggested Changes to Existing Memories"),
    )
    expect(html.indexOf("Step 3 · Review Suggested Changes to Existing Memories")).toBeLessThan(
      html.indexOf("Working Memory for This Turn"),
    )
    expect(html).toContain("Working Memory for This Turn")
    expect(html).not.toContain("Step 2 · Transfer Suggestions")
  })

  test("keeps the memory-changes-review row id stable while Step 2 arrives", () => {
    const timestamp = new Date().toISOString()
    const proposal: HydratedTranscriptMessage = {
      id: "proposal-stable",
      kind: "memory_proposals",
      proposalsId: "proposal-gate-stable",
      candidates: [],
      decision: "empty",
      turn: 4,
      timestamp,
    }
    const initialRows = buildResolvedTranscriptRows([proposal], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })
    const updatedRows = buildResolvedTranscriptRows([
      proposal,
      {
        id: "checkup-stable",
        kind: "memory_checkup",
        checkupId: "checkup-gate-stable",
        suggestions: [],
        turn: 4,
        timestamp,
      },
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(initialRows[0]?.id).toBe("memory-changes-review:proposal-stable")
    expect(updatedRows[0]?.id).toBe(initialRows[0]?.id)
  })

  test("keeps Step 1 reopenable while Step 2 is still active", () => {
    const timestamp = new Date().toISOString()
    const rows = buildResolvedTranscriptRows([
      {
        id: "proposal-reopen-during-checkup",
        kind: "memory_proposals",
        proposalsId: "proposal-gate-reopen-during-checkup",
        candidates: [{ id: "M-01" }],
        decision: "skipped",
        turn: 5,
        timestamp,
      },
      {
        id: "checkup-active",
        kind: "memory_checkup",
        checkupId: "checkup-gate-active",
        pending: true,
        turn: 5,
        timestamp,
      },
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows[0]?.kind).toBe("memory-changes-review")
    if (rows[0]?.kind !== "memory-changes-review") throw new Error("expected memory review row")
    expect(rows[0].canReopenProposals).toBe(true)
    expect(rows[0].canReopenCheckup).toBe(false)
  })

  test("groups collapsible tools across hidden context window updates", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "context-window-1",
        kind: "context_window_updated",
        usage: { usedTokens: 100, maxTokens: 1000, compactsAutomatically: false },
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe("tool-group")
    if (rows[0]?.kind !== "tool-group") throw new Error("unexpected row kind")
    expect(rows[0].messages.map((message) => message.id)).toEqual(["tool-1", "tool-2"])
  })

  test("groups collapsible tools across hidden non-final status rows", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "status-1",
        kind: "status",
        status: "working",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
      {
        id: "status-2",
        kind: "status",
        status: "done",
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]?.kind).toBe("tool-group")
    if (rows[0]?.kind !== "tool-group") throw new Error("unexpected row kind")
    expect(rows[0].messages.map((message) => message.id)).toEqual(["tool-1", "tool-2"])
    expect(rows[1]?.kind).toBe("single")
  })

  test("groups collapsible tools across hidden short result rows", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "result-short-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 1000,
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe("tool-group")
    if (rows[0]?.kind !== "tool-group") throw new Error("unexpected row kind")
    expect(rows[0].messages.map((message) => message.id)).toEqual(["tool-1", "tool-2"])
  })

  test("does not group collapsible tools across visible transcript rows", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Visible text",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(3)
    expect(rows[0]?.kind).toBe("single")
    expect(rows[1]?.kind).toBe("single")
    expect(rows[2]?.kind).toBe("single")
  })

  test("renders grouped tools as expanded across rerenders while streaming when controlled", () => {
    const initialHtml = renderToStaticMarkup(
      <CollapsedToolGroup
        messages={[
          createToolMessage("tool-1"),
          createToolMessage("tool-2"),
        ]}
        isLoading
        expanded
        onExpandedChange={() => undefined}
      />
    )

    const updatedHtml = renderToStaticMarkup(
      <CollapsedToolGroup
        messages={[
          createToolMessage("tool-1"),
          createToolMessage("tool-2"),
          createToolMessage("tool-3"),
        ]}
        isLoading
        expanded
        onExpandedChange={() => undefined}
      />
    )

    expect(initialHtml).toContain("Run tool-1")
    expect(initialHtml).toContain("Run tool-2")
    expect(updatedHtml).toContain("Run tool-1")
    expect(updatedHtml).toContain("Run tool-2")
    expect(updatedHtml).toContain("Run tool-3")
  })

  test("reuses unchanged single row objects across streaming updates", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const previousRows = buildResolvedTranscriptRows([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "Hello",
        timestamp: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Response",
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: true,
      latestToolIds,
    })
    const previousState: StableResolvedTranscriptRowsState = {
      byId: new Map(previousRows.map((row) => [row.id, row])),
      result: previousRows,
    }
    const nextRows = buildResolvedTranscriptRows([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "Hello",
        timestamp: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Response",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-1"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    const stableState = computeStableResolvedTranscriptRows(nextRows, previousState)

    expect(stableState.result[0]).toBe(previousRows[0])
  })

  test("replaces a user row when attachment content changes", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const previousRows = buildResolvedTranscriptRows([
      {
        id: "user-attachment",
        kind: "user_prompt",
        content: "Check this",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec-a.pdf",
          absolutePath: "/tmp/spec-a.pdf",
          relativePath: "./spec-a.pdf",
          contentUrl: "/files/spec-a.pdf",
          mimeType: "application/pdf",
          size: 10,
        }],
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: false,
      latestToolIds,
    })
    const previousState: StableResolvedTranscriptRowsState = {
      byId: new Map(previousRows.map((row) => [row.id, row])),
      result: previousRows,
    }
    const nextRows = buildResolvedTranscriptRows([
      {
        id: "user-attachment",
        kind: "user_prompt",
        content: "Check this",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec-b.pdf",
          absolutePath: "/tmp/spec-b.pdf",
          relativePath: "./spec-b.pdf",
          contentUrl: "/files/spec-b.pdf",
          mimeType: "application/pdf",
          size: 10,
        }],
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: false,
      latestToolIds,
    })

    const stableState = computeStableResolvedTranscriptRows(nextRows, previousState)

    expect(stableState.result[0]).not.toBe(previousRows[0])
  })

  test("reuses unchanged tool-group rows across grouped run growth elsewhere", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const previousRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Done",
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: true,
      latestToolIds,
    })
    const previousState: StableResolvedTranscriptRowsState = {
      byId: new Map(previousRows.map((row) => [row.id, row])),
      result: previousRows,
    }
    const nextRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Done",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-3"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    const stableState = computeStableResolvedTranscriptRows(nextRows, previousState)

    expect(stableState.result[0]).toBe(previousRows[0])
  })
})

describe("areChatTranscriptRowPropsEqual", () => {
  const noop = () => {}
  function singleRowProps(overrides: Partial<Extract<import("./ChatTranscript").ResolvedTranscriptRow, { kind: "single" }>> = {}) {
    const message: HydratedTranscriptMessage = {
      kind: "memory_preview",
      id: "entry-1",
      timestamp: "2026-08-11T00:00:00.000Z",
      previewId: "preview-1",
      memories: [],
    } as never
    return {
      row: {
        kind: "single" as const,
        id: "row-1",
        message,
        index: 3,
        isLoading: false,
        localPath: undefined,
        isFirstSystem: false,
        isFirstAccount: false,
        isLatestAskUserQuestion: false,
        isLatestExitPlanMode: false,
        isLatestTodoWrite: false,
        hideResult: false,
        isFinalStatus: false,
        isStaleMemoryPreview: false,
        ...overrides,
      },
      onToolGroupExpandedChange: noop,
      onAskUserQuestionSubmit: noop,
      onExitPlanModeConfirm: noop,
    }
  }

  test("identical single rows compare equal", () => {
    expect(areChatTranscriptRowPropsEqual(singleRowProps(), singleRowProps())).toBe(true)
  })

  test("a preview card going stale re-renders the row", () => {
    // Regression: this field was missing from the live comparator, so an
    // undecided memory_preview card kept its actionable look after newer
    // turn entries had passed it by.
    expect(
      areChatTranscriptRowPropsEqual(singleRowProps(), singleRowProps({ isStaleMemoryPreview: true }))
    ).toBe(false)
  })
})

describe("single live indicator (status row vs footer)", () => {
  const statusEntry = (id: string, status: string): HydratedTranscriptMessage => ({
    id,
    kind: "status",
    status,
    timestamp: new Date().toISOString(),
  })
  const contextTick = (id: string): HydratedTranscriptMessage => ({
    id,
    kind: "context_window_updated",
    usage: { usedTokens: 1, maxTokens: 10, compactsAutomatically: false },
    timestamp: new Date().toISOString(),
  })

  test("the trailing status row is suppressed while the footer is live", () => {
    const messages = [statusEntry("s1", "requesting"), contextTick("c1")]
    const rows = buildResolvedTranscriptRows(messages, {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
      suppressTrailingStatus: true,
    })
    expect(rows.some((row) => row.kind === "single" && row.message.kind === "status")).toBe(false)
  })

  test("getTrailingSdkStatus reads through invisible entries and stops at visible ones", () => {
    expect(getTrailingSdkStatus([statusEntry("s1", "requesting"), contextTick("c1")])).toBe("requesting")
    expect(
      getTrailingSdkStatus([
        statusEntry("s1", "requesting"),
        {
          id: "t1",
          kind: "assistant_text",
          content: "reply",
          timestamp: new Date().toISOString(),
        } as never,
      ])
    ).toBeUndefined()
    expect(getTrailingSdkStatus([])).toBeUndefined()
  })
})
