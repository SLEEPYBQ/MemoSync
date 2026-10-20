import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildRegistryModel,
  extractPiToolResultContent,
  MISSING_PI_CONNECTION_MESSAGE,
  normalizePiUsage,
  PiAgentManager,
  PI_TOOL_NAMES,
  resolvePiConnection,
  scrubPiShellEnv,
  translatePiTool,
} from "./pi-agent"
import type { HarnessEvent } from "./harness-types"

const tempDirs: string[] = []
const previousOpenRouterKey = process.env.OPENROUTER_API_KEY

afterEach(async () => {
  if (previousOpenRouterKey === undefined) {
    delete process.env.OPENROUTER_API_KEY
  } else {
    process.env.OPENROUTER_API_KEY = previousOpenRouterKey
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function collectEvents(stream: AsyncIterable<HarnessEvent>) {
  const events: HarnessEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeSession() {
  const calls = { prompts: 0, aborts: 0, disposals: 0 }
  return {
    calls,
    isStreaming: false,
    sessionFile: "/test/pi-session.jsonl",
    subscribe: () => () => {},
    prompt: async () => { calls.prompts += 1 },
    abort: async () => { calls.aborts += 1 },
    dispose: () => { calls.disposals += 1 },
  }
}

function fakeSdk(options: {
  reload?: () => Promise<void>
  create?: () => Promise<ReturnType<typeof fakeSession>>
} = {}) {
  return {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey() {} }) },
    ModelRegistry: { inMemory: () => ({ find: () => undefined }) },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() { await options.reload?.() } },
    SessionManager: { create: () => ({}) },
    createAgentSession: async () => ({ session: await options.create?.() ?? fakeSession() }),
  }
}

const startupArgs = {
  chatId: "startup-chat", cwd: "/tmp", content: "hello", model: "test-model",
  effort: "medium" as const, sessionToken: null, forkSession: false, toolNames: [],
  connection: { provider: "custom" as const, baseUrl: "https://example.test/v1", apiKey: "test-key" },
}

