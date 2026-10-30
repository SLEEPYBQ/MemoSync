import { describe, expect, test } from "bun:test"
import { deriveChatPreview, deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveMemoryRecordTranscript, deriveSidebarData } from "./read-models"
import { createEmptyState } from "./events"
import type { TranscriptEntry } from "../shared/types"

describe("read models", () => {
  test("notification preview selects the latest visible assistant reply, excluding memory and tool noise", () => {
    const entries: TranscriptEntry[] = [
      { _id: "user", createdAt: 0, kind: "user_prompt", content: "USER PROMPT" },
      { _id: "old", createdAt: 1, kind: "assistant_text", text: "Old reply" },
      { _id: "latest", createdAt: 2, kind: "assistant_text", text: "## Done\n\n- **Fixed** `retry_count_ms` in [the router](https://example.com).\n- [x] Tests passed." },
      { _id: "memory", createdAt: 3, kind: "memory_preview", previewId: "p", task: "PRIVATE TASK", memories: [{ id: "M-1", content: "PRIVATE MEMORY", scope: "project" }] },
      { _id: "trace", createdAt: 4, kind: "memory_trace", summary: "PRIVATE TRACE", labels: [] },
      { _id: "hidden", createdAt: 5, kind: "assistant_text", text: "PRIVATE HIDDEN", hidden: true },
      { _id: "tool", createdAt: 6, kind: "tool_call", tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t", input: { command: "PRIVATE COMMAND" } } },
      { _id: "result", createdAt: 7, kind: "tool_result", toolId: "t", content: "PRIVATE RESULT" },
      { _id: "status", createdAt: 8, kind: "status", status: "PRIVATE STATUS" },
    ]
    expect(deriveChatPreview(entries)).toEqual({ lastAgentMessagePreview: "Done Fixed retry_count_ms in the router. Tests passed." })
    expect(deriveChatPreview(entries.filter((entry) => entry.kind !== "assistant_text"))).toBeNull()
    expect(deriveChatPreview([entries[5]!])).toBeNull()
    expect(deriveChatPreview([])).toBeNull()
  })

  test("notification preview never reaches back past the latest prompt, so a failed turn has none", () => {
    const entries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Deploy it" },
      { _id: "a1", createdAt: 2, kind: "assistant_text", text: "Deployment succeeded." },
      { _id: "u2", createdAt: 3, kind: "user_prompt", content: "Now roll back" },
      { _id: "r2", createdAt: 4, kind: "result", subtype: "error", isError: true, durationMs: 1, result: "provider error" },
    ]
    expect(deriveChatPreview(entries)).toBeNull()
    expect(deriveChatPreview([...entries, { _id: "a2", createdAt: 5, kind: "assistant_text", text: "Rolled back." }])).toEqual({ lastAgentMessagePreview: "Rolled back." })
  })

  test("notification preview strips markdown before collapsing whitespace and truncating to 140 characters", () => {
    const text = "## Result\n\n> **Done**\n```ts\nconst x = 1\n```\n" + "word ".repeat(40)
    const plain = "Result Done const x = 1 " + "word ".repeat(40).trim()
    expect(deriveChatPreview([{ _id: "a", createdAt: 1, kind: "assistant_text", text }])).toEqual({ lastAgentMessagePreview: `${plain.slice(0, 139)}…` })
    expect(deriveChatPreview([{ _id: "a", createdAt: 1, kind: "assistant_text", text: "x".repeat(140) }])?.lastAgentMessagePreview).toBe("x".repeat(140))
  })

  test("notification preview includes only the current pending question or plan", () => {
    const reply: TranscriptEntry = { _id: "a", createdAt: 1, kind: "assistant_text", text: "Previous reply" }
    const question: TranscriptEntry = { _id: "q", createdAt: 2, kind: "tool_call", tool: { kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: "question", input: { questions: [{ question: "**Which** branch?" }, { question: "Deploy\n now?" }] } } }
    const plan: TranscriptEntry = { _id: "p", createdAt: 3, kind: "tool_call", tool: { kind: "tool", toolKind: "exit_plan_mode", toolName: "ExitPlanMode", toolId: "plan", input: { summary: "## Update the router", plan: "Longer plan" } } }
    expect(deriveChatPreview([reply, question], "question")).toEqual({ lastAgentMessagePreview: "Which branch? Deploy now?" })
    expect(deriveChatPreview([reply, question])).toEqual({ lastAgentMessagePreview: "Previous reply" })
    expect(deriveChatPreview([reply, plan], "plan")).toEqual({ lastAgentMessagePreview: "Update the router" })
    if (plan.kind === "tool_call" && plan.tool.toolKind === "exit_plan_mode") plan.tool.input.summary = " "
    expect(deriveChatPreview([plan], "plan")).toEqual({ lastAgentMessagePreview: "Longer plan" })
    expect(deriveChatPreview([{ ...question, hidden: true }], "question")).toBeNull()
  })

  test("keeps a compact full-history transcript for the Memory Record", () => {
    const entries = [{
      _id: "prompt-1",
      createdAt: 1,
      kind: "user_prompt",
      content: "Build it",
    }, {
      _id: "preview-1",
      createdAt: 2,
      kind: "memory_preview",
      previewId: "preview-1",
      turn: 1,
      memories: [{ id: "M-21", content: "Use the server", scope: "project" }],
    }, {
      _id: "answer-no-citation",
      createdAt: 3,
      kind: "assistant_text",
      text: "I am working on it.",
    }, {
      _id: "answer-with-citation",
      createdAt: 4,
      kind: "assistant_text",
      text: "The server is running [M-21].",
    }, {
      _id: "trace-1",
      createdAt: 5,
      kind: "memory_trace",
      turn: 1,
      labels: [{ id: "M-21", label: "operational" }],
    }] as TranscriptEntry[]

    expect(deriveMemoryRecordTranscript(entries).map((entry) => entry._id)).toEqual([
      "preview-1",
      "answer-with-citation",
      "trace-1",
    ])
  })

  test("include provider data in sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: true,
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })
    expect(sidebar.projectGroups[0]?.title).toBe("Project")
    expect(sidebar.projectGroups[0]?.localPath).toBe("/tmp/project")
    expect(sidebar.projectGroups[0]?.chats[0]?.provider).toBe("codex")
    expect(sidebar.projectGroups[0]?.chats[0]?.unread).toBe(true)
    expect(sidebar.projectGroups[0]?.chats[0]?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats).toEqual([])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("uses sidebar-only project titles without changing local project metadata", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      sidebarTitle: "Sidebar Name",
      createdAt: 1,
      updatedAt: 2,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")

    expect(deriveSidebarData(state, new Map()).projectGroups[0]?.title).toBe("Sidebar Name")
    expect(deriveLocalProjectsSnapshot(state, [], "Machine").projects[0]?.title).toBe("Project")
  })

  test("keeps archived chats out of the main sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-active", {
      id: "chat-active",
      projectId: "project-1",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-archived", {
      id: "chat-archived",
      projectId: "project-1",
      title: "Archived",
      createdAt: 2,
      updatedAt: 3,
      archivedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-active"])
    expect(sidebar.projectGroups[0]?.archivedChats?.map((chat) => chat.chatId)).toEqual(["chat-archived"])
  })

  test("includes available providers in chat snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: true,
      sessionToken: "session-1",
      lastTurnOutcome: null,
    })
    state.queuedMessagesByChatId.set("chat-1", [{
      id: "queued-1",
      content: "follow up",
      attachments: [],
      createdAt: 2,
      provider: "claude",
      model: "claude-sonnet-4-6",
      planMode: true,
    }])

    const chat = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      "chat-1",
      () => ({
        messages: [],
        history: {
          hasOlder: false,
          olderCursor: null,
          recentLimit: 200,
        },
      })
    )
    expect(chat?.runtime.provider).toBe("claude")
    // Streaming text defaults to null when no buffer map is supplied…
    expect(chat?.runtime.streamingText).toBeNull()
    // …and surfaces the chat's in-flight reply when one is.
    const streaming = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      "chat-1",
      () => ({
        messages: [],
        history: {
          hasOlder: false,
          olderCursor: null,
          recentLimit: 200,
        },
      }),
      new Map([["chat-1", "typing this out"]])
    )
    expect(streaming?.runtime.streamingText).toBe("typing this out")
    expect(chat?.queuedMessages.map((message) => message.content)).toEqual(["follow up"])
    expect(chat?.history.recentLimit).toBe(200)
    expect(chat?.availableProviders.map((provider) => provider.id)).toEqual(["claude", "codex", "pi"])
    expect(chat?.availableProviders[0]?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5.3-flash",
      "sonnet",
      "opus",
    ])
  })

  test("prefers saved project metadata over discovered entries for the same path", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Saved Project",
      createdAt: 1,
      updatedAt: 50,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 75,
      unread: false,
      provider: "codex",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })

    const snapshot = deriveLocalProjectsSnapshot(state, [
      {
        localPath: "/tmp/project",
        title: "Discovered Project",
        modifiedAt: 10,
      },
    ], "Local Machine")

    expect(snapshot.projects).toEqual([
      {
        localPath: "/tmp/project",
        title: "Saved Project",
        source: "saved",
        lastOpenedAt: 100,
        chatCount: 1,
      },
    ])
  })

  test("orders sidebar chats by user-visible activity instead of internal updatedAt churn", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-old", {
      id: "chat-old",
      projectId: "project-1",
      title: "Older user activity",
      createdAt: 10,
      updatedAt: 500,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-new", {
      id: "chat-new",
      projectId: "project-1",
      title: "Newer user activity",
      createdAt: 20,
      updatedAt: 50,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 200,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())
    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-new", "chat-old"])
  })

  test("honors persisted project order before fallback updated-at ordering", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project-1",
      title: "One",
      createdAt: 1,
      updatedAt: 10,
    })
    state.projectsById.set("project-2", {
      id: "project-2",
      localPath: "/tmp/project-2",
      title: "Two",
      createdAt: 2,
      updatedAt: 20,
    })
    state.projectsById.set("project-3", {
      id: "project-3",
      localPath: "/tmp/project-3",
      title: "Three",
      createdAt: 3,
      updatedAt: 15,
    })
    const sidebar = deriveSidebarData(state, new Map(), { sidebarProjectOrder: ["project-1"] })

    expect(sidebar.projectGroups.map((group) => group.groupKey)).toEqual(["project-1", "project-2", "project-3"])
  })

  test("builds preview and older chat slices using the current sidebar rules", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Recent",
      createdAt: 10,
      updatedAt: 10,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "Older",
      createdAt: 20,
      updatedAt: 20,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 26 * 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual(["chat-2"])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("shows all recent chats in the preview before folding older chats", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")

    for (let index = 0; index < 6; index++) {
      const chatNumber = index + 1
      state.chatsById.set(`chat-${chatNumber}`, {
        id: `chat-${chatNumber}`,
        projectId: "project-1",
        title: `Chat ${chatNumber}`,
        createdAt: chatNumber,
        updatedAt: chatNumber,
        unread: false,
        provider: "claude",
        planMode: false,
        sessionToken: null,
        lastMessageAt: 1_000_000 - chatNumber * 60 * 1_000,
        lastTurnOutcome: null,
      })
    }

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
      "chat-4",
      "chat-5",
      "chat-6",
    ])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual([])
  })

  test("disables forking for active and draining chats, but allows pending fork chats", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-active", {
      id: "chat-active",
      projectId: "project-1",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: "session-active",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-pending", {
      id: "chat-pending",
      projectId: "project-1",
      title: "Pending fork",
      createdAt: 2,
      updatedAt: 2,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      pendingForkSessionToken: "session-parent",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-draining", {
      id: "chat-draining",
      projectId: "project-1",
      title: "Draining",
      createdAt: 3,
      updatedAt: 3,
      unread: false,
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(
      state,
      new Map([["chat-active", "running"]]),
      { drainingChatIds: new Set(["chat-draining"]) }
    )

    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-active")?.canFork).toBeUndefined()
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-pending")?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-draining")?.canFork).toBeUndefined()
  })
})
