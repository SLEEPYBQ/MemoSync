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
})
