import { describe, expect, test } from "bun:test"
import type { query, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { StartCodexSessionArgs, StartCodexTurnArgs } from "../codex-app-server"
import type { HarnessEvent } from "../harness-types"
import {
  canUseMemoryBranchTool,
  createMemoryBranch,
  isReadOnlyBranchCommand,
  parseMemoryBranchJson,
  type MemoryBranchDependencies,
  type MemoryBranchInput,
} from "./branch-runtime"

const base: MemoryBranchInput = {
  provider: "claude",
  parentSessionToken: "main-session",
  localPath: "/tmp/memosync-branch-unit",
  model: "test-model",
  subprocessEnv: {},
}

function fakeClaude(responses: Array<Record<string, unknown>[]>) {
  const calls: Parameters<typeof query>[0][] = []
  let closed = 0
  const claudeQuery: typeof query = (input) => {
    calls.push(input)
    const messages = responses.shift() ?? []
    const iterator = (async function* () {
      for (const message of messages) yield message as SDKMessage
    })()
    return Object.assign(iterator, { close() { closed += 1 } }) as unknown as Query
  }
  return { calls, claudeQuery, get closed() { return closed } }
}

function claudeSuccess(result: unknown, sessionId = "child-session") {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "result", subtype: "success", is_error: false, result: JSON.stringify(result), session_id: sessionId },
  ]
}

function fakeCodex() {
  const sessions: StartCodexSessionArgs[] = []
  const turns: StartCodexTurnArgs[] = []
  const stopped: string[] = []
  const codexManager: NonNullable<MemoryBranchDependencies["codexManager"]> = {
    async startSession(args) { sessions.push(args); return "codex-child" },
    async startTurn(args) {
      turns.push(args)
      return {
        provider: "codex",
        stream: (async function* () {
          yield { type: "transcript", entry: { kind: "assistant_text", text: "Inspecting the project." } } as HarnessEvent
          yield { type: "transcript", entry: { kind: "assistant_text", text: JSON.stringify({ revised: turns.length }) } } as HarnessEvent
          yield { type: "transcript", entry: { kind: "result", subtype: "success", isError: false, result: "" } } as HarnessEvent
        })(),
        async interrupt() {},
        close() {},
      }
    },
    stopSession(id) { stopped.push(id) },
  }
  return { sessions, turns, stopped, codexManager }
}

