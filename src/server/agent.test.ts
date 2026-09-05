import { describe, expect, test } from "bun:test"
import {
  AgentCoordinator,
  ClaudeOutboundOriginTracker,
  ClaudeToolOriginResolver,
  buildClaudeSdkRuntimeOptions,
  buildClaudeSubprocessEnv,
  buildAttachmentHintText,
  buildPromptText,
  createClaudeHarnessStream,
  isStudyBackgroundToolRequest,
  isStudyToolOriginAllowed,
  isStudyPreviewLifecycleCommand,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeAssistantUsageSnapshot,
  normalizeClaudeStreamMessage,
  normalizeClaudeUsageSnapshot,
  resolveClaudeSessionModel,
  toMemoryCandidateReferences,
} from "./agent"
import type { HarnessTurn } from "./harness-types"
import type { ChatAttachment, TranscriptEntry } from "../shared/types"
import { resolveConditionPolicy } from "./experiment/condition"

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(entry: T): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...entry,
  } as TranscriptEntry
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  close() {
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }
        if (this.closed) {
          return { done: true, value: undefined as never }
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

test("memory candidate transcript references never duplicate draft content", () => {
  const candidates = [{ id: "M-01", content: "sk-secret", detail: "person@example.com" }]
  const references = toMemoryCandidateReferences(candidates)

  expect(references).toEqual([{ id: "M-01" }])
  expect(JSON.stringify(references)).not.toContain("sk-secret")
  expect(JSON.stringify(references)).not.toContain("person@example.com")
})

test("DeepSeek chat selection takes precedence over the configured fallback model", () => {
  expect(resolveClaudeSessionModel("deepseek-v4-pro", "deepseek-v4-flash")).toBe("deepseek-v4-pro")
  expect(resolveClaudeSessionModel("deepseek-v4-flash", "deepseek-v4-pro")).toBe("deepseek-v4-flash")
  expect(resolveClaudeSessionModel("claude-opus-4-8", "deepseek-v4-flash")).toBe("deepseek-v4-flash")
})

test("an own-Anthropic configured model overrides the catalog's deepseek ids", () => {
  // MEMOSYNC_USE_OWN_ANTHROPIC=1 keeps the user's ANTHROPIC_MODEL; the picker
  // still only offers deepseek-* ids, so the configured model must win.
  expect(resolveClaudeSessionModel("deepseek-v4-flash", "claude-opus-4-8")).toBe("claude-opus-4-8")
  expect(resolveClaudeSessionModel("deepseek-v4-pro", "")).toBe("deepseek-v4-pro")
})

test("DeepSeek Claude options use the 1M selector and a 768k compact budget", () => {
  const baseEnv = {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_MODEL: "deepseek-v4-flash",
  }

  const options = buildClaudeSdkRuntimeOptions({
    requestedModel: "deepseek-v4-flash",
    configuredModel: baseEnv.ANTHROPIC_MODEL,
    env: baseEnv,
  })

  // The [1m] selector lifts the CLI's 200k unknown-model assumption — without
  // it the preflight rejects prompts at ~152k ("Prompt is too long") and the
  // compact-window env below is ignored entirely.
  expect(options.model).toBe("deepseek-v4-flash[1m]")
  expect(options.settings).toEqual({
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
  })
  expect(options.env).toMatchObject({
    ANTHROPIC_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
  })
  // Auto-compact stays enabled: no kill switches.
  expect("DISABLE_AUTO_COMPACT" in options.env).toBe(false)
  expect("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in options.env).toBe(false)
  expect(baseEnv).not.toHaveProperty("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
})

test("an operator-supplied [1m] suffix is normalized, never doubled", () => {
  const options = buildClaudeSdkRuntimeOptions({
    requestedModel: "deepseek-v4-pro[1m]",
    configuredModel: "",
    env: {},
  })
  expect(options.model).toBe("deepseek-v4-pro[1m]")
  expect(options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("786432")
})

test("compact-window overrides stay scoped to DeepSeek models", () => {
  const options = buildClaudeSdkRuntimeOptions({
    requestedModel: "claude-opus-4-8",
    configuredModel: "",
    env: {},
  })

  expect(options.model).toBe("claude-opus-4-8")
  expect(options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
})

test("a GLM chat overrides the ANTHROPIC_* bundle for its own subprocess", () => {
  // The boot env is DeepSeek's; a GLM pick must repoint just this session.
  const bootEnv = {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_MODEL: "deepseek-v4-flash",
    ANTHROPIC_AUTH_TOKEN: "ds-key",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
    GLM_API_KEY: "glm-key",
  }
  const options = buildClaudeSdkRuntimeOptions({
    requestedModel: "glm-5.3-flash",
    configuredModel: bootEnv.ANTHROPIC_MODEL,
    env: bootEnv,
  })

  // GLM is 1M-native: bare id, no [1m] suffix.
  expect(options.model).toBe("glm-5.3-flash")
  expect(options.env).toMatchObject({
    ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "glm-key",
    ANTHROPIC_API_KEY: "glm-key",
    ANTHROPIC_MODEL: "glm-5.3-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.3-flash",
    // GLM's own window, not the DeepSeek boot value that was in env.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  })
})

test("a GLM pick wins over the DeepSeek env default model", () => {
  // resolveClaudeSessionModel must not let the boot ANTHROPIC_MODEL hijack it.
  expect(resolveClaudeSessionModel("glm-5.3-flash", "deepseek-v4-flash")).toBe("glm-5.3-flash")
})

test("Claude Bash inherits the exact assigned project's runtime instead of the MemoSync server env", () => {
  const env = buildClaudeSubprocessEnv({
    localPath: "/workspace/car",
    rawStudyProjects: JSON.stringify([
      { localPath: "/workspace/apartment" },
      { localPath: "/workspace/car" },
    ]),
    baseEnv: {
      PORT: "3210",
      NODE_ENV: "production",
      CLAUDECODE: "nested-session-marker",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/leaked.sock",
      CLAUDE_CODE_SESSION_ID: "leaked-session",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
      ANTHROPIC_AUTH_TOKEN: "secret",
    },
  })

  expect(env).toMatchObject({
    NODE_ENV: "development",
    ANTHROPIC_AUTH_TOKEN: "secret",
    // Deliberate engine config survives the session-variable scrub.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
  })
  expect(env.PORT).toBeUndefined()
  expect(env.CLAUDECODE).toBeUndefined()
  // Session-internal CLAUDE_* leakage from a Claude Code shell is dropped.
  expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
  expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
})

describe("createClaudeHarnessStream", () => {
  test("partial text deltas become assistant_delta events; subagent and thinking deltas stay invisible", async () => {
    async function* sdkMessages() {
      yield { type: "stream_event", session_id: "s-1", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg-1" } } }
      yield { type: "stream_event", session_id: "s-1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }
      yield { type: "stream_event", session_id: "s-1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } } }
      yield { type: "stream_event", session_id: "s-1", parent_tool_use_id: "tool-1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUBAGENT" } } }
      yield { type: "stream_event", session_id: "s-1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world." } } }
      yield {
        type: "assistant",
        uuid: "msg-1",
        session_id: "s-1",
        message: { content: [{ type: "text", text: "Hello, world." }] },
      }
    }

    const events: unknown[] = []
    for await (const event of createClaudeHarnessStream(sdkMessages() as never)) {
      events.push(event)
    }

    const deltas = events.filter((event) => (event as { type: string }).type === "assistant_delta") as Array<{ itemId?: string; delta?: string }>
    expect(deltas.map((event) => event.delta)).toEqual(["Hello, ", "world."])
    expect(deltas.every((event) => event.itemId === "msg-1")).toBe(true)

    const texts = events.filter((event) => {
      const candidate = event as { type: string; entry?: TranscriptEntry }
      return candidate.type === "transcript" && candidate.entry?.kind === "assistant_text"
    })
    expect(texts).toHaveLength(1)
  })

  test("inherits task-notification origin across tool results and every assistant event", async () => {
    async function* sdkMessages() {
      yield {
        type: "user",
        session_id: "s-bg",
        parent_tool_use_id: null,
        origin: { kind: "task-notification" },
        message: { role: "user", content: "background listener completed" },
      }
      yield {
        type: "stream_event",
        session_id: "s-bg",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "background delta" } },
      }
      yield {
        type: "assistant",
        session_id: "s-bg",
        message: { content: [{ type: "tool_use", id: "tool-bg", name: "Bash", input: { command: "pwd" } }] },
      }
      yield {
        type: "user",
        session_id: "s-bg",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bg", content: "ok" }] },
      }
      yield {
        type: "assistant",
        session_id: "s-bg",
        message: { content: [{ type: "text", text: "background final" }] },
      }
      yield {
        type: "result",
        session_id: "s-bg",
        origin: { kind: "task-notification" },
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        result: "background done",
      }
    }

    const events = []
    const originChanges: Array<string | undefined> = []
    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    // Model the SDK race: canUseTool is already waiting before readMessages
    // consumes the assistant frame that carries this exact tool_use id.
    const pendingToolOrigin = resolver.take("tool-bg", controller.signal, 1_000)
    for await (const event of createClaudeHarnessStream(
      sdkMessages() as never,
      (origin) => originChanges.push(origin),
      (toolUseId, origin) => resolver.register(toolUseId, origin),
    )) events.push(event)
    const turnEvents = events.filter((event) => event.type !== "session_token")
    expect(turnEvents.length).toBeGreaterThan(0)
    expect(turnEvents.every((event) => event.origin === "task-notification")).toBe(true)
    expect(originChanges).toEqual(["task-notification", undefined])
    const backgroundOrigin = await pendingToolOrigin
    for (const toolName of ["Bash", "Edit", "Write", "mcp__memory__propose_memory"]) {
      expect({ toolName, denied: !isStudyToolOriginAllowed(backgroundOrigin) }).toEqual({
        toolName,
        denied: true,
      })
    }
    resolver.register("tool-human", "human")
    expect(isStudyToolOriginAllowed(await resolver.take("tool-human", controller.signal, 10))).toBe(true)
    expect(isStudyToolOriginAllowed(await resolver.take("tool-unknown", controller.signal, 1))).toBe(false)
    const closing = resolver.take("tool-closing", controller.signal, 1_000)
    resolver.clear()
    expect(await closing).toBeUndefined()
    resolver.register("tool-after-close", "human")
    expect(await resolver.take("tool-after-close", controller.signal, 10)).toBeUndefined()
  })

  test("does not promote an originless late event after a completed turn to human", async () => {
    async function* sdkMessages() {
      yield {
        type: "user",
        origin: { kind: "human" },
        parent_tool_use_id: null,
        message: { role: "user", content: "participant prompt" },
      }
      yield {
        type: "result",
        origin: { kind: "human" },
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        result: "done",
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "late background output" }] },
      }
    }

    const events = []
    for await (const event of createClaudeHarnessStream(sdkMessages() as never)) events.push(event)
    const late = events.find((event) => event.type === "transcript" && event.entry?.kind === "assistant_text")
    expect(late?.origin).toBe("unknown")
    expect(isStudyToolOriginAllowed(late?.origin)).toBe(false)
  })

  test("isolates interleaved nested tool lineages and registers subagent tools before authorization", async () => {
    async function* sdkMessages() {
      yield {
        type: "user",
        session_id: "s-lineage",
        origin: { kind: "human" },
        parent_tool_use_id: null,
        message: { role: "user", content: "participant prompt" },
      }
      yield {
        type: "stream_event",
        session_id: "s-lineage",
        parent_tool_use_id: null,
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "agent-human" } },
      }
      yield {
        type: "user",
        session_id: "s-lineage",
        origin: { kind: "peer" },
        parent_tool_use_id: "agent-peer",
        message: { role: "user", content: "peer continuation" },
      }
      yield {
        type: "stream_event",
        session_id: "s-lineage",
        parent_tool_use_id: "agent-peer",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "nested-peer" } },
      }
      yield {
        type: "stream_event",
        session_id: "s-lineage",
        parent_tool_use_id: "agent-human",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "nested-human" } },
      }
    }

    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    const peer = resolver.take("nested-peer", controller.signal, 1_000)
    const human = resolver.take("nested-human", controller.signal, 1_000)
    for await (const _event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
    )) {
      // Drain the SDK frames; provenance registration happens before yields.
    }
    expect(await peer).toBe("peer")
    expect(isStudyToolOriginAllowed(await human)).toBe(true)
  })

  test("does not let a late task child borrow the next participant root after its lineage is cleared", async () => {
    const outbound = new ClaudeOutboundOriginTracker()
    async function* sdkMessages() {
      yield {
        type: "user",
        origin: { kind: "task-notification" },
        parent_tool_use_id: null,
        message: { role: "user", content: "background task continuation" },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "old-child-parent", name: "Task", input: {} }] },
      }
      yield {
        type: "result",
        origin: { kind: "task-notification" },
        subtype: "success",
        is_error: false,
        result: "background done",
      }

      // The next participant prompt has been queued, but the SDK has not
      // echoed its user frame when the old background child speaks again.
      outbound.beginHumanTurn()
      yield {
        type: "assistant",
        parent_tool_use_id: "old-child-parent",
        message: { content: [{ type: "tool_use", id: "late-child-tool", name: "Edit", input: {} }] },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "next-human-tool", name: "Edit", input: {} }] },
      }
      yield { type: "result", subtype: "success", is_error: false, result: "second done" }
    }

    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    const lateChild = resolver.take("late-child-tool", controller.signal, 1_000)
    const nextHuman = resolver.take("next-human-tool", controller.signal, 1_000)
    for await (const _event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
      outbound,
    )) {
      // Drain both turns.
    }

    expect(isStudyToolOriginAllowed(await lateChild)).toBe(false)
    expect(isStudyToolOriginAllowed(await nextHuman)).toBe(true)
    expect(outbound.current()).toBe("unknown")
  })

  test("a background result does not erase a still-live participant parent lineage", async () => {
    const outbound = new ClaudeOutboundOriginTracker()
    async function* sdkMessages() {
      yield {
        type: "user",
        origin: { kind: "human" },
        parent_tool_use_id: null,
        message: { role: "user", content: "participant prompt" },
      }
      yield {
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "live-human-parent", name: "Task", input: {} },
        },
      }
      yield {
        type: "user",
        origin: { kind: "task-notification" },
        parent_tool_use_id: null,
        message: { role: "user", content: "unrelated task completed" },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "background-tool", name: "Bash", input: {} }] },
      }
      yield {
        type: "result",
        origin: { kind: "task-notification" },
        subtype: "success",
        is_error: false,
        result: "background done",
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "live-human-parent", name: "Task", input: {} }] },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: "live-human-parent",
        message: { content: [{ type: "tool_use", id: "live-human-child", name: "Edit", input: {} }] },
      }
      yield { type: "result", origin: { kind: "human" }, subtype: "success", is_error: false, result: "human done" }
    }

    outbound.beginHumanTurn()
    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    const humanParent = resolver.take("live-human-parent", controller.signal, 1_000)
    const background = resolver.take("background-tool", controller.signal, 1_000)
    const liveHuman = resolver.take("live-human-child", controller.signal, 1_000)
    for await (const _event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
      outbound,
    )) {
      // Drain the interleaved roots.
    }

    expect(isStudyToolOriginAllowed(await humanParent)).toBe(true)
    expect(isStudyToolOriginAllowed(await background)).toBe(false)
    expect(isStudyToolOriginAllowed(await liveHuman)).toBe(true)
    expect(await resolver.take("live-human-parent", controller.signal, 1)).toBeUndefined()
    expect(outbound.current()).toBe("unknown")
  })

  test("fails closed for missing and mixed top-level tool-result lineages", async () => {
    async function* sdkMessages() {
      yield {
        type: "user",
        origin: { kind: "human" },
        parent_tool_use_id: null,
        message: { role: "user", content: "participant prompt" },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "human-tool", name: "Edit", input: {} }] },
      }
      yield {
        type: "user",
        origin: { kind: "peer" },
        parent_tool_use_id: "peer-parent",
        message: { role: "user", content: "peer work" },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: "peer-parent",
        message: { content: [{ type: "tool_use", id: "peer-tool", name: "Bash", input: {} }] },
      }
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "human-tool", content: "ok" },
            { type: "tool_result", tool_use_id: "peer-tool", content: "ok" },
          ],
        },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "after-mixed", name: "Edit", input: {} }] },
      }
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "missing-tool", content: "?" }] },
      }
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "after-missing", name: "Write", input: {} }] },
      }
    }

    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    const afterMixed = resolver.take("after-mixed", controller.signal, 1_000)
    const afterMissing = resolver.take("after-missing", controller.signal, 1_000)
    for await (const _event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
    )) {
      // Drain the interleaved frames.
    }

    expect(isStudyToolOriginAllowed(await afterMixed)).toBe(false)
    expect(isStudyToolOriginAllowed(await afterMissing)).toBe(false)
  })

  test("seeds a human turn from the outbound prompt when the SDK omits its user echo", async () => {
    async function* sdkMessages() {
      yield {
        type: "system",
        subtype: "init",
        session_id: "s-no-echo",
        model: "claude-opus",
        tools: [],
        slash_commands: [],
        mcp_servers: [],
      }
      yield {
        type: "assistant",
        session_id: "s-no-echo",
        message: { content: [{ type: "tool_use", id: "human-no-echo", name: "Edit", input: {} }] },
      }
      yield { type: "result", session_id: "s-no-echo", subtype: "success", is_error: false, result: "done" }
    }

    const outbound = new ClaudeOutboundOriginTracker()
    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    outbound.beginHumanTurn()
    const toolOrigin = resolver.take("human-no-echo", controller.signal, 1_000)
    const events = []
    for await (const event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
      outbound,
    )) events.push(event)
    expect(events.filter((event) => event.type !== "session_token").every((event) => event.origin === "human")).toBe(true)
    expect(isStudyToolOriginAllowed(await toolOrigin)).toBe(true)
    expect(outbound.current()).toBe("unknown")
  })

  test("does not promote an originless synthetic SDK user frame to a participant turn", async () => {
    async function* sdkMessages() {
      yield {
        type: "user",
        isSynthetic: true,
        parent_tool_use_id: null,
        message: { role: "user", content: "internal continuation" },
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "synthetic-tool", name: "Edit", input: {} }] },
      }
      yield { type: "result", subtype: "success", is_error: false, result: "internal done" }
    }

    const outbound = new ClaudeOutboundOriginTracker()
    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    const toolOrigin = resolver.take("synthetic-tool", controller.signal, 1_000)
    const events = []
    for await (const event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
      outbound,
    )) events.push(event)

    expect(events.filter((event) => event.type !== "session_token").every((event) => event.origin === "unknown")).toBe(true)
    expect(isStudyToolOriginAllowed(await toolOrigin)).toBe(false)
    expect(outbound.current()).toBe("unknown")
  })

  test("preserves a queued human turn across an older task-notification result", async () => {
    async function* sdkMessages() {
      yield {
        type: "user",
        origin: { kind: "task-notification" },
        parent_tool_use_id: null,
        message: { role: "user", content: "old task completed" },
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "old-task-tool", name: "Bash", input: {} }] },
      }
      yield { type: "result", subtype: "success", is_error: false, result: "old task done" }
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "queued-human-tool", name: "Edit", input: {} }] },
      }
      yield { type: "result", subtype: "success", is_error: false, result: "participant done" }
    }

    const outbound = new ClaudeOutboundOriginTracker()
    const resolver = new ClaudeToolOriginResolver()
    const controller = new AbortController()
    outbound.beginHumanTurn()
    const oldTask = resolver.take("old-task-tool", controller.signal, 1_000)
    const human = resolver.take("queued-human-tool", controller.signal, 1_000)
    for await (const _event of createClaudeHarnessStream(
      sdkMessages() as never,
      undefined,
      (toolUseId, origin) => resolver.register(toolUseId, origin),
      outbound,
    )) {
      // Drain both sequential SDK turns.
    }
    expect(isStudyToolOriginAllowed(await oldTask)).toBe(false)
    expect(isStudyToolOriginAllowed(await human)).toBe(true)
    expect(outbound.current()).toBe("unknown")
  })
})

