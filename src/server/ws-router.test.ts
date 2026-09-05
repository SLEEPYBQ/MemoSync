import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AppSettingsSnapshot, KeybindingsSnapshot, LlmProviderSnapshot, TranscriptEntry, UpdateSnapshot } from "../shared/types"
import { PROTOCOL_VERSION } from "../shared/types"
import { createEmptyState } from "./events"
import {
  assertSafeSkillId,
  assertSafeSkillSource,
  buildInstallSkillCommand,
  buildUninstallSkillCommand,
  createSerialExecutor,
  createWsRouter,
  listInstalledSkills,
  parseInstalledSkillsLock,
} from "./ws-router"

describe("snapshot broadcast ordering", () => {
  test("does not start a newer broadcast until the previous one settles", async () => {
    const enqueue = createSerialExecutor()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = enqueue(async () => {
      events.push("first:start")
      await firstGate
      events.push("first:end")
    })
    const second = enqueue(async () => {
      events.push("second:start")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(["first:start", "first:end", "second:start"])
  })
})

function withSidebarGroupDefaults(group: {
  groupKey: string
  title: string
  realTitle?: string
  localPath: string
  chats: Array<{
    _id: string
    _creationTime: number
    chatId: string
    title: string
    status: "idle" | "starting" | "running" | "waiting_for_user" | "failed"
    unread: boolean
    localPath: string
    provider: "claude" | "codex" | null
    lastMessageAt?: number
    canFork?: boolean
    hasAutomation: boolean
  }>
}) {
  return {
    ...group,
    realTitle: group.realTitle ?? group.title,
    previewChats: group.chats,
    olderChats: [],
    defaultCollapsed: true,
  }
}

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly sendStatuses: number[] = []
  sendCalls = 0
  readonly data = {
    subscriptions: new Map(),
    protectedDraftChatIds: new Set<string>(),
  }

  send(message: string) {
    this.sendCalls += 1
    const parsed = JSON.parse(message)
    const status = this.sendStatuses.shift() ?? message.length
    if (status !== 0) {
      this.sent.push(parsed)
    }
    return status
  }
}

const DEFAULT_KEYBINDINGS_SNAPSHOT: KeybindingsSnapshot = {
  bindings: {
    toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
    toggleRightSidebar: ["ctrl+b"],
    openInFinder: ["cmd+alt+f"],
    openInEditor: ["cmd+shift+o"],
    addSplitTerminal: ["cmd+shift+j"],
    jumpToSidebarChat: ["cmd+alt"],
    createChatInCurrentProject: ["cmd+alt+n"],
    openAddProject: ["cmd+alt+o"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const DEFAULT_APP_SETTINGS_SNAPSHOT: AppSettingsSnapshot = {
  browserSettingsMigrated: false,
  theme: "system",
  chatSoundPreference: "always",
  chatSoundId: "funk",
  terminal: {
    scrollbackLines: 1_000,
    minColumnWidth: 450,
  },
  editor: {
    preset: "cursor",
    commandTemplate: "cursor {path}",
  },
  defaultProvider: "last_used",
  providerDefaults: {
    claude: {
      model: "claude-opus-4-8",
      modelOptions: {
        reasoningEffort: "high",
        contextWindow: "200k",
      },
      planMode: false,
    },
    codex: {
      model: "gpt-5.5",
      modelOptions: {
        reasoningEffort: "high",
        fastMode: false,
      },
      planMode: false,
    },
  },
  memoryPreview: {
    enabled: true,
    autoProceedWhenEmpty: true,
  },
  warning: null,
  filePathDisplay: "~/.kanna/data/settings.json",
}

describe("skills helpers", () => {
  test("parses installed global skills from a lock payload", () => {
    const snapshot = parseInstalledSkillsLock({
      version: 1,
      skills: {
        zeta: {
          source: "owner/zeta",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/zeta",
          skillPath: "skills/zeta/SKILL.md",
          installedAt: "2026-05-01T01:00:00.000Z",
          updatedAt: "2026-05-01T02:00:00.000Z",
          pluginName: "zeta-plugin",
        },
        alpha: {
          source: "owner/alpha",
          sourceType: "github",
        },
        ignored: "not an object",
      },
    }, "/tmp/.skill-lock.json")

    expect(snapshot.lockFilePath).toBe("/tmp/.skill-lock.json")
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"])
    expect(snapshot.skills[0]).toMatchObject({
      name: "alpha",
      source: "owner/alpha",
      sourceType: "github",
      sourceUrl: "",
      installedAt: "",
      updatedAt: "",
    })
    expect(snapshot.skills[1]).toMatchObject({
      name: "zeta",
      source: "owner/zeta",
      skillPath: "skills/zeta/SKILL.md",
      pluginName: "zeta-plugin",
    })
  })

  test("returns an empty installed skills snapshot when the lock file is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-skills-"))
    try {
      const missingPath = path.join(dir, "missing.json")
      expect(await listInstalledSkills(missingPath)).toEqual({
        lockFilePath: missingPath,
        skills: [],
      })

      const invalidPath = path.join(dir, ".skill-lock.json")
      await writeFile(invalidPath, "{", "utf8")
      expect(await listInstalledSkills(invalidPath)).toEqual({
        lockFilePath: invalidPath,
        skills: [],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("validates skill source and id before building commands", () => {
    expect(assertSafeSkillSource(" owner/repo ")).toBe("owner/repo")
    expect(assertSafeSkillId(" my-skill_1 ")).toBe("my-skill_1")
    expect(() => assertSafeSkillSource("https://github.com/owner/repo")).toThrow("owner/repo")
    expect(() => assertSafeSkillId("../nope")).toThrow("Skill id is invalid.")
  })

  test("builds global install and uninstall commands for universal and Claude Code aliases", () => {
    expect(buildInstallSkillCommand("owner/repo", "my-skill").slice(1)).toEqual([
      "skills",
      "add",
      "owner/repo",
      "--skill",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
    expect(buildUninstallSkillCommand("my-skill").slice(1)).toEqual([
      "skills",
      "remove",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
  })
})

const DEFAULT_UPDATE_SNAPSHOT: UpdateSnapshot = {
  currentVersion: "0.12.0",
  latestVersion: null,
  status: "idle",
  updateAvailable: false,
  lastCheckedAt: null,
  error: null,
  installAction: "restart",
  reloadRequestedAt: null,
}

const DEFAULT_LLM_PROVIDER_SNAPSHOT: LlmProviderSnapshot = {
  provider: "openai",
  apiKey: "",
  model: "",
  baseUrl: "",
  resolvedBaseUrl: "https://api.openai.com/v1",
  enabled: false,
  warning: null,
  filePathDisplay: "~/.kanna/llm-provider.json",
}

function createChatSnapshotHarness() {
  const state = createEmptyState()
  state.projectsById.set("project-1", {
    id: "project-1",
    localPath: "/tmp/project",
    title: "Project",
    createdAt: 1,
    updatedAt: 1,
  })
  state.chatsById.set("chat-1", {
    id: "chat-1",
    projectId: "project-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    provider: "claude",
    planMode: false,
    sessionToken: null,
    lastTurnOutcome: null,
  })
  const transcript: TranscriptEntry[] = []
  const router = createWsRouter({
    store: {
      state,
      getRecentChatHistory: (_chatId: string, recentLimit: number) => ({
        messages: transcript,
        history: { hasOlder: false, olderCursor: null, recentLimit },
      }),
    } as never,
    agent: {
      getActiveStatuses: () => new Map(),
      getDrainingChatIds: () => new Set(),
      getStreamingAssistantTexts: () => new Map(),
    } as never,
    terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
    keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
    refreshDiscovery: async () => [],
    getDiscoveredProjects: () => [],
    machineDisplayName: "Local Machine",
    updateManager: null,
  })
  const ws = new FakeWebSocket()
  router.handleOpen(ws as never)

  return { router, transcript, ws }
}

async function subscribeChatHarness({
  router,
  ws,
}: ReturnType<typeof createChatSnapshotHarness>) {
  await router.handleMessage(ws as never, JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "subscribe",
    id: "chat-sub-1",
    topic: { type: "chat", chatId: "chat-1" },
  }))
}

function appendWorkingMemoryPreview(transcript: TranscriptEntry[]) {
  transcript.push({
    _id: "preview-entry",
    createdAt: 2,
    kind: "memory_preview",
    previewId: "preview-1",
    turn: 2,
    task: "Continue the task",
    relevancePending: true,
    memories: [{ id: "M-01", content: "Use the saved preference", scope: "project" }],
  })
}

function appendWorkingMemoryRelevance(transcript: TranscriptEntry[]) {
  transcript.push({
    _id: "relevance-entry",
    createdAt: 3,
    kind: "memory_preview_relevance",
    previewId: "preview-1",
    revision: 0,
    relevant: [{ id: "M-01", why: "It applies to this task." }],
  })
}

describe("ws-router", () => {
  test("study Browser polling self-heals only an admitted degraded preview and never exposes process kill", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/workspace/car",
      title: "Car",
      createdAt: 1,
      updatedAt: 1,
    })
    let autoHealAllowed = true
    let recoverCalls = 0
    let killCalls = 0
    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        getRootPidsByCwd: () => [],
      } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Study workspace",
      updateManager: null,
      studyProjectAccess: { projectRefusal: () => null },
      studyPreviewRuntime: {
        recover: async (_projectPath, isStillAllowed) => {
          if (isStillAllowed()) recoverCalls += 1
          return {} as never
        },
      },
      canAutoHealStudyPreview: () => autoHealAllowed,
      listLocalHttpServersFn: async () => [{
        title: "Car",
        address: "http://127.0.0.1:3000",
        port: 3000,
        status: 200,
        sameProject: true,
      }],
      killLocalHttpServerFn: async () => {
        killCalls += 1
        return { ok: true, port: 3000, processName: "next" }
      },
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "command",
      id: "list-active",
      command: { type: "browser.listLocalHttpServers", projectId: "project-1" },
    }))
    expect(recoverCalls).toBe(1)
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "list-active",
      result: [expect.objectContaining({ port: 3000, canKill: false })],
    })

    autoHealAllowed = false
    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "command",
      id: "list-frozen",
      command: { type: "browser.listLocalHttpServers", projectId: "project-1" },
    }))
    expect(recoverCalls).toBe(1)

    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "command",
      id: "kill-study-preview",
      command: { type: "browser.killLocalHttpServer", port: 3000 },
    }))
    expect(killCalls).toBe(0)
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "error",
      id: "kill-study-preview",
      message: "Preview process lifecycle is managed by the study.",
    })
  })

  test("rejects study chat forks before they can inherit a prior session", async () => {
    let forkCalls = 0
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
        forkChat: async () => {
          forkCalls += 1
          return { chatId: "forked-chat" }
        },
      } as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Study workspace",
      updateManager: null,
      studyProjectAccess: { projectRefusal: () => null },
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "command",
      id: "study-fork",
      command: { type: "chat.fork", chatId: "s1-chat" },
    }))

    expect(forkCalls).toBe(0)
    expect(ws.sent).toEqual([{
      v: PROTOCOL_VERSION,
      type: "error",
      id: "study-fork",
      message: "Chat forking is disabled during the study. Start the current task from its task brief.",
    }])
  })

  test("rejects direct study project mutation and wrong-project chat creation commands", async () => {
    const router = createWsRouter({
      store: {
        state: createEmptyState(),
        openProject: () => { throw new Error("project.open reached store") },
        renameProjectSidebarTitle: () => { throw new Error("project.rename reached store") },
        removeProject: () => { throw new Error("project.remove reached store") },
        setSidebarProjectOrder: () => { throw new Error("sidebar reorder reached store") },
        createChat: () => { throw new Error("wrong chat.create reached store") },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Study workspace",
      updateManager: null,
      studyProjectAccess: {
        projectRefusal: (projectId) => projectId === "project-apartment" ? null : "Use the assigned project.",
      },
    })
    const ws = new FakeWebSocket()
    const commands = [
      { type: "project.open", localPath: "/workspace/apartment" },
      { type: "project.create", localPath: "/workspace/new", title: "New" },
      { type: "project.rename", projectId: "project-apartment", title: "Renamed" },
      { type: "project.remove", projectId: "project-apartment" },
      { type: "sidebar.reorderProjectGroups", projectIds: ["project-car", "project-apartment"] },
      { type: "chat.create", projectId: "project-car" },
    ] as const

    for (const [index, command] of commands.entries()) {
      await router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: `study-project-${index}`,
        command,
      }))
    }

    expect(ws.sent).toHaveLength(commands.length)
    expect(ws.sent.slice(0, 5)).toEqual(commands.slice(0, 5).map((_, index) => ({
      v: PROTOCOL_VERSION,
      type: "error",
      id: `study-project-${index}`,
      message: "Project selection and mutation are managed by the study.",
    })))
    expect(ws.sent[5]).toEqual({
      v: PROTOCOL_VERSION,
      type: "error",
      id: "study-project-5",
      message: "Use the assigned project.",
    })
  })

  test("applies the assigned-project authority to every project-scoped write channel", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-car", {
      id: "project-car",
      localPath: "/workspace/car",
      title: "Car",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-car", {
      id: "chat-car",
      projectId: "project-car",
      title: "Old car chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: "old-session",
      pendingForkSessionToken: null,
      lastTurnOutcome: null,
    })
    let mutationCalls = 0
    const reachedMutation = () => {
      mutationCalls += 1
      throw new Error("wrong-project mutation reached its adapter")
    }
    const router = createWsRouter({
      store: {
        state,
        getProject: (id: string) => state.projectsById.get(id),
        getChat: (id: string) => state.chatsById.get(id),
        listProjects: () => [...state.projectsById.values()],
      } as never,
      diffStore: {
        initializeGit: reachedMutation,
        publishToGitHub: reachedMutation,
        mergeBranch: reachedMutation,
        checkoutBranch: reachedMutation,
        syncBranch: reachedMutation,
        createBranch: reachedMutation,
        commitFiles: reachedMutation,
        discardFile: reachedMutation,
        ignoreFile: reachedMutation,
      } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
      } as never,
      terminals: {
        getSnapshot: (terminalId: string) => terminalId === "terminal-car"
          ? { terminalId, cwd: "/workspace/car" }
          : null,
        createTerminal: reachedMutation,
        write: reachedMutation,
        onEvent: () => () => {},
      } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Study workspace",
      updateManager: null,
      studyProjectAccess: { projectRefusal: () => "Use the assigned apartment project." },
    })
    const ws = new FakeWebSocket()
    const commands = [
      { type: "project.writeQuickActions", projectId: "project-car", quickActions: [] },
      { type: "terminal.create", projectId: "project-car", terminalId: "new-car-terminal", cols: 80, rows: 24, scrollback: 1000 },
      { type: "terminal.input", terminalId: "terminal-car", data: "rm answer.ts\n" },
      { type: "chat.initGit", chatId: "chat-car" },
      { type: "chat.publishToGitHub", chatId: "chat-car", owner: "owner", name: "repo", visibility: "private" },
      { type: "chat.mergeBranch", chatId: "chat-car", branch: { kind: "local", name: "feature" } },
      { type: "chat.checkoutBranch", chatId: "chat-car", branch: { kind: "local", name: "feature" } },
      { type: "chat.syncBranch", chatId: "chat-car", action: "push" },
      { type: "chat.createBranch", chatId: "chat-car", name: "feature" },
      { type: "chat.commitDiffs", chatId: "chat-car", paths: ["answer.ts"], summary: "answer", mode: "commit_only" },
      { type: "chat.discardDiffFile", chatId: "chat-car", path: "answer.ts" },
      { type: "chat.ignoreDiffFile", chatId: "chat-car", path: "answer.ts" },
      { type: "chat.exportStandalone", chatId: "chat-car", theme: "light", attachmentMode: "metadata" },
    ] as const

    for (const [index, command] of commands.entries()) {
      await router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: `wrong-project-write-${index}`,
        command,
      }))
    }

    expect(mutationCalls).toBe(0)
    expect(ws.sent).toEqual(commands.map((_, index) => ({
      v: PROTOCOL_VERSION,
      type: "error",
      id: `wrong-project-write-${index}`,
      message: "Use the assigned apartment project.",
    })))
  })

  test("keeps assigned-project terminal creation available during the active study task", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "memosync-study-terminal-"))
    try {
      const state = createEmptyState()
      state.projectsById.set("project-apartment", {
        id: "project-apartment",
        localPath: projectPath,
        title: "Apartment",
        createdAt: 1,
        updatedAt: 1,
      })
      let created = 0
      const router = createWsRouter({
        store: {
          state,
          getProject: (id: string) => state.projectsById.get(id),
          listProjects: () => [...state.projectsById.values()],
        } as never,
        agent: {
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
          getStreamingAssistantTexts: () => new Map(),
        } as never,
        terminals: {
          getSnapshot: () => null,
          createTerminal: (args: { terminalId: string }) => {
            created += 1
            return { terminalId: args.terminalId, cwd: projectPath }
          },
          onEvent: () => () => {},
        } as never,
        keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
        refreshDiscovery: async () => [],
        getDiscoveredProjects: () => [],
        machineDisplayName: "Study workspace",
        updateManager: null,
        studyProjectAccess: {
          projectRefusal: (projectId) => projectId === "project-apartment" ? null : "Use the assigned project.",
        },
      })
      const ws = new FakeWebSocket()

      await router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "assigned-terminal",
        command: {
          type: "terminal.create",
          projectId: "project-apartment",
          terminalId: "terminal-apartment",
          cols: 80,
          rows: 24,
          scrollback: 1000,
        },
      }))

      expect(created).toBe(1)
      expect(ws.sent).toEqual([{
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "assigned-terminal",
        result: { terminalId: "terminal-apartment", cwd: projectPath },
      }])
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("delegates chat admission to the coordinator exactly once", async () => {
    let coordinatorStarts = 0
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
        async send() {
          coordinatorStarts += 1
          return { chatId: "chat-1" }
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "send-through-coordinator",
        command: {
          type: "chat.send",
          chatId: "chat-1",
          provider: "claude",
          content: "must not start",
        },
      }),
    )

    expect(coordinatorStarts).toBe(1)
    expect(ws.sent).toEqual([{
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "send-through-coordinator",
      result: { chatId: "chat-1" },
    }])
  })

  test("acks system.ping without broadcasting snapshots", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    ws.data.subscriptions.set("sub-1", { type: "sidebar" })
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ping-1",
        command: { type: "system.ping" },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "ping-1",
      },
    ])
  })

  test("reads and writes llm provider settings via commands", async () => {
    const writes: Array<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">> = []
    let storedSnapshot: LlmProviderSnapshot = {
      ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
      apiKey: "stored-openai-key",
      enabled: true,
    }
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      llmProvider: {
        read: async () => storedSnapshot,
        write: async (value) => {
          writes.push(value)
          return {
            ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
            ...value,
            resolvedBaseUrl: value.provider === "custom" ? value.baseUrl : "https://api.openai.com/v1",
            enabled: Boolean(value.apiKey && value.model),
          }
        },
        validate: async () => ({
          ok: true,
          error: null,
        }),
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-read-1",
        command: { type: "settings.readLlmProvider" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-switch-1",
        command: {
          type: "settings.writeLlmProvider",
          provider: "custom",
          apiKey: "",
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-write-1",
        command: {
          type: "settings.writeLlmProvider",
          provider: "custom",
          apiKey: "test-key",
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
        },
      })
    )

    storedSnapshot = {
      ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
      provider: "custom",
      apiKey: "stored-custom-key",
      model: "gpt-test",
      baseUrl: "https://old.example/v1",
      resolvedBaseUrl: "https://old.example/v1",
      enabled: true,
    }
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-endpoint-switch-1",
        command: {
          type: "settings.writeLlmProvider",
          provider: "custom",
          apiKey: "",
          model: "gpt-test",
          baseUrl: "https://new.example/v1",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-read-1",
        result: {
          ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
          apiKey: "",
          hasApiKey: true,
          enabled: true,
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-switch-1",
        result: {
          ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
          provider: "custom",
          apiKey: "",
          hasApiKey: false,
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
          resolvedBaseUrl: "https://example.com/v1",
          enabled: false,
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-write-1",
        result: {
          ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
          provider: "custom",
          apiKey: "",
          hasApiKey: true,
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
          resolvedBaseUrl: "https://example.com/v1",
          enabled: true,
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-endpoint-switch-1",
        result: {
          ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
          provider: "custom",
          apiKey: "",
          hasApiKey: false,
          model: "gpt-test",
          baseUrl: "https://new.example/v1",
          resolvedBaseUrl: "https://new.example/v1",
          enabled: false,
        },
      },
    ])
    expect(writes).toEqual([
      {
        provider: "custom",
        apiKey: "",
        model: "gpt-test",
        baseUrl: "https://example.com/v1",
      },
      {
        provider: "custom",
        apiKey: "test-key",
        model: "gpt-test",
        baseUrl: "https://example.com/v1",
      },
      {
        provider: "custom",
        apiKey: "",
        model: "gpt-test",
        baseUrl: "https://new.example/v1",
      },
    ])
  })

  test("serializes overlapping llm provider writes so the last command wins", async () => {
    const writes: string[] = []
    let storedSnapshot = { ...DEFAULT_LLM_PROVIDER_SNAPSHOT }
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      llmProvider: {
        read: async () => storedSnapshot,
        write: async (value) => {
          writes.push(value.model)
          if (value.model === "first-model") {
            await new Promise((resolve) => setTimeout(resolve, 30))
          }
          storedSnapshot = {
            ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
            ...value,
            enabled: true,
          }
          return storedSnapshot
        },
        validate: async () => ({ ok: true, error: null }),
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    const first = router.handleMessage(ws as never, JSON.stringify({
      v: 1,
      type: "command",
      id: "llm-first",
      command: {
        type: "settings.writeLlmProvider",
        provider: "openai",
        apiKey: "first-key",
        model: "first-model",
        baseUrl: "",
      },
    }))
    const second = router.handleMessage(ws as never, JSON.stringify({
      v: 1,
      type: "command",
      id: "llm-second",
      command: {
        type: "settings.writeLlmProvider",
        provider: "openai",
        apiKey: "second-key",
        model: "second-model",
        baseUrl: "",
      },
    }))
    await Promise.all([first, second])

    expect(writes).toEqual(["first-model", "second-model"])
    expect(storedSnapshot.model).toBe("second-model")
    expect(storedSnapshot.apiKey).toBe("second-key")
    expect(ws.sent.map((message: any) => message.id)).toEqual(["llm-first", "llm-second"])
  })

  test("subscribes to app settings and writes patches through the router", async () => {
    let snapshot: AppSettingsSnapshot = DEFAULT_APP_SETTINGS_SNAPSHOT
    let listener: ((nextSnapshot: AppSettingsSnapshot) => void) | null = null
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => snapshot,
        writePatch: async (patch) => {
          snapshot = {
            ...snapshot,
            browserSettingsMigrated: patch.browserSettingsMigrated ?? snapshot.browserSettingsMigrated,
            theme: patch.theme ?? snapshot.theme,
            chatSoundPreference: patch.chatSoundPreference ?? snapshot.chatSoundPreference,
            chatSoundId: patch.chatSoundId ?? snapshot.chatSoundId,
            defaultProvider: patch.defaultProvider ?? snapshot.defaultProvider,
            terminal: { ...snapshot.terminal, ...patch.terminal },
            editor: { ...snapshot.editor, ...patch.editor },
          }
          listener?.(snapshot)
          return snapshot
        },
        onChange: (nextListener) => {
          listener = nextListener
          return () => {
            listener = null
          }
        },
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "app-settings-sub-1",
        topic: { type: "app-settings" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-patch-1",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            theme: "dark",
            terminal: { scrollbackLines: 2_000 },
          },
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: DEFAULT_APP_SETTINGS_SNAPSHOT,
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT,
            theme: "dark",
            terminal: {
              ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
              scrollbackLines: 2_000,
            },
          },
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "settings-patch-1",
        result: {
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          theme: "dark",
          terminal: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
            scrollbackLines: 2_000,
          },
        },
      },
    ])
  })

  test("acks terminal.input without rebroadcasting terminal snapshots", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        write: () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-terminal", { type: "terminal", terminalId: "terminal-1" })
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "terminal-input-1",
        command: {
          type: "terminal.input",
          terminalId: "terminal-1",
          data: "ls\r",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "terminal-input-1",
      },
    ])
  })

  test("subscribes and unsubscribes chat topics", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub-1",
        topic: { type: "chat", chatId: "chat-1" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "chat-sub-1",
      snapshot: {
        type: "chat",
        data: null,
      },
    })

    // Reusing the same subscription id is the client self-heal path for a
    // dropped terminal snapshot. It must force one fresh response without
    // creating another server-side subscription.
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub-1",
        topic: { type: "chat", chatId: "chat-1" },
      }),
    )
    expect(ws.sent[1]).toEqual(ws.sent[0])
    expect(ws.data.subscriptions.size).toBe(1)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "unsubscribe",
        id: "chat-sub-1",
      })
    )

    expect(ws.sent[2]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "chat-sub-1",
    })
  })

  test("retries the latest chat snapshot on drain when a Working Memory preview was dropped", async () => {
    const harness = createChatSnapshotHarness()
    const { router, transcript, ws } = harness
    await subscribeChatHarness(harness)

    appendWorkingMemoryPreview(transcript)
    ws.sendStatuses.push(0)
    await router.broadcastChatStateImmediately("chat-1")
    expect(ws.sent).toHaveLength(1)

    appendWorkingMemoryRelevance(transcript)
    await router.handleDrain(ws as never)

    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[1]).toMatchObject({
      type: "snapshot",
      id: "chat-sub-1",
      snapshot: {
        type: "chat",
        data: {
          messages: transcript,
        },
      },
    })
  })

  test("automatically retries the latest Working Memory snapshot when no drain event follows a drop", async () => {
    const harness = createChatSnapshotHarness()
    const { router, transcript, ws } = harness
    await subscribeChatHarness(harness)

    appendWorkingMemoryPreview(transcript)
    ws.sendStatuses.push(0)
    await router.broadcastChatStateImmediately("chat-1")

    appendWorkingMemoryRelevance(transcript)
    await Bun.sleep(50)

    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[1]).toMatchObject({
      type: "snapshot",
      id: "chat-sub-1",
      snapshot: {
        type: "chat",
        data: { messages: transcript },
      },
    })
  })

  test("keeps a twice-dropped snapshot for heartbeat resync without retrying in a loop", async () => {
    const harness = createChatSnapshotHarness()
    const { router, transcript, ws } = harness
    await subscribeChatHarness(harness)

    appendWorkingMemoryPreview(transcript)
    ws.sendStatuses.push(0, 0)
    await router.broadcastChatStateImmediately("chat-1")
    appendWorkingMemoryRelevance(transcript)

    await Bun.sleep(50)
    expect(ws.sendCalls).toBe(3)
    await Bun.sleep(30)
    expect(ws.sendCalls).toBe(3)

    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "command",
      id: "ping-1",
      command: { type: "system.ping" },
    }))

    const chatSnapshots = ws.sent.filter((message) => (
      (message as { type?: string; snapshot?: { type?: string } }).type === "snapshot"
      && (message as { snapshot?: { type?: string } }).snapshot?.type === "chat"
    ))
    expect(chatSnapshots).toHaveLength(2)
    expect(chatSnapshots[1]).toMatchObject({
      snapshot: {
        data: { messages: transcript },
      },
    })
  })

  test("cancels a pending dropped-snapshot retry when the socket closes", async () => {
    const harness = createChatSnapshotHarness()
    const { router, transcript, ws } = harness
    await subscribeChatHarness(harness)

    appendWorkingMemoryPreview(transcript)
    ws.sendStatuses.push(0)
    await router.broadcastChatStateImmediately("chat-1")
    router.handleClose(ws as never)
    await Bun.sleep(50)

    expect(ws.sendCalls).toBe(2)
    expect(ws.sent).toHaveLength(1)
  })

  test("does not resend a snapshot that Bun enqueued while reporting backpressure", async () => {
    const state = createEmptyState()
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
      } as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "subscribe",
      id: "sidebar-sub-1",
      topic: { type: "sidebar" },
    }))

    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    ws.sendStatuses.push(-1)
    await router.broadcastSnapshots()
    await router.handleDrain(ws as never)

    expect(ws.sent).toHaveLength(2)
  })

  test("reuses one sidebar derivation across sockets in the same broadcast pass", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    let activeStatusCalls = 0
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => {
          activeStatusCalls += 1
          return new Map()
        },
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })

    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()
    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)
    wsA.data.subscriptions.set("sidebar-a", { type: "sidebar" })
    wsB.data.subscriptions.set("sidebar-b", { type: "sidebar" })

    await router.broadcastSnapshots()

    expect(activeStatusCalls).toBe(1)
    expect(wsA.sent).toHaveLength(1)
    expect(wsB.sent).toHaveLength(1)
  })

  test("subscribes to project git snapshots independently from chat snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: () => state.projectsById.get("project-1") ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        }),
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 1, hasConflicts: false, message: "ready" }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "project-git-sub-1",
        topic: { type: "project-git", projectId: "project-1" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "project-git-sub-1",
      snapshot: {
        type: "project-git",
        data: {
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        },
      },
    })
  })

  test("reads diff patches through the project-scoped command", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => null,
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 1, hasConflicts: false, message: "ready" }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "diff --git a/app.txt b/app.txt" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "read-patch-1",
        command: {
          type: "project.readDiffPatch",
          projectId: "project-1",
          path: "app.txt",
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "read-patch-1",
      result: { patch: "diff --git a/app.txt b/app.txt" },
    })
  })

  test("routes merge preview and merge commands through the diff store", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({ status: "ready", branchName: "main", files: [], branchHistory: { entries: [] } }),
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 2, hasConflicts: false, message: "2 commits from feature/test will merge into main." }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: true }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "preview-merge-1",
        command: {
          type: "chat.previewMergeBranch",
          chatId: "chat-1",
          branch: { kind: "local", name: "feature/test" },
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "merge-1",
        command: {
          type: "chat.mergeBranch",
          chatId: "chat-1",
          branch: { kind: "local", name: "feature/test" },
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "preview-merge-1",
      result: {
        currentBranchName: "main",
        targetBranchName: "feature/test",
        targetDisplayName: "feature/test",
        status: "mergeable",
        commitCount: 2,
        hasConflicts: false,
        message: "2 commits from feature/test will merge into main.",
      },
    })
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "merge-1",
      result: {
        ok: true,
        branchName: "main",
        snapshotChanged: true,
      },
    })
  })

  test("loads older chat history pages", async () => {
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
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const router = createWsRouter({
      store: {
        state,
        getMessagesPageBefore: () => ({
          messages: [{
            _id: "msg-1",
            kind: "assistant_text",
            createdAt: 1,
            text: "older message",
          }],
          hasOlder: false,
          olderCursor: null,
        }),
        getChat: () => state.chatsById.get("chat-1") ?? null,
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "history-1",
        command: {
          type: "chat.loadHistory",
          chatId: "chat-1",
          beforeCursor: "idx:100",
          limit: 100,
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "history-1",
      result: {
        messages: [{
          _id: "msg-1",
          kind: "assistant_text",
          createdAt: 1,
          text: "older message",
        }],
        hasOlder: false,
        olderCursor: null,
      },
    })
  })

  test("marks chats read and rebroadcasts sidebar snapshots", async () => {
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
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const store = {
      state,
      async setChatReadState(chatId: string, unread: boolean) {
        const chat = state.chatsById.get(chatId)
        if (!chat) throw new Error("Chat not found")
        chat.unread = unread
      },
    }

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()

    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)

    await router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-a",
        topic: { type: "sidebar" },
      })
    )
    await router.handleMessage(
      wsB as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-b",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "mark-read-1",
        command: { type: "chat.markRead", chatId: "chat-1" },
      })
    )

    expect(wsA.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "mark-read-1",
    })
    expect(wsA.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-a",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: null,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
    expect(wsB.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-b",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: null,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
  })

  test("reorders sidebar project groups on the server and rebroadcasts the snapshot", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project-1",
      title: "Project 1",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectsById.set("project-2", {
      id: "project-2",
      localPath: "/tmp/project-2",
      title: "Project 2",
      createdAt: 2,
      updatedAt: 2,
    })

    const setSidebarProjectOrderCalls: string[][] = []
    let sidebarProjectOrder: string[] = []
    const router = createWsRouter({
      store: {
        state,
        getSidebarProjectOrder() {
          return [...sidebarProjectOrder]
        },
        async setSidebarProjectOrder(projectIds: string[]) {
          setSidebarProjectOrderCalls.push(projectIds)
          sidebarProjectOrder = [...projectIds]
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "sidebar-reorder-1",
        command: { type: "sidebar.reorderProjectGroups", projectIds: ["project-1", "project-2"] },
      })
    )

    expect(setSidebarProjectOrderCalls).toEqual([["project-1", "project-2"]])
    expect(ws.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "sidebar-reorder-1",
    })
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [
            withSidebarGroupDefaults({
              groupKey: "project-1",
              title: "Project 1",
              localPath: "/tmp/project-1",
              chats: [],
            }),
            withSidebarGroupDefaults({
              groupKey: "project-2",
              title: "Project 2",
              localPath: "/tmp/project-2",
              chats: [],
            }),
          ],
        },
      },
    })
  })

  test("forks a chat through the agent and rebroadcasts the sidebar snapshot", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: "session-1",
      pendingForkSessionToken: null,
      lastTurnOutcome: null,
    })

    const forkChatCalls: string[] = []
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getStreamingAssistantTexts: () => new Map(),
          forkChat: async (chatId: string) => {
          forkChatCalls.push(chatId)
          state.chatsById.set("chat-fork-1", {
            id: "chat-fork-1",
            projectId: "project-1",
            title: "Fork: Chat",
            createdAt: 2,
            updatedAt: 2,
            unread: false,
            provider: "claude",
            planMode: false,
            sessionToken: null,
            pendingForkSessionToken: "session-1",
            lastTurnOutcome: null,
          })
          return { chatId: "chat-fork-1" }
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "fork-1",
        command: { type: "chat.fork", chatId: "chat-1" },
      })
    )

    expect(forkChatCalls).toEqual(["chat-1"])
    expect(ws.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "fork-1",
      result: { chatId: "chat-fork-1" },
    })
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-fork-1",
              _creationTime: 2,
              chatId: "chat-fork-1",
              title: "Fork: Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: "claude",
              canFork: true,
              hasAutomation: false,
            }, {
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: "claude",
              canFork: true,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
  })

  test("prunes stale empty chats during explicit maintenance runs", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-stale", {
      id: "chat-stale",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    let pruneCalls = 0
    const router = createWsRouter({
      store: {
        state,
        async pruneStaleEmptyChats() {
          pruneCalls += 1
          state.chatsById.delete("chat-stale")
          return ["chat-stale"]
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    await router.pruneStaleEmptyChats()
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    expect(pruneCalls).toBe(1)
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [{
            ...withSidebarGroupDefaults({
              groupKey: "project-1",
              title: "Project",
              localPath: "/tmp/project",
              chats: [],
            }),
          }],
        },
      },
    })
  })

  test("protects draft-bearing chats during explicit maintenance runs", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-stale", {
      id: "chat-stale",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    let capturedProtectedChatIds: string[] = []
    const router = createWsRouter({
      store: {
        state,
        async pruneStaleEmptyChats(args?: { protectedChatIds?: Iterable<string> }) {
          capturedProtectedChatIds = [...(args?.protectedChatIds ?? [])]
          return []
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "draft-protection-1",
        command: {
          type: "chat.setDraftProtection",
          chatIds: ["chat-stale"],
        },
      })
    )

    await router.pruneStaleEmptyChats()
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    expect(capturedProtectedChatIds).toEqual(["chat-stale"])
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "draft-protection-1",
    })
  })

  test("broadcasts background title-generation errors to connected clients", () => {
    let reportBackgroundError: ((message: string) => void) | null | undefined
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        setBackgroundErrorReporter: (reporter: ((message: string) => void) | null) => {
          reportBackgroundError = reporter
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    reportBackgroundError?.("[title-generation] chat chat-1 failed")

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "error",
        message: "[title-generation] chat chat-1 failed",
      },
    ])
  })

  test("subscribes to keybindings snapshots and writes keybindings through the router", async () => {
    const initialSnapshot: KeybindingsSnapshot = DEFAULT_KEYBINDINGS_SNAPSHOT
    const keybindings = {
      snapshot: initialSnapshot,
      getSnapshot() {
        return this.snapshot
      },
      onChange: () => () => {},
      async write(bindings: KeybindingsSnapshot["bindings"]) {
        this.snapshot = { bindings, warning: null, filePathDisplay: "~/.kanna/keybindings.json" }
        return this.snapshot
      },
    }

    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: keybindings as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "keybindings-sub-1",
        topic: { type: "keybindings" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "keybindings-sub-1",
      snapshot: {
        type: "keybindings",
        data: keybindings.snapshot,
      },
    })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "keybindings-write-1",
        command: {
          type: "settings.writeKeybindings",
          bindings: {
            toggleEmbeddedTerminal: ["cmd+k"],
            toggleRightSidebar: ["ctrl+shift+b"],
            openInFinder: ["cmd+shift+g"],
            openInEditor: ["cmd+shift+p"],
            addSplitTerminal: ["cmd+alt+j"],
            jumpToSidebarChat: ["cmd+alt"],
            createChatInCurrentProject: ["cmd+alt+n"],
            openAddProject: ["cmd+alt+o"],
          },
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "keybindings-write-1",
      result: {
        bindings: {
          toggleEmbeddedTerminal: ["cmd+k"],
          toggleRightSidebar: ["ctrl+shift+b"],
          openInFinder: ["cmd+shift+g"],
          openInEditor: ["cmd+shift+p"],
          addSplitTerminal: ["cmd+alt+j"],
          jumpToSidebarChat: ["cmd+alt"],
          createChatInCurrentProject: ["cmd+alt+n"],
          openAddProject: ["cmd+alt+o"],
        },
        warning: null,
        filePathDisplay: "~/.kanna/keybindings.json",
      },
    })
  })

  test("subscribes to update snapshots and handles update.check commands", async () => {
    const updateManager = {
      snapshot: { ...DEFAULT_UPDATE_SNAPSHOT },
      getSnapshot() {
        return this.snapshot
      },
      onChange: () => () => {},
      async checkForUpdates({ force }: { force?: boolean }) {
        this.snapshot = {
          ...this.snapshot,
          latestVersion: force ? "0.13.0" : "0.12.1",
          status: "available",
          updateAvailable: true,
          lastCheckedAt: 123,
        }
        return this.snapshot
      },
      async installUpdate() {
        return {
          ok: false,
          action: "restart",
          errorCode: "version_not_live_yet",
          userTitle: "Update not live yet",
          userMessage: "This update is still propagating. Try again in a few minutes.",
        }
      },
    }

    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: updateManager as never,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "update-sub-1",
        topic: { type: "update" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "update-sub-1",
      snapshot: {
        type: "update",
        data: DEFAULT_UPDATE_SNAPSHOT,
      },
    })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "update-check-1",
        command: {
          type: "update.check",
          force: true,
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "update-check-1",
      result: {
        currentVersion: "0.12.0",
        latestVersion: "0.13.0",
        status: "available",
        updateAvailable: true,
        lastCheckedAt: 123,
        error: null,
        installAction: "restart",
        reloadRequestedAt: null,
      },
    })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "update-install-1",
        command: {
          type: "update.install",
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[2]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "update-install-1",
      result: {
        ok: false,
        action: "restart",
        errorCode: "version_not_live_yet",
        userTitle: "Update not live yet",
        userMessage: "This update is still propagating. Try again in a few minutes.",
      },
    })
  })

  test("routes discard diff file commands through the diff store and rebroadcasts chat snapshots", async () => {
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
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const discardCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const diffStore = {
      getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
      refreshSnapshot: async () => false,
      syncBranch: async () => ({ ok: true as const, action: "fetch" as const, snapshotChanged: false }),
      generateCommitMessage: async () => ({ subject: "", body: "" }),
      commitFiles: async () => ({ ok: true as const, mode: "commit_only" as const, pushed: false, snapshotChanged: false }),
      discardFile: async (args: { projectId: string; projectPath: string; path: string }) => {
        discardCalls.push(args)
        return { snapshotChanged: true }
      },
      ignoreFile: async () => ({ snapshotChanged: false }),
    }

    const router = createWsRouter({
      store: {
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getRecentChatHistory: () => ({ entries: [], hasOlder: false, olderCursor: null }),
      } as never,
      diffStore: diffStore as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    router.handleOpen(ws as never)
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub",
        topic: { type: "chat", chatId: "chat-1" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "discard-1",
        command: {
          type: "chat.discardDiffFile",
          chatId: "chat-1",
          path: "app.txt",
        },
      })
    )

    expect(discardCalls).toEqual([{
      projectId: "project-1",
      projectPath: "/tmp/project",
      path: "app.txt",
    }])
    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "discard-1",
      result: { snapshotChanged: true },
    })
  })

  test("routes ignore diff file commands through the diff store", async () => {
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
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const ignoreCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const router = createWsRouter({
      store: {
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        refreshSnapshot: async () => false,
        syncBranch: async () => ({ ok: true as const, action: "fetch" as const, snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "" }),
        commitFiles: async () => ({ ok: true as const, mode: "commit_only" as const, pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async (args: { projectId: string; projectPath: string; path: string }) => {
          ignoreCalls.push(args)
          return { snapshotChanged: false }
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ignore-1",
        command: {
          type: "chat.ignoreDiffFile",
          chatId: "chat-1",
          path: "scratch.log",
        },
      })
    )

    expect(ignoreCalls).toEqual([{
      projectId: "project-1",
      projectPath: "/tmp/project",
      path: "scratch.log",
    }])
    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "ignore-1",
      result: { snapshotChanged: false },
    })
  })
})