describe("persistent memory branches", () => {
  test("Claude forks the main history once and serializes follow-ups into the same child", async () => {
    const fake = fakeClaude([claudeSuccess({ candidates: [1] }), claudeSuccess({ candidates: [] })])
    const branch = createMemoryBranch(base, fake)
    const first = branch.ask("Prepare proposals")
    const followup = branch.ask("Developer dismissed proposal 1; update the analysis")
    expect(await first).toEqual({ candidates: [1] })
    expect(await followup).toEqual({ candidates: [] })
    expect(fake.calls.map((call) => ({ resume: call.options?.resume, fork: call.options?.forkSession }))).toEqual([
      { resume: "main-session", fork: true },
      { resume: "child-session", fork: false },
    ])
    expect(branch.sessionToken).toBe("child-session")
    expect(branch.mode).toBe("fork")
    expect(fake.calls[0].options?.tools).toEqual(["Read", "Glob", "Grep", "Bash"])
    expect(fake.calls[0].options?.maxTurns).toBe(6)
    expect(fake.closed).toBe(2)
    branch.dispose()
    await expect(branch.ask("Too late")).rejects.toThrow("disposed")
  })

  test("Claude consumes SDK structured output and carries the selected provider environment", async () => {
    const fake = fakeClaude([[{
      type: "result", subtype: "success", is_error: false, result: "", structured_output: { selected: [] }, session_id: "child-session",
    }]])
    const schema = { type: "object", properties: { selected: { type: "array" } } }
    const env = { ANTHROPIC_MODEL: "model[1m]", CLAUDECODE: "nested" }
    const branch = createMemoryBranch({ ...base, subprocessEnv: env }, fake)
    expect(await branch.ask("Select working memory", { schema })).toEqual({ selected: [] })
    expect(fake.calls[0].options?.outputFormat).toEqual({ type: "json_schema", schema })
    expect(fake.calls[0].options?.env?.ANTHROPIC_MODEL).toBe("model[1m]")
    expect(fake.calls[0].options?.env?.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDECODE).toBe("nested")
    branch.dispose()
  })

  test("first-turn branches explicitly report empty history and keep follow-ups", async () => {
    const fake = fakeClaude([claudeSuccess({}), claudeSuccess({})])
    const branch = createMemoryBranch({ ...base, parentSessionToken: null }, fake)
    expect(branch.mode).toBe("empty-history")
    await branch.ask("Analyze the initial user prompt")
    await branch.ask("Apply a review decision")
    expect(fake.calls[0].options?.resume).toBeUndefined()
    expect(fake.calls[0].options?.forkSession).toBe(false)
    expect(fake.calls[1].options?.resume).toBe("child-session")
    branch.dispose()
  })

  test("Claude fails closed on malformed JSON, API error, or accidental main-session reuse", async () => {
    for (const response of [
      [{ type: "result", subtype: "success", is_error: false, result: "not JSON", session_id: "child-session" }],
      [{ type: "result", subtype: "success", is_error: true, result: "{}", session_id: "child-session" }],
      claudeSuccess({}, "main-session"),
      [{ type: "result", subtype: "error_max_turns", session_id: "child-session" }],
    ]) {
      const fake = fakeClaude([response])
      const branch = createMemoryBranch(base, fake)
      await expect(branch.ask("Audit")).rejects.toThrow()
      expect(fake.calls).toHaveLength(1)
      branch.dispose()
    }
  })

  test("Codex forks once under native read-only sandbox and continues the same branch", async () => {
    const fake = fakeCodex()
    const branch = createMemoryBranch({ ...base, provider: "codex" }, fake)
    const schema = { type: "object", additionalProperties: true }
    expect(await branch.ask("Prepare transfers", { schema })).toEqual({ revised: 1 })
    expect(await branch.ask("Candidate was dismissed; recheck transfers")).toEqual({ revised: 2 })
    expect(fake.sessions).toHaveLength(1)
    expect(fake.sessions[0]).toMatchObject({ pendingForkSessionToken: "main-session", sandbox: "read-only", dynamicTools: [], disableExternalTools: true })
    expect(fake.turns.map((turn) => turn.chatId)).toEqual([branch.id, branch.id])
    expect(fake.turns[0].outputSchema).toBe(schema)
    expect(fake.turns[0].content).toContain("return every required field; use null only where allowed")
    expect(fake.turns[0].content).toContain(JSON.stringify(schema))
    expect(await fake.turns[0].onApprovalRequest?.({} as never)).toBe("decline")
    expect((await fake.turns[0].onDynamicToolCall?.("propose_memory", {}))?.isError).toBe(true)
    branch.dispose()
    expect(fake.stopped).toEqual([branch.id])
  })

  test("timeout kills a stalled transport and rejects queued follow-ups", async () => {
    let release: (() => void) | undefined
    let closed = false
    const claudeQuery: typeof query = () => Object.assign((async function* () {
      await new Promise<void>((resolve) => { release = resolve })
    })(), { close() { closed = true; release?.() } }) as unknown as Query
    const branch = createMemoryBranch({ ...base, timeoutMs: 5 }, { claudeQuery })
    const first = branch.ask("Prepare changes")
    const next = branch.ask("Follow up")
    await expect(first).rejects.toThrow("timed out")
    await expect(next).rejects.toThrow("retry explicitly")
    expect(closed).toBe(true)
    await expect(branch.ask("Retry without a known session")).rejects.toThrow("reopen memory preparation")
    branch.dispose()
  })

  test("Claude explicit retry after timeout resumes the same saved child", async () => {
    const calls: Parameters<typeof query>[0][] = []
    let release: (() => void) | undefined
    const claudeQuery: typeof query = (input) => {
      calls.push(input)
      const first = calls.length === 1
      return Object.assign((async function* () {
        yield { type: "system", subtype: "init", session_id: "saved-child" } as SDKMessage
        if (first) await new Promise<void>((resolve) => { release = resolve })
        else yield { type: "result", subtype: "success", is_error: false, session_id: "saved-child", result: '{"selected":[]}' } as SDKMessage
      })(), { close() { release?.() } }) as unknown as Query
    }
    const branch = createMemoryBranch({ ...base, timeoutMs: 5 }, { claudeQuery })
    await expect(branch.ask("Select working memory")).rejects.toThrow("timed out")
    expect(branch.sessionToken).toBe("saved-child")
    expect(await branch.ask("Retry the selection using your saved analysis")).toEqual({ selected: [] })
    expect(calls[0].options).toMatchObject({ resume: "main-session", forkSession: true })
    expect(calls[1].options).toMatchObject({ resume: "saved-child", forkSession: false })
    branch.dispose()
    await expect(branch.ask("Retry after Stop")).rejects.toThrow("disposed")
  })

  test("Codex timeout closes the process and reconnects to the same child with resume fallback disabled", async () => {
    const fake = fakeCodex()
    const normalTurn = fake.codexManager.startTurn.bind(fake.codexManager)
    let attempts = 0
    let release: (() => void) | undefined
    fake.codexManager.startTurn = async (args) => {
      if (++attempts > 1) return normalTurn(args)
      return { provider: "codex", interrupt: async () => {}, close() { release?.() }, stream: (async function* () {
        await new Promise<void>(resolve => { release = resolve })
      })() }
    }
    const branch = createMemoryBranch({ ...base, provider: "codex", timeoutMs: 5 }, fake)
    await expect(branch.ask("Select working memory")).rejects.toThrow("timed out")
    expect(fake.stopped).toEqual([branch.id])
    expect(await branch.ask("Retry selection")).toEqual({ revised: 1 })
    expect(fake.sessions).toHaveLength(2)
    expect(fake.sessions[0]).toMatchObject({ sessionToken: null, pendingForkSessionToken: "main-session" })
    expect(fake.sessions[1]).toMatchObject({ sessionToken: "codex-child", pendingForkSessionToken: null, allowResumeFallback: false, sandbox: "read-only", disableExternalTools: true })
    branch.dispose()
  })

  test("external cancellation rejects in-flight analysis and preserves its reason", async () => {
    let release: (() => void) | undefined
    const claudeQuery: typeof query = () => Object.assign((async function* () {
      await new Promise<void>((resolve) => { release = resolve })
    })(), { close() { release?.() } }) as unknown as Query
    const branch = createMemoryBranch(base, { claudeQuery })
    const controller = new AbortController()
    const result = branch.ask("Prepare candidates", { signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error("Developer stopped preparation"))
    await expect(result).rejects.toThrow("Developer stopped")
    await expect(branch.ask("Retry after Stop")).rejects.toThrow("disposed")
  })
})

describe("per-request branch budgets", () => {
  const permissionContext = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: `permission-${id}` })

  test("Claude default allows four parallel reads, denies the fifth, and always allows structured output", async () => {
    const fake = fakeClaude([claudeSuccess({})])
    const branch = createMemoryBranch(base, fake)
    await branch.ask("Inspect the project")
    const options = fake.calls[0].options!
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => options.canUseTool!("Read", { file_path: `file-${index}` }, permissionContext(`read-${index}`))))
    expect(results.map(result => result?.behavior)).toEqual(["allow", "allow", "allow", "allow", "deny"])
    expect(results[4]).toMatchObject({ message: expect.stringContaining("StructuredOutput now") })
    expect((await options.canUseTool!("StructuredOutput", {}, permissionContext("json")))?.behavior).toBe("allow")
    expect(options.maxTurns).toBe(6)
    expect(fake.calls[0].prompt).toContain("6 model turns and 4 actual read/tool calls")
    branch.dispose()
  })

  test("Claude review budget resets per ask; denied writes and repeat callbacks do not consume reads", async () => {
    const fake = fakeClaude([claudeSuccess({}), claudeSuccess({})])
    const branch = createMemoryBranch(base, fake)
    await branch.ask("Initial", { budget: { maxTurns: 3, maxToolCalls: 1 } })
    const first = fake.calls[0].options!.canUseTool!
    expect((await first("Write", {}, permissionContext("write")))?.behavior).toBe("deny")
    expect((await first("Read", {}, permissionContext("read-1")))?.behavior).toBe("allow")
    expect((await first("Read", {}, permissionContext("read-1")))?.behavior).toBe("allow")
    expect((await first("Grep", {}, permissionContext("read-2")))?.behavior).toBe("deny")
    await branch.ask("Review update", { budget: { maxTurns: 3, maxToolCalls: 1 } })
    expect(fake.calls[1].options?.maxTurns).toBe(3)
    expect((await fake.calls[1].options!.canUseTool!("Read", {}, permissionContext("read-3")))?.behavior).toBe("allow")
    expect(fake.calls[1].options?.resume).toBe("child-session")
    branch.dispose()
  })

  test("Claude schema repair with zero reads can still use StructuredOutput within two SDK turns", async () => {
    const fake = fakeClaude([claudeSuccess({})])
    const branch = createMemoryBranch(base, fake)
    await branch.ask("Repair schema", { budget: { maxTurns: 2, maxToolCalls: 0 } })
    const options = fake.calls[0].options!
    expect(options.maxTurns).toBe(2)
    expect((await options.canUseTool!("Read", {}, permissionContext("read")))?.behavior).toBe("deny")
    expect((await options.canUseTool!("StructuredOutput", {}, permissionContext("json")))?.behavior).toBe("allow")
    branch.dispose()
  })

  function codexEvents(events: HarnessEvent[]) {
    const fake = fakeCodex()
    let interrupts = 0
    fake.codexManager.startTurn = async args => {
      fake.turns.push(args)
      return { provider: "codex", interrupt: async () => { interrupts++ }, close() {},
        stream: (async function* () { for (const event of events) yield event })(),
      }
    }
    return { ...fake, interrupts: () => interrupts }
  }
  const toolCall = (id: string, name = "Bash"): HarnessEvent => ({ type: "transcript", entry: {
    kind: "tool_call", tool: { toolId: id, toolName: name, toolKind: "bash", input: { command: "cat file" } },
  } } as HarnessEvent)
  const answer: HarnessEvent = { type: "transcript", entry: { kind: "assistant_text", text: "{}" } } as HarnessEvent
  const completed: HarnessEvent = { type: "transcript", entry: { kind: "result", subtype: "success", isError: false, result: "" } } as HarnessEvent

  test("Codex interrupts on the first observed read overflow, including parallel tool calls", async () => {
    const fake = codexEvents([toolCall("read-1"), toolCall("read-2"), answer, completed])
    const branch = createMemoryBranch({ ...base, provider: "codex" }, fake)
    await expect(branch.ask("Review", { budget: { maxTurns: 3, maxToolCalls: 1 } })).rejects.toThrow("1-tool-call budget")
    expect(fake.interrupts()).toBe(1)
    expect(fake.stopped).toContain(branch.id)
    branch.dispose()
  })

  test("Codex deduplicates tool notifications and does not count results as another call", async () => {
    const fake = codexEvents([toolCall("read-1"), toolCall("read-1"), { type: "transcript", entry: { kind: "tool_result", toolId: "read-1", content: "result" } } as HarnessEvent, answer, completed])
    const branch = createMemoryBranch({ ...base, provider: "codex" }, fake)
    expect(await branch.ask("Review", { budget: { maxTurns: 2, maxToolCalls: 1 } })).toEqual({})
    expect(fake.interrupts()).toBe(0)
    expect(fake.turns[0].content).toContain("conservative visible-step limit")
    branch.dispose()
  })

  test("Codex visible-step budget stops a text-only response loop", async () => {
    const fake = codexEvents([answer, answer, answer, completed])
    const branch = createMemoryBranch({ ...base, provider: "codex" }, fake)
    await expect(branch.ask("Repair", { budget: { maxTurns: 2, maxToolCalls: 0 } })).rejects.toThrow("not an exact native model-turn count")
    expect(fake.interrupts()).toBe(1)
    expect(fake.stopped).toContain(branch.id)
    branch.dispose()
  })

  test("invalid budgets fail before opening a provider transport", async () => {
    const fake = fakeClaude([])
    const branch = createMemoryBranch(base, fake)
    for (const budget of [{ maxTurns: 0 }, { maxToolCalls: -1 }, { maxTurns: Number.POSITIVE_INFINITY }, { maxToolCalls: 1.5 }]) {
      await expect(branch.ask("Inspect", { budget })).rejects.toThrow("budget requires")
    }
    expect(fake.calls).toHaveLength(0)
    branch.dispose()
  })
})