test("study lifecycle command guard blocks preview and production builds but permits tests and static checks", () => {
  expect(isStudyPreviewLifecycleCommand("npm run dev")).toBe(true)
  expect(isStudyPreviewLifecycleCommand("nohup npm run start:dev &")).toBe(true)
  expect(isStudyPreviewLifecycleCommand("pkill -f next")).toBe(true)
  expect(isStudyPreviewLifecycleCommand("npm run build && npm test")).toBe(true)
  expect(isStudyPreviewLifecycleCommand("npx next build")).toBe(true)
  expect(isStudyPreviewLifecycleCommand("bun test src/server/foo.test.ts")).toBe(false)
  expect(isStudyPreviewLifecycleCommand("npx tsc --noEmit && npm run lint")).toBe(false)
  expect(isStudyBackgroundToolRequest("Bash", { command: "npm test", run_in_background: true })).toBe(true)
  expect(isStudyBackgroundToolRequest("Bash", { command: "npm test &" })).toBe(true)
  expect(isStudyBackgroundToolRequest("Task", { run_in_background: true })).toBe(true)
  expect(isStudyBackgroundToolRequest("Agent", { background: true })).toBe(true)
  expect(isStudyBackgroundToolRequest("Bash", { command: "npm run build && npm test" })).toBe(false)
})