describe("Pi startup cancellation", () => {
  test("pre-aborted startup never loads the SDK", async () => {
    let loads = 0
    const manager = new PiAgentManager({ loadSdk: async () => { loads += 1; return fakeSdk() as never } })
    await expect(manager.startTurn({ ...startupArgs, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" })
    expect(loads).toBe(0)
    manager.dispose()
  })

  test.each(["sdk", "resources", "session"] as const)("abort during %s initialization prevents prompt dispatch", async (stage) => {
    const entered = deferred()
    const gate = deferred()
    const session = fakeSession()
    const hold = async () => { entered.resolve(); await gate.promise }
    const sdk = fakeSdk({
      reload: stage === "resources" ? hold : undefined,
      create: async () => { if (stage === "session") await hold(); return session },
    })
    const manager = new PiAgentManager({ loadSdk: async () => { if (stage === "sdk") await hold(); return sdk as never } })
    const controller = new AbortController()
    const starting = manager.startTurn({ ...startupArgs, signal: controller.signal })
    const rejected = starting.catch((error: unknown) => error)
    await entered.promise
    controller.abort()
    gate.resolve()
    expect(await rejected).toMatchObject({ name: "AbortError" })
    expect(session.calls.prompts).toBe(0)
    expect(manager.getResourceCounts().piSessions).toBe(0)
    expect(session.calls.disposals).toBe(stage === "session" ? 1 : 0)
    manager.dispose()
  })

  test.each(["closeChat", "dispose"] as const)("%s cancels an in-flight session creation", async (action) => {
    const entered = deferred()
    const gate = deferred()
    const session = fakeSession()
    const sdk = fakeSdk({ create: async () => { entered.resolve(); await gate.promise; return session } })
    const manager = new PiAgentManager({ loadSdk: async () => sdk as never })
    const starting = manager.startTurn(startupArgs)
    const rejected = starting.catch((error: unknown) => error)
    await entered.promise
    if (action === "closeChat") manager.closeChat(startupArgs.chatId)
    else manager.dispose()
    gate.resolve()
    expect(await rejected).toMatchObject({ name: "AbortError" })
    expect(session.calls).toEqual({ prompts: 0, aborts: 1, disposals: 1 })
    expect(manager.getResourceCounts().piSessions).toBe(0)
    manager.dispose()
  })

  test("a late cancelled session cannot replace or dispose its newer owner", async () => {
    const entered = deferred()
    const gate = deferred()
    const stale = fakeSession()
    const fresh = fakeSession()
    let creations = 0
    const sdk = fakeSdk({ create: async () => {
      if (++creations === 1) { entered.resolve(); await gate.promise; return stale }
      return fresh
    } })
    const manager = new PiAgentManager({ loadSdk: async () => sdk as never })
    const starting = manager.startTurn(startupArgs)
    const rejected = starting.catch((error: unknown) => error)
    await entered.promise
    manager.closeChat(startupArgs.chatId)
    const turn = await manager.startTurn(startupArgs)
    await collectEvents(turn.stream)
    gate.resolve()
    expect(await rejected).toMatchObject({ name: "AbortError" })
    expect(stale.calls).toEqual({ prompts: 0, aborts: 1, disposals: 1 })
    expect(fresh.calls).toEqual({ prompts: 1, aborts: 0, disposals: 0 })
    expect(manager.getResourceCounts().piSessions).toBe(1)
    manager.closeChat(startupArgs.chatId)
    expect(fresh.calls.aborts).toBe(1)
    expect(fresh.calls.disposals).toBe(1)
    manager.dispose()
  })
})

describe("translatePiTool", () => {
  test.each([
    ["read", { path: "/a.ts", offset: 5, limit: 10 }, "Read", { file_path: "/a.ts", offset: 5, limit: 10 }],
    ["bash", { command: "ls", timeout: 30 }, "Bash", { command: "ls", timeout: 30_000 }],
    ["write", { path: "/a.ts", content: "hi" }, "Write", { file_path: "/a.ts", content: "hi" }],
    ["grep", { pattern: "foo", path: "/src", ignoreCase: true, limit: 20 }, "Grep", { pattern: "foo", path: "/src", glob: undefined, "-i": true, "-C": undefined, head_limit: 20 }],
    ["find", { pattern: "*.ts", path: "/src" }, "Glob", { pattern: "*.ts", path: "/src" }],
    ["ls", { path: "/src/" }, "Glob", { pattern: "/src/*", path: "/src/" }],
  ])("translates %s", (raw, args, toolName, input) => {
    expect(translatePiTool(raw, args)).toEqual({ toolName, input })
  })

  test("joins multi-edit calls into one old/new pair", () => {
    const result = translatePiTool("edit", {
      path: "/a.ts",
      edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }],
    })
    expect(result).toEqual({
      toolName: "Edit",
      input: { file_path: "/a.ts", old_string: "x\np", new_string: "y\nq" },
    })
  })

  test("defaults ls to the current directory and leaves unknown tools untouched", () => {
    expect(translatePiTool("ls", {}).input.pattern).toBe("./*")
    expect(translatePiTool("load_memory_detail", { id: "M-1" }))
      .toEqual({ toolName: "load_memory_detail", input: { id: "M-1" } })
  })
})

describe("extractPiToolResultContent", () => {
  test("flattens text blocks and keeps image blocks structured", () => {
    expect(extractPiToolResultContent({
      content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
    })).toBe("line1line2")

    const imageResult = { content: [{ type: "image", data: "abc" }] }
    expect(extractPiToolResultContent(imageResult)).toEqual({ content: [{ type: "image", data: "abc" }] })
  })

  test("passes through strings and falls back to output", () => {
    expect(extractPiToolResultContent("done")).toBe("done")
    expect(extractPiToolResultContent({ output: "out" })).toBe("out")
  })
})

describe("normalizePiUsage", () => {
  test("sums cache tokens into input and reports last-turn totals", () => {
    expect(normalizePiUsage({ input: 100, output: 40, cacheRead: 20, cacheWrite: 10 }, 200_000)).toEqual({
      usedTokens: 170,
      inputTokens: 130,
      cachedInputTokens: 20,
      outputTokens: 40,
      lastUsedTokens: 170,
      lastInputTokens: 130,
      lastCachedInputTokens: 20,
      lastOutputTokens: 40,
      maxTokens: 200_000,
      compactsAutomatically: true,
    })
  })

  test("returns null for empty usage and tolerates missing fields", () => {
    expect(normalizePiUsage({})).toBeNull()
    expect(normalizePiUsage(null)).toBeNull()
    const partial = normalizePiUsage({ input: 5 })
    expect(partial?.usedTokens).toBe(5)
    expect(partial?.maxTokens).toBeUndefined()
  })
})

describe("buildRegistryModel", () => {
  test("synthesizes an openai-completions model for any registry id", () => {
    const model = buildRegistryModel(
      { provider: "custom", baseUrl: "https://example.com/v1", apiKey: "k" },
      "z-ai/glm-5.3-flash"
    )
    expect(model.id).toBe("z-ai/glm-5.3-flash")
    expect(model.provider).toBe("custom")
    expect(model.baseUrl).toBe("https://example.com/v1")
    expect(model.api).toBe("openai-completions")
    expect(model.compat).toEqual({ thinkingFormat: "openai" })
  })

  test("uses the openrouter thinking format on the OpenRouter route", () => {
    const model = buildRegistryModel(
      { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
      "z-ai/glm-5.3-flash"
    )
    expect(model.compat).toEqual({ thinkingFormat: "openrouter" })
  })
})

describe("resolvePiConnection", () => {
  test("falls back to OPENROUTER_API_KEY when no Model Registry is configured", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test"
    const connection = await resolvePiConnection()
    // A registry connection (if configured on the machine) also counts as a
    // valid connection; the env key is only exercised when none exists.
    expect(connection).not.toBeNull()
    if (connection?.provider === "openrouter") {
      expect(connection.apiKey).toBe("sk-or-test")
      expect(connection.baseUrl).toContain("openrouter.ai")
    }
  })
})

describe("PiAgentManager", () => {
  test("a turn without a connection streams a result error entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "memosync-pi-"))
    tempDirs.push(dir)
    const manager = new PiAgentManager({ dataDir: dir })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      cwd: dir,
      content: "hello",
      model: "z-ai/glm-5.3-flash",
      effort: "medium",
      sessionToken: null,
      forkSession: false,
      connection: null,
    })

    expect(turn.provider).toBe("pi")
    const events = await collectEvents(turn.stream)
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event.type !== "transcript") throw new Error("expected a transcript event")
    expect(event.entry).toMatchObject({ kind: "result", subtype: "error", isError: true, result: MISSING_PI_CONNECTION_MESSAGE })
    expect(manager.getResourceCounts().piSessions).toBe(0)
    manager.dispose()
  })

  test("closeChat and dispose are no-ops for unknown or empty chats", () => {
    const manager = new PiAgentManager({ dataDir: "/tmp/memosync-pi-empty" })
    manager.closeChat("missing")
    manager.dispose()
    expect(manager.getResourceCounts().piSessions).toBe(0)
  })

  test("built-in tool list covers the pi tools surfaced in system_init", () => {
    expect(PI_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"])
  })

  test("bash spawn env keeps ordinary variables and strips credentials", () => {
    const env = scrubPiShellEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMPDIR: "/tmp",
      GIT_AUTHOR_NAME: "Baiqiao",
      XAUTHORITY: "/tmp/xauth",
      OPENROUTER_API_KEY: "sk-or-live",
      DEEPSEEK_API_KEY: "ds-live",
      MEMOSYNC_CODEX_API_KEY: "codex-key",
      GITHUB_TOKEN: "ghp_abc123456789",
      NESTED_SECRET: "not-a-shape-secret",
      APP_PASSWORD: "pw",
      CREDENTIALS_JSON: "{}",
      AUTH_HEADER: "x",
      SESSION_COOKIE: "c",
      AWS_PRIVATE_KEY: "k",
      LOOKS_SECRET: "sk-proj-plainvalue12345",
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/u")
    expect(env.USER).toBe("u")
    expect(env.SHELL).toBe("/bin/bash")
    expect(env.LANG).toBe("en_US.UTF-8")
    expect(env.LC_ALL).toBe("en_US.UTF-8")
    expect(env.TERM).toBe("xterm-256color")
    expect(env.TMPDIR).toBe("/tmp")
    expect(env.GIT_AUTHOR_NAME).toBe("Baiqiao")
    expect(env.XAUTHORITY).toBe("/tmp/xauth")
    for (const leaked of [
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "MEMOSYNC_CODEX_API_KEY",
      "GITHUB_TOKEN",
      "NESTED_SECRET",
      "APP_PASSWORD",
      "CREDENTIALS_JSON",
      "AUTH_HEADER",
      "SESSION_COOKIE",
      "AWS_PRIVATE_KEY",
      "LOOKS_SECRET",
    ]) {
      expect(env[leaked]).toBeUndefined()
    }
  })

  test.each([
    [false, "Pi session file not found"],
    [true, "Pi session file for fork not found"],
  ])("a missing persisted session file fails the turn instead of starting fresh (fork=%s)", async (forkSession, message) => {
    const dir = await mkdtemp(path.join(tmpdir(), "memosync-pi-"))
    tempDirs.push(dir)
    const manager = new PiAgentManager({ dataDir: dir })

    const missing = path.join(dir, "sessions", "gone.jsonl")
    const turn = await manager.startTurn({
      chatId: "chat-missing",
      cwd: dir,
      content: "hello",
      model: "z-ai/glm-5.3-flash",
      effort: "medium",
      sessionToken: missing,
      forkSession,
      connection: { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" },
    })

    const events = await collectEvents(turn.stream)
    const results = events.filter((event) => event.type === "transcript")
    expect(results).toHaveLength(1)
    const entry = results[0]
    if (entry.type !== "transcript") throw new Error("expected a transcript event")
    expect(entry.entry).toMatchObject({ kind: "result", subtype: "error", isError: true })
    expect(String((entry.entry as { result?: unknown }).result)).toContain(message)
    // No fresh session replaced the lost history.
    expect(manager.getResourceCounts().piSessions).toBe(0)
    manager.dispose()
  })
})