describe("branch read access and structured result contract", () => {
  test("inspection works while shell escapes and executable helpers are rejected", async () => {
    for (const command of ["pwd", "ls -la src", "rg -n 'memory item' src", "cat package.json", "head -n 5 README.md"]) {
      expect(isReadOnlyBranchCommand(command)).toBe(true)
    }
    for (const command of [
      "rm file", "touch file", "bun test", "python script.py", "rg --pre=touch x", "rg --hostname-bin=program x",
      "cat file > changed", "cat file; touch changed", "cat $(touch changed)", "cat `touch changed`",
      "ls && echo ok", "ls | sh", "ls\ntouch file", "grep 'unterminated", "env cat file",
    ]) expect(isReadOnlyBranchCommand(command)).toBe(false)
    const permissionContext = { signal: new AbortController().signal, toolUseID: "read", requestId: "permission-read" }
    expect((await canUseMemoryBranchTool("Read", { file_path: "src/main.ts" }, permissionContext))?.behavior).toBe("allow")
    expect((await canUseMemoryBranchTool("Write", { file_path: "src/main.ts" }, permissionContext))?.behavior).toBe("deny")
    expect((await canUseMemoryBranchTool("Bash", { command: "rg memory src" }, permissionContext))?.behavior).toBe("allow")
    expect((await canUseMemoryBranchTool("Bash", { command: "bun run build" }, permissionContext))?.behavior).toBe("deny")
  })

  test("JSON parsing accepts an optional fence and rejects non-object payloads", () => {
    expect(parseMemoryBranchJson('```json\n{"labels": []}\n```')).toEqual({ labels: [] })
    expect(() => parseMemoryBranchJson("[]")).toThrow("JSON object")
    expect(() => parseMemoryBranchJson("null")).toThrow("JSON object")
    expect(() => parseMemoryBranchJson('Explanation: {"labels":[]}')).toThrow()
  })
})