test("Board invalidation wakes only the exact coordinator-owned gate without a participant decision", () => {
  const coordinator = new AgentCoordinator({
    store: createFakeStore() as never,
    onStateChange: () => {},
  })
  const wakes: string[] = []
  coordinator.pendingTransferGates.set("chat-1", {
    transferId: "transfer-1",
    published: true,
    respond: (decision) => wakes.push(`participant:${decision}`),
    invalidate: () => wakes.push("transfer:invalidated"),
  })
  coordinator.pendingCheckupGates.set("chat-2", {
    checkupId: "checkup-1",
    published: true,
    respond: (decision) => wakes.push(`participant:${decision}`),
    invalidate: () => wakes.push("checkup:invalidated"),
  })

  coordinator.handleBoardBacklogInvalidated({ kind: "transfer", chatId: "chat-1", gateId: "other" })
  coordinator.handleBoardBacklogInvalidated({ kind: "checkup", chatId: "chat-1", gateId: "checkup-1" })
  coordinator.handleBoardBacklogInvalidated({ kind: "transfer", chatId: "chat-1", gateId: "transfer-1" })
  coordinator.handleBoardBacklogInvalidated({ kind: "checkup", chatId: "chat-2", gateId: "checkup-1" })

  expect(wakes).toEqual(["transfer:invalidated", "checkup:invalidated"])
  expect(wakes.some((wake) => wake.startsWith("participant:"))).toBe(false)
})

