import { describe, expect, test } from "bun:test"
import { processTranscriptMessages } from "./parseTranscript"
import { getLatestToolIds } from "../app/derived"
import type { TranscriptEntry } from "../../shared/types"

function entry(partial: Omit<TranscriptEntry, "_id" | "createdAt">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...partial,
  } as TranscriptEntry
}

describe("processTranscriptMessages", () => {
  test("preserves the durable opening-Board owner on every Long-term parent", () => {
    const openingReviewId = "opening-review-1"
    const messages = processTranscriptMessages([
      entry({ kind: "memory_proposals", proposalsId: "p-1", openingReviewId, turn: 1, candidates: [] }),
      entry({ kind: "memory_transfer", transferId: "t-1", openingReviewId, turn: 1, suggestions: [] }),
      entry({ kind: "memory_checkup", checkupId: "c-1", openingReviewId, turn: 1 }),
    ])

    expect(messages.map((message) => (
      "openingReviewId" in message ? message.openingReviewId : undefined
    ))).toEqual([openingReviewId, openingReviewId, openingReviewId])
  })
  test("hydrates tool results onto prior tool calls", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: "/Users/jake/Projects/kanna\n",
      }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toBe("/Users/jake/Projects/kanna\n")
  })

  test("hydrates ask-user-question results with typed answers", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-2",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("hydrates discarded prompt tool results", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-3",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { discarded: true },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ discarded: true })
  })

  test("preserves attachments on hydrated user prompts", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "user_prompt",
        content: "Please inspect these.",
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
      }),
    ])

    expect(messages[0]?.kind).toBe("user_prompt")
    if (messages[0]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[0].attachments).toHaveLength(1)
    expect(messages[0].attachments?.[0]?.relativePath).toBe("./.kanna/uploads/spec.pdf")
  })

  test("preserves context window update entries", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "context_window_updated",
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          compactsAutomatically: true,
        },
      }),
    ])

    expect(messages[0]?.kind).toBe("context_window_updated")
    if (messages[0]?.kind !== "context_window_updated") throw new Error("unexpected message")
    expect(messages[0].usage.maxTokens).toBe(258_400)
    expect(messages[0].usage.compactsAutomatically).toBe(true)
  })

  test("preserves failed memory trace terminal metadata", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "memory_trace",
        labels: [],
        status: "failed",
        errorClass: "TypeError",
        dropped: 2,
        turn: 4,
      }),
    ])

    expect(messages[0]).toMatchObject({
      kind: "memory_trace",
      labels: [],
      status: "failed",
      errorClass: "TypeError",
      dropped: 2,
      turn: 4,
    })
  })

  test("preserves an automatic Transfer landing target version when folding streamed results", () => {
    const transferId = "transfer-1"
    const messages = processTranscriptMessages([
      entry({ kind: "memory_transfer", transferId, turn: 2, pending: true, suggestions: [] }),
      entry({
        kind: "memory_transfer_result",
        transferId,
        done: true,
        suggestions: [{
          sourceId: "M-09",
          sourceContent: "Use pnpm in Alpha Shop",
          sourceScope: "project",
          sourceVersion: 7,
          sourceLabel: "Alpha Shop",
          rule: "Use the selected package manager consistently",
          content: "Use pnpm in this project",
          abstractionLevel: "contextual",
          suggestedScope: "project",
          landing: {
            route: "reinforces",
            targetId: "M-02",
            targetContent: "Use pnpm",
            targetVersion: 3,
          },
        }],
      }),
    ])

    const transfer = messages.find((message) => message.kind === "memory_transfer")
    expect(transfer).toMatchObject({
      kind: "memory_transfer",
      pending: false,
      suggestions: [{ landing: { targetId: "M-02", targetVersion: 3 } }],
    })
  })

  test("preserves structured Claude ask-user-question results when a later echoed tool result arrives", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-3",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: "User has answered your questions: \"Provider?\"=\"Codex\".",
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: {
            questions: [{ question: "Provider?" }],
            answers: { "Provider?": "Codex" },
          },
        }),
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("folds a reopened memory review into the same parents and ignores stale relevance", () => {
    const proposalsId = "proposals-1"
    const checkupId = "checkup-1"
    const previewId = "preview-1"
    const messages = processTranscriptMessages([
      entry({ kind: "memory_proposals", proposalsId, turn: 1, pending: true, candidates: [] }),
      entry({ kind: "memory_proposals_result", proposalsId, candidates: [{ id: "M-02" }] }),
      entry({ kind: "memory_proposals_decision", proposalsId, decision: "skipped" }),
      entry({ kind: "memory_checkup", checkupId, turn: 1, pending: true }),
      entry({
        kind: "memory_checkup_result",
        checkupId,
        suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "possibly old" }],
      }),
      entry({ kind: "memory_checkup_decision", checkupId, decision: "skipped" }),
      entry({
        kind: "memory_preview",
        previewId,
        turn: 1,
        memories: [{ id: "M-01", content: "old set", scope: "personal" }],
      }),
      entry({ kind: "memory_preview_relevance", previewId, revision: 0, relevant: [{ id: "M-01", why: "old" }] }),
      entry({ kind: "memory_preparation_reset", previewId, revision: 1, from: "proposals", proposalsId, checkupId }),
      entry({ kind: "memory_proposals_decision", proposalsId, decision: "reviewed" }),
      entry({ kind: "memory_preparation_reset", previewId, revision: 1, from: "checkup", proposalsId, checkupId }),
      entry({ kind: "memory_checkup_result", checkupId, suggestions: [] }),
      entry({
        kind: "memory_preview_update",
        previewId,
        revision: 1,
        memories: [
          { id: "M-01", content: "old set", scope: "personal" },
          { id: "M-02", content: "newly accepted", scope: "project" },
        ],
        relevancePending: true,
      }),
      // A late answer from revision 0 must not annotate revision 1.
      entry({
        kind: "memory_preview_relevance",
        previewId,
        revision: 0,
        relevant: [{ id: "M-01", why: "stale" }],
        expectedUses: [{ id: "M-01", expectedUse: "Ignore this stale plan." }],
      }),
      entry({
        kind: "memory_preview_relevance",
        previewId,
        revision: 1,
        relevant: [{ id: "M-02", why: "current" }],
        expectedUses: [{ id: "M-02", expectedUse: "Apply the newly accepted memory." }],
      }),
    ])

    const proposals = messages.find((message) => message.kind === "memory_proposals")
    const checkup = messages.find((message) => message.kind === "memory_checkup")
    const preview = messages.find((message) => message.kind === "memory_preview")
    expect(proposals).toMatchObject({ decision: "reviewed", pending: false, candidates: [{ id: "M-02" }] })
    expect(checkup).toMatchObject({ pending: false, waiting: false, suggestions: [] })
    expect(preview).toMatchObject({
      refreshing: false,
      refreshVersion: 1,
      relevancePending: true,
      relevant: [{ id: "M-02", why: "current" }],
      expectedUses: [{ id: "M-02", expectedUse: "Apply the newly accepted memory." }],
    })
    if (preview?.kind !== "memory_preview") throw new Error("unexpected preview")
    expect(preview.memories.map((memory) => memory.id)).toEqual(["M-01", "M-02"])
  })

  test("hydrates Checkup failed lanes with the matching parent", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "memory_checkup", checkupId: "c-failed", turn: 2, pending: true }),
      entry({
        kind: "memory_checkup_result",
        checkupId: "c-failed",
        suggestions: [],
        failedKinds: ["conflict", "staleness"],
      }),
      entry({ kind: "memory_checkup_decision", checkupId: "c-failed", decision: "failed" }),
    ])

    expect(messages).toContainEqual(expect.objectContaining({
      kind: "memory_checkup",
      checkupId: "c-failed",
      pending: false,
      suggestions: [],
      failedKinds: ["conflict", "staleness"],
      decision: "failed",
    }))
  })

  test("a Step 1 reopen leaves Step 2 waiting instead of replaying its old pending skeleton", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "memory_proposals", proposalsId: "p-1", turn: 1, candidates: [{ id: "M-02" }] }),
      entry({ kind: "memory_proposals_decision", proposalsId: "p-1", decision: "skipped" }),
      entry({ kind: "memory_checkup", checkupId: "c-1", turn: 1, pending: true }),
      entry({ kind: "memory_checkup_result", checkupId: "c-1", suggestions: [] }),
      entry({
        kind: "memory_preview",
        previewId: "v-1",
        turn: 1,
        memories: [{ id: "M-01", content: "seed", scope: "personal" }],
      }),
      entry({
        kind: "memory_preparation_reset",
        previewId: "v-1",
        revision: 1,
        from: "proposals",
        proposalsId: "p-1",
        checkupId: "c-1",
      }),
    ])

    const checkup = messages.find((message) => message.kind === "memory_checkup")
    expect(checkup).toMatchObject({ pending: false, waiting: true, suggestions: undefined })
  })
})

describe("getLatestToolIds", () => {
  test("returns the latest unresolved special tool ids", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "tool-2",
          input: {
            todos: [{ content: "Implement adapter", status: "in_progress", activeForm: "Implementing adapter" }],
          },
        },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: messages[0]?.kind === "tool" ? messages[0].id : null,
      ExitPlanMode: null,
      TodoWrite: messages[1]?.kind === "tool" ? messages[1].id : null,
    })
  })

  test("ignores discarded special tools when choosing the latest active id", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: { discarded: true, answers: {} },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-2",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { discarded: true },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: null,
      ExitPlanMode: null,
      TodoWrite: null,
    })
  })
})