describe("normalizeClaudeStreamMessage", () => {
  test("normalizes assistant tool calls", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "pwd",
              timeout: 1000,
            },
          },
        ],
      },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("tool_call")
    if (entries[0]?.kind !== "tool_call") throw new Error("unexpected entry")
    expect(entries[0].tool.toolKind).toBe("bash")
  })

  test("normalizes result messages", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 3210,
      result: "done",
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("result")
    if (entries[0]?.kind !== "result") throw new Error("unexpected entry")
    expect(entries[0].durationMs).toBe(3210)
  })

  test("normalizes Claude usage snapshots from SDK usage payloads", () => {
    const snapshot = normalizeClaudeUsageSnapshot({
      input_tokens: 4,
      cache_creation_input_tokens: 2715,
      cache_read_input_tokens: 21144,
      output_tokens: 679,
      tool_uses: 2,
      duration_ms: 654,
    }, 200_000)

    expect(snapshot).toEqual({
      usedTokens: 24_542,
      inputTokens: 23_863,
      cachedInputTokens: 21_144,
      outputTokens: 679,
      lastUsedTokens: 24_542,
      lastInputTokens: 23_863,
      lastCachedInputTokens: 21_144,
      lastOutputTokens: 679,
      toolUses: 2,
      durationMs: 654,
      maxTokens: 200_000,
      compactsAutomatically: true,
    })
  })

  test("reads current context usage from the nested assistant message instead of turn totals", () => {
    const snapshot = normalizeClaudeAssistantUsageSnapshot({
      type: "assistant",
      message: {
        id: "assistant-1",
        usage: {
          input_tokens: 417,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 25_344,
          output_tokens: 0,
        },
      },
      // The SDK result for this tool-heavy turn later reports 546,874
      // cumulative tokens; that value is not the current context window.
      usage: {
        input_tokens: 4_847,
        cache_read_input_tokens: 532_864,
        output_tokens: 9_163,
      },
    }, 200_000)

    expect(snapshot).toMatchObject({
      usedTokens: 25_761,
      inputTokens: 25_761,
      maxTokens: 200_000,
    })
  })

  test("reads the max Claude context window from modelUsage", () => {
    expect(maxClaudeContextWindowFromModelUsage({
      "claude-opus-4-6": {
        contextWindow: 200_000,
      },
      "claude-opus-4-6[1m]": {
        contextWindow: 1_000_000,
      },
    })).toBe(1_000_000)
  })
})

describe("attachment prompt helpers", () => {
  test("appends a structured attachment hint block for all attachment kinds", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "image-1",
        kind: "image",
        displayName: "shot.png",
        absolutePath: "/tmp/project/.memosync/uploads/shot.png",
        relativePath: "./.memosync/uploads/shot.png",
        contentUrl: "/api/projects/project-1/uploads/shot.png/content",
        mimeType: "image/png",
        size: 512,
      },
      {
        id: "file-1",
        kind: "file",
        displayName: "spec.pdf",
        absolutePath: "/tmp/project/.memosync/uploads/spec.pdf",
        relativePath: "./.memosync/uploads/spec.pdf",
        contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]

    const prompt = buildPromptText("Review these", attachments)
    expect(prompt).toContain("<memosync-attachments>")
    expect(prompt).toContain('path="/tmp/project/.memosync/uploads/shot.png"')
    expect(prompt).toContain('project_path="./.memosync/uploads/spec.pdf"')
  })

  test("supports attachment-only prompts", () => {
    const attachments: ChatAttachment[] = [{
      id: "file-1",
      kind: "file",
      displayName: "todo.txt",
      absolutePath: "/tmp/project/.memosync/uploads/todo.txt",
      relativePath: "./.memosync/uploads/todo.txt",
      contentUrl: "/api/projects/project-1/uploads/todo.txt/content",
      mimeType: "text/plain",
      size: 32,
    }]

    expect(buildPromptText("", attachments)).toContain("Please inspect the attached files.")
  })

  test("escapes xml attribute values for attachment hint markup", () => {
    const hint = buildAttachmentHintText([{
      id: "file-1",
      kind: "file",
      displayName: "\"report\" <draft>.txt",
      absolutePath: "/tmp/project/.memosync/uploads/report.txt",
      relativePath: "./.memosync/uploads/report.txt",
      contentUrl: "/api/projects/project-1/uploads/report.txt/content",
      mimeType: "text/plain",
      size: 64,
    }])

    expect(hint).toContain("&quot;report&quot; &lt;draft&gt;.txt")
  })
})

describe("AgentCoordinator codex integration", () => {
  test("generates a chat title in the background on the first user message", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return {
          title: "Generated title",
          usedFallback: false,
          failureMessage: null,
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    expect(store.chat.title).toBe("first message")
    releaseTitle()
    await waitFor(() => store.chat.title === "Generated title")
    expect(store.messages[0]?.kind).toBe("user_prompt")
  })

  test("does not overwrite a manual rename when background title generation finishes later", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return {
          title: "Generated title",
          usedFallback: false,
          failureMessage: null,
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    await store.renameChat("chat-1", "Manual title")
    releaseTitle()
    await waitFor(() => store.turnFinishedCount === 1)

    expect(store.chat.title).toBe("Manual title")
  })

  test("reports provider failure without a second rename after the optimistic title", async () => {
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const backgroundErrors: string[] = []
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => ({
        title: "first message",
        usedFallback: true,
        failureMessage: "claude failed conversation title generation: Not authenticated",
      }),
    })
    coordinator.setBackgroundErrorReporter((message) => {
      backgroundErrors.push(message)
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    expect(store.chat.title).toBe("first message")
    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.title).toBe("first message")
    expect(backgroundErrors).toEqual([
      "[title-generation] chat chat-1 failed provider title generation: claude failed conversation title generation: Not authenticated",
    ])
  })

  test("binds codex provider and reuses the session token on later turns", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.provider).toBe("codex")
    expect(store.chat.sessionToken).toBe("thread-1")
    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null }])

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      content: "second",
    })

    await waitFor(() => store.turnFinishedCount === 2)
    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null },
      { chatId: "chat-1", sessionToken: "thread-1" },
    ])
  })

  test("maps codex model options into session and turn settings", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null; serviceTier?: string }> = []
    const turnCalls: Array<{ effort?: string; serviceTier?: string }> = []

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null; serviceTier?: string }) {
        sessionCalls.push({
          chatId: args.chatId,
          sessionToken: args.sessionToken,
          serviceTier: args.serviceTier,
        })
      },
      async startTurn(args: { effort?: string; serviceTier?: string }): Promise<HarnessTurn> {
        turnCalls.push({
          effort: args.effort,
          serviceTier: args.serviceTier,
        })

        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "opt in",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null, serviceTier: "fast" }])
    expect(turnCalls).toEqual([{ effort: "xhigh", serviceTier: "fast" }])
  })

  test("approving synthetic codex ExitPlanMode starts a hidden follow-up turn and can clear context", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []
    let turnCount = 0

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(args: {
        content: string
        planMode: boolean
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })
        turnCount += 1

        async function* firstStream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "exit_plan_mode",
                toolName: "ExitPlanMode",
                toolId: "exit-1",
                input: {
                  plan: "## Plan\n\n- [ ] Ship it",
                  summary: "Plan summary",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-1",
              input: {
                plan: "## Plan\n\n- [ ] Ship it",
                summary: "Plan summary",
              },
            },
          })
        }

        async function* secondStream() {
          yield { type: "session_token" as const, sessionToken: "thread-2" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: turnCount === 1 ? firstStream() : secondStream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "plan this",
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "exit-1",
      result: {
        confirmed: true,
        clearContext: true,
        message: "Use the fast path",
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startTurnCalls).toEqual([
      { content: "plan this", planMode: true },
      { content: "Proceed with the approved plan. Additional guidance: Use the fast path", planMode: false },
    ])
    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null },
      { chatId: "chat-1", sessionToken: null },
    ])
    expect(store.messages.filter((entry) => entry.kind === "user_prompt")).toHaveLength(1)
    expect(store.messages.some((entry) => entry.kind === "context_cleared")).toBe(true)
    expect(store.chat.sessionToken).toBe("thread-2")
  })

  test("cancelling a waiting ask-user-question records a discarded tool result", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: {
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          void args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "ask_user_question",
              toolName: "AskUserQuestion",
              toolId: "question-1",
              input: {
                questions: [{ question: "Provider?" }],
              },
            },
          })
          await interrupted
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            releaseInterrupt()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "ask me something",
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "ask_user_question")
    await coordinator.cancel("chat-1")

    const discardedResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "question-1")
    expect(discardedResult).toBeDefined()
    if (!discardedResult || discardedResult.kind !== "tool_result") {
      throw new Error("missing discarded ask-user-question result")
    }
    expect(discardedResult.content).toEqual({ discarded: true, answers: {} })
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)
  })

  test("UI unblocks immediately when result arrives even if stream stays open", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Produce the result event
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 120_000,
              result: "done",
            }),
          }
          // Stream stays open (simulates background tasks still running)
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {
            resolveStream?.()
          },
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "run something with a background task",
    })

    // Wait for the result message to be persisted
    await waitFor(() => store.messages.some((entry) => entry.kind === "result"))

    // The active turn should be removed even though the stream is still open.
    // This is the key assertion: the UI should show idle (not "Running...")
    // so the user can send new messages without hitting stop.
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(store.turnFinishedCount).toBe(1)

    // The stream is still open, so it should be draining
    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(true)

    // Clean up the hanging stream
    resolveStream()

    // After the stream closes, draining should stop
    await waitFor(() => !coordinator.getDrainingChatIds().has("chat-1"))
  })

  test("stopDraining closes the stream and removes from draining set", async () => {
    let resolveStream!: () => void
    let streamClosed = false

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {
            streamClosed = true
            resolveStream?.()
          },
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getDrainingChatIds().has("chat-1"))

    await coordinator.stopDraining("chat-1")

    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(false)
    expect(streamClosed).toBe(true)
  })

  test("cancel immediately removes active turn so UI shows idle", async () => {
    let resolveInterrupt!: () => void
    const interruptCalled = new Promise<void>((resolve) => {
      resolveInterrupt = resolve
    })
    // interrupt() that hangs until we resolve it — simulating a slow SDK
    let interruptDone = false

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Stream that never ends (simulates the SDK hanging)
          await new Promise(() => {})
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveInterrupt()
            // Hang to simulate a slow interrupt
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                interruptDone = true
                resolve()
              }, 100)
            })
          },
          close: () => {},
        }
      },
    }

    const stateChanges: number[] = []
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {
        stateChanges.push(Date.now())
      },
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "do something",
    })

    // Wait for the turn to be running
    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    // Cancel — this should immediately remove from active turns
    const cancelPromise = coordinator.cancel("chat-1")

    // The turn should be removed from activeTurns immediately,
    // BEFORE interrupt() resolves
    await interruptCalled
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(interruptDone).toBe(false) // interrupt is still in progress

    await cancelPromise

    // Verify only one "interrupted" message was appended
    const interruptedMessages = store.messages.filter((entry) => entry.kind === "interrupted")
    expect(interruptedMessages).toHaveLength(1)
  })

  test("concurrent cancel calls only produce a single interrupted message", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveStream()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    // Fire multiple cancel calls concurrently (simulating repeated stop button clicks)
    await Promise.all([
      coordinator.cancel("chat-1"),
      coordinator.cancel("chat-1"),
      coordinator.cancel("chat-1"),
    ])

    // Only one "interrupted" message should exist
    const interruptedMessages = store.messages.filter((entry) => entry.kind === "interrupted")
    expect(interruptedMessages).toHaveLength(1)
  })

  test("runTurn stops processing events after cancel", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Wait for cancel, then yield another event that should be ignored
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
          // This event arrives after cancel — should not be processed
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "assistant_text",
              text: "this should be ignored after cancel",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveStream()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    const messageCountBefore = store.messages.filter((entry) => entry.kind === "assistant_text").length
    await coordinator.cancel("chat-1")

    // Give the stream time to yield the extra event
    await new Promise((resolve) => setTimeout(resolve, 50))

    const postCancelTextMessages = store.messages.filter((entry) => entry.kind === "assistant_text")
    expect(postCancelTextMessages.length).toBe(messageCountBefore)
  })

  test("cancelling a waiting codex exit-plan prompt discards it without starting a follow-up turn", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const startTurnCalls: string[] = []

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: {
        content: string
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push(args.content)

        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "exit_plan_mode",
                toolName: "ExitPlanMode",
                toolId: "exit-1",
                input: {
                  plan: "## Plan",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-1",
              input: {
                plan: "## Plan",
              },
            },
          })
          await interrupted
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            releaseInterrupt()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "plan this",
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")
    await coordinator.cancel("chat-1")

    const discardedResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")
    expect(discardedResult).toBeDefined()
    if (!discardedResult || discardedResult.kind !== "tool_result") {
      throw new Error("missing discarded exit-plan result")
    }
    expect(discardedResult.content).toEqual({ discarded: true })
    expect(startTurnCalls).toEqual(["plan this"])
  })
})

describe("AgentCoordinator claude integration", () => {
  test("reuses a persistent Claude session across turns", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{ model: string; planMode: boolean; sessionToken: string | null }> = []
    const prompts: string[] = []

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          model: args.model,
          planMode: args.planMode,
          sessionToken: args.sessionToken,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            if (prompts.length === 1) {
              events.push({ type: "session_token" as const, sessionToken: "claude-session-1" })
              events.push({
                type: "transcript" as const,
                entry: timestamped({
                  kind: "system_init",
                  provider: "claude",
                  model: "claude-opus-4-1",
                  tools: [],
                  agents: [],
                  slashCommands: [],
                  mcpServers: [],
                }),
              })
            }
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "start background task",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "check task output",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toHaveLength(1)
    expect(startSessionCalls[0]?.planMode).toBe(false)
    expect(startSessionCalls[0]?.sessionToken).toBeNull()
    expect(prompts).toEqual(["start background task", "check task output"])
    expect(store.chat.sessionToken).toBe("claude-session-1")

    events.close()
  })

  test("Claude final results clear running state without using draining mode", async () => {
    const events = new AsyncEventQueue<any>()

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "claude",
              model: "claude-opus-4-1",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          })
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "run something",
      model: "claude-opus-4-1",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(false)

    events.close()
  })

  test("task-notification results do not consume the participant FIFO or finish its turn", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    const diagnostics: string[] = []
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => events.close(),
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {},
      }),
    })
    coordinator.setBackgroundErrorReporter((message) => diagnostics.push(message))

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "participant work",
      model: "claude-opus-4-1",
    })

    events.push({
      type: "transcript",
      origin: "task-notification",
      entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 10, result: "background done" }),
    })
    await waitFor(() => diagnostics.some((message) => message.includes("claude-background-event")))
    expect(store.messages.some((entry) => entry.kind === "result" && entry.result === "background done")).toBe(false)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(true)
    expect(store.turnFinishedCount).toBe(0)

    events.push({
      type: "transcript",
      origin: "human",
      entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 20, result: "participant done" }),
    })
    await waitFor(() => store.turnFinishedCount === 1)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    events.close()
  })

  test("freeze retires the Claude pump before stopping preview and preserves resume across project switch", async () => {
    const order: string[] = []
    const sessions: AsyncEventQueue<any>[] = []
    const startTokens: Array<string | null> = []
    let previewPath: string | null = null
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      getActiveStudyTaskId: () => "038-S1",
      studyPreviewRuntime: {
        ensure: async (projectPath) => {
          if (previewPath && previewPath !== projectPath) order.push(`stop:${previewPath}`)
          previewPath = projectPath
          order.push(`ensure:${projectPath}`)
          return {} as never
        },
        status: async () => ({} as never),
        restart: async () => ({} as never),
        stop: async (projectPath) => {
          order.push(`stop:${projectPath}`)
          return {} as never
        },
      },
      startClaudeSession: async (args) => {
        startTokens.push(args.sessionToken)
        const events = new AsyncEventQueue<any>()
        sessions.push(events)
        async function* stream() {
          try {
            yield* events
          } finally {
            order.push("pump-ended")
          }
        }
        let closed = false
        return {
          provider: "claude",
          stream: stream(),
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {
            if (closed) return
            closed = true
            order.push("query-close")
            events.close()
          },
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {
            events.push({ type: "session_token", sessionToken: "resume-1" })
          },
        }
      },
    })

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "work" })
    sessions[0]!.push({
      type: "transcript",
      origin: "human",
      entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 1, result: "done" }),
    })
    await waitFor(() => store.turnFinishedCount === 1 && store.chat.sessionToken === "resume-1")
    await coordinator.retireStudyTaskRuntime("038-S1")

    expect(order.indexOf("query-close")).toBeLessThan(order.indexOf("pump-ended"))
    expect(order.indexOf("pump-ended")).toBeLessThan(order.indexOf("stop:/tmp/project"))

    store.getProject("project-1")!.localPath = "/tmp/project-2"
    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "continue" })
    expect(startTokens).toEqual([null, "resume-1"])
    sessions[1]!.close()
  })

  test("retire timeout fails closed before any preview replacement", async () => {
    let previewStops = 0
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      claudeRetireTimeoutMs: 1,
      store: store as never,
      onStateChange: () => {},
      getActiveStudyTaskId: () => "038-S1",
      studyPreviewRuntime: {
        ensure: async () => ({} as never),
        status: async () => ({} as never),
        restart: async () => ({} as never),
        stop: async () => {
          previewStops += 1
          return {} as never
        },
      },
      startClaudeSession: async () => ({
        provider: "claude",
        stream: {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
          },
        },
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {},
      }),
    })

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "work" })
    await expect(coordinator.retireStudyTaskRuntime("038-S1")).rejects.toThrow("claude-retire-timeout")
    expect(previewStops).toBe(0)
  })

  function createStopHarness(opts: { emitInitForFirstPrompt: boolean }) {
    const order: string[] = []
    const sessions: AsyncEventQueue<any>[] = []
    const startTokens: Array<string | null> = []
    const prompts: string[] = []
    const store = createFakeStore()
    const init = (events: AsyncEventQueue<any>) => events.push({
      type: "transcript" as const,
      origin: "human",
      entry: timestamped({
        kind: "system_init",
        provider: "claude",
        model: "claude-opus-4-1",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
    })
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      policy: resolveConditionPolicy("memosync"),
      getActiveStudyTaskId: () => "038-S1",
      startClaudeSession: async (args) => {
        const sessionNumber = sessions.length + 1
        startTokens.push(args.sessionToken)
        const events = new AsyncEventQueue<any>()
        sessions.push(events)
        async function* stream() {
          try {
            yield* events
          } finally {
            order.push(`pump-ended:${sessionNumber}`)
          }
        }
        let closed = false
        return {
          provider: "claude",
          stream: stream(),
          getAccountInfo: async () => null,
          // Deliberately emit no result/interrupted acknowledgement for a
          // cancelled prompt: the pilot CLI always acknowledged within 100 ms,
          // but the coordinator must stay correct when it does not.
          interrupt: async () => {},
          close: () => {
            if (closed) return
            closed = true
            order.push(`query-close:${sessionNumber}`)
            events.close()
          },
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            if (prompts.length === 1) {
              events.push({ type: "session_token" as const, sessionToken: "resume-after-stop", origin: "human" })
              if (opts.emitInitForFirstPrompt) init(events)
              return
            }
            init(events)
            events.push({
              type: "transcript" as const,
              origin: "human",
              entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 1, result: "second turn done" }),
            })
          },
        }
      },
    })
    return { order, sessions, startTokens, prompts, store, coordinator }
  }

  test("formal-study Stop on a started turn keeps the Claude Query; an unacknowledged cancel is realigned at the next prompt's system_init", async () => {
    const h = createStopHarness({ emitInitForFirstPrompt: true })

    await h.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first participant prompt",
      model: "claude-opus-4-1",
    })
    await waitFor(() => h.store.chat.sessionToken === "resume-after-stop")
    await waitFor(() => h.store.messages.some((entry) => entry.kind === "system_init"))

    await h.coordinator.cancel("chat-1")

    // The provider had started the turn, so the persistent Query survives Stop.
    expect(h.coordinator.claudeSessions.has("chat-1")).toBe(true)
    expect(h.order).toEqual([])

    await h.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "second participant prompt",
      model: "claude-opus-4-1",
    })
    // The cancelled prompt was never acknowledged; the next turn's system_init
    // drops that orphaned FIFO entry so this result finishes the right turn.
    await waitFor(() => h.store.turnFinishedCount === 1)

    expect(h.sessions).toHaveLength(1)
    expect(h.startTokens).toEqual([null])
    expect(h.store.messages.filter((entry) => entry.kind === "interrupted")).toHaveLength(1)
    h.sessions[0]!.close()
  })

  test("started Stop no-result releases only its exact outbound provenance reservation", async () => {
    const sdkEvents = new AsyncEventQueue<any>()
    const outboundOrigins = new ClaudeOutboundOriginTracker()
    const toolOrigins = new ClaudeToolOriginResolver()
    const discardedSeqs: number[][] = []
    const store = createFakeStore()
    let promptCount = 0
    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      policy: resolveConditionPolicy("memosync"),
      getActiveStudyTaskId: () => "038-S1",
      startClaudeSession: async () => ({
        provider: "claude",
        stream: createClaudeHarnessStream(
          sdkEvents as never,
          undefined,
          (toolUseId, origin) => toolOrigins.register(toolUseId, origin),
          outboundOrigins,
        ),
        getAccountInfo: async () => null,
        // Reproduce the exceptional path: Stop receives no cancelled result.
        interrupt: async () => {},
        close: () => sdkEvents.close(),
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async (_content, context) => {
          outboundOrigins.beginHumanTurn(context?.promptSeq)
          promptCount += 1
          sdkEvents.push({
            type: "system",
            subtype: "init",
            session_id: "persistent-stop-session",
            model: "claude-opus-4-1",
            tools: [],
            slash_commands: [],
            mcp_servers: [],
          })
        },
        discardHumanTurnReservations: (promptSeqs) => {
          discardedSeqs.push([...promptSeqs])
          return outboundOrigins.discardHumanTurnReservations(promptSeqs)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first participant prompt",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.messages.filter((entry) => entry.kind === "system_init").length === 1)
    await coordinator.cancel("chat-1")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "second participant prompt",
      model: "claude-opus-4-1",
    })
    await waitFor(() => discardedSeqs.length === 1)
    expect(promptCount).toBe(2)
    expect(discardedSeqs).toEqual([[1]])
    // Sequence 1 was discarded, but sequence 2 still owns human provenance.
    expect(outboundOrigins.current()).toBe("human")

    sdkEvents.push({
      type: "result",
      session_id: "persistent-stop-session",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      result: "second turn done",
    })
    await waitFor(() => store.turnFinishedCount === 1)
    await waitFor(() => outboundOrigins.current() === "unknown")

    // With both exact participant reservations settled, a later originless
    // synthetic root cannot borrow human authority for its tool call.
    const controller = new AbortController()
    const syntheticToolOrigin = toolOrigins.take("post-stop-synthetic-tool", controller.signal, 1_000)
    sdkEvents.push({
      type: "user",
      isSynthetic: true,
      parent_tool_use_id: null,
      message: { role: "user", content: "internal continuation" },
    })
    sdkEvents.push({
      type: "assistant",
      session_id: "persistent-stop-session",
      message: {
        content: [{ type: "tool_use", id: "post-stop-synthetic-tool", name: "Edit", input: {} }],
      },
    })
    expect(isStudyToolOriginAllowed(await syntheticToolOrigin)).toBe(false)
    await waitFor(() => !store.messages.some((entry) => (
      entry.kind === "tool_call" && entry.tool.toolId === "post-stop-synthetic-tool"
    )))
    sdkEvents.close()
  })

  test("formal-study Stop before the provider started the turn retires the Claude Query and resumes the saved session", async () => {
    const h = createStopHarness({ emitInitForFirstPrompt: false })

    await h.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first participant prompt",
      model: "claude-opus-4-1",
    })
    await waitFor(() => h.store.chat.sessionToken === "resume-after-stop")

    await h.coordinator.cancel("chat-1")

    // No system_init: a positional FIFO cannot tell this turn's late frames
    // from the next turn's, so the Query is retired fail-closed.
    expect(h.order.indexOf("query-close:1")).toBeLessThan(h.order.indexOf("pump-ended:1"))
    expect(h.coordinator.claudeSessions.has("chat-1")).toBe(false)

    await h.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "second participant prompt",
      model: "claude-opus-4-1",
    })
    await waitFor(() => h.store.turnFinishedCount === 1)

    expect(h.startTokens).toEqual([null, "resume-after-stop"])
    expect(h.store.messages.filter((entry) => entry.kind === "interrupted")).toHaveLength(1)
    h.sessions[1]!.close()
  })

  test("Claude steer interrupts the active run and immediately sends the steered message", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    await store.enqueueMessage("chat-1", {
      id: "queued-1",
      content: "queued follow up",
      attachments: [],
      provider: "claude",
      model: "claude-opus-4-1",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async (content: string) => {
          prompts.push(content)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first prompt",
      model: "claude-opus-4-1",
    })

    expect(prompts).toEqual(["first prompt"])
    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-1",
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toEqual("first prompt")
    expect(prompts[1]).toContain("queued follow up")
    expect(prompts[1]).toContain("<system-message>")
    expect(prompts[1]).toContain("</system-message>")
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)

    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "interrupted",
      }),
    })
    expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")

    events.close()
  })

  test("uses Claude forkSession when starting a forked chat", async () => {
    const startSessionCalls: Array<{ sessionToken: string | null; forkSession: boolean }> = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.pendingForkSessionToken = "claude-parent-1"

    const coordinator = new AgentCoordinator({
      claudeSessionFileExists: () => true,
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {
            events.push({ type: "session_token" as const, sessionToken: "claude-fork-1" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "system_init",
                provider: "claude",
                model: "claude-opus-4-1",
                tools: [],
                agents: [],
                slashCommands: [],
                mcpServers: [],
              }),
            })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "branch this",
      model: "claude-opus-4-1",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-parent-1",
      forkSession: true,
    }])
    expect(store.chat.pendingForkSessionToken).toBeNull()
    events.close()
  })
})

function createFakeStore() {
  const chat = {
    id: "chat-1",
    projectId: "project-1",
    title: "New Chat",
    provider: null as "claude" | "codex" | null,
    planMode: false,
    sessionToken: null as string | null,
    pendingForkSessionToken: null as string | null,
  }
  const project = {
    id: "project-1",
    localPath: "/tmp/project",
  }
  return {
    chat,
    turnFinishedCount: 0,
    messages: [] as TranscriptEntry[],
    queuedMessages: [] as any[],
    requireChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getProject(projectId: string) {
      expect(projectId).toBe("project-1")
      return project
    },
    getMessages() {
      return this.messages
    },
    async setChatProvider(_chatId: string, provider: "claude" | "codex") {
      chat.provider = provider
    },
    async setPlanMode(_chatId: string, planMode: boolean) {
      chat.planMode = planMode
    },
    async renameChat(_chatId: string, title: string) {
      chat.title = title
    },
    async appendMessage(_chatId: string, entry: TranscriptEntry) {
      this.messages.push(entry)
    },
    async recordTurnStarted() {},
    async recordTurnFinished() {
      this.turnFinishedCount += 1
    },
    async recordTurnFailed() {
      throw new Error("Did not expect turn failure")
    },
    async recordTurnCancelled() {},
    async setSessionToken(_chatId: string, sessionToken: string | null) {
      chat.sessionToken = sessionToken
    },
    async setPendingForkSessionToken(_chatId: string, pendingForkSessionToken: string | null) {
      chat.pendingForkSessionToken = pendingForkSessionToken
    },
    async createChat() {
      return chat
    },
    async forkChat() {
      return {
        ...chat,
        id: "chat-fork-1",
        title: "Fork: New Chat",
        sessionToken: null,
        pendingForkSessionToken: chat.sessionToken ?? chat.pendingForkSessionToken,
      }
    },
    async enqueueMessage(_chatId: string, message: any) {
      const queuedMessage = {
        id: message.id ?? crypto.randomUUID(),
        content: message.content,
        attachments: message.attachments ?? [],
        createdAt: message.createdAt ?? Date.now(),
        provider: message.provider,
        model: message.model,
        modelOptions: message.modelOptions,
        planMode: message.planMode,
      }
      this.queuedMessages.push(queuedMessage)
      return queuedMessage
    },
    getQueuedMessages() {
      return [...this.queuedMessages]
    },
    getChatIdsWithQueuedMessages() {
      return this.queuedMessages.length ? [chat.id] : []
    },
    getQueuedMessage(_chatId: string, queuedMessageId: string) {
      return this.queuedMessages.find((entry) => entry.id === queuedMessageId) ?? null
    },
    async removeQueuedMessage(_chatId: string, queuedMessageId: string) {
      this.queuedMessages = this.queuedMessages.filter((entry) => entry.id !== queuedMessageId)
    },
  }
}

describe("AgentCoordinator prompt admission", () => {
  test("rejects direct queue and steer channels before they mutate or cancel anything", async () => {
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      studyPromptGate: ({ content }) => content.includes("copied instruction")
        ? "Please describe the task in your own words."
        : null,
    })

    await expect(coordinator.enqueue({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "copied instruction",
    })).rejects.toThrow("own words")
    expect(store.queuedMessages).toHaveLength(0)

    await store.enqueueMessage("chat-1", { id: "legacy-bad", content: "copied instruction", attachments: [] })
    await expect(coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "legacy-bad",
    })).rejects.toThrow("own words")
    expect(store.queuedMessages.map((message) => message.id)).toEqual(["legacy-bad"])
  })

  test("rechecks persisted queued prompts before restart drain and leaves rejected data reviewable", async () => {
    const store = createFakeStore()
    await store.enqueueMessage("chat-1", { id: "legacy-bad", content: "copied instruction", attachments: [] })
    let engineStarts = 0
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      studyPromptGate: ({ content }) => content.includes("copied instruction")
        ? "Please describe the task in your own words."
        : null,
      startClaudeSession: async () => {
        engineStarts += 1
        throw new Error("must not start")
      },
    })

    await coordinator.drainOrphanedQueues()

    expect(engineStarts).toBe(0)
    expect(store.queuedMessages.map((message) => message.id)).toEqual(["legacy-bad"])
  })

  test("rechecks admission after async chat creation before starting the turn", async () => {
    let releaseCreate!: () => void
    let markCreateStarted!: () => void
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve
    })
    let refusal: string | null = null
    let turnStarts = 0
    const chat = {
      id: "chat-1",
      projectId: "project-1",
      title: "New Chat",
      provider: null,
      planMode: false,
      sessionToken: null,
      pendingForkSessionToken: null,
    }
    const store = {
      async createChat() {
        markCreateStarted()
        await createReleased
        return chat
      },
      requireChat() {
        return chat
      },
      async setChatProvider() {
        turnStarts += 1
        throw new Error("turn started after freeze")
      },
    }
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      generateTitle: async () => ({ title: "title", usedFallback: true, failureMessage: null }),
      studyPromptGate: ({ chatId }) => {
        if (chatId) expect(chatId).toBe("chat-1")
        return refusal
      },
    })

    const sending = coordinator.send({
      type: "chat.send",
      projectId: "project-1",
      provider: "claude",
      content: "start after chat creation",
    })
    await createStarted
    refusal = "The current session is ending."
    releaseCreate()

    await expect(sending).rejects.toThrow("The current session is ending.")
    expect(turnStarts).toBe(0)
  })
})
