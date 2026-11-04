import { describe, expect, test } from "bun:test"
import { startClaudeSession } from "./agent"
import type { EngineRuntime } from "./model-access/runtime"

const runtime: EngineRuntime = { engine: "claude", model: "synthetic", env: {}, args: [], executable: { state: "ready", version: "2.1.241" }, isolated: true }

describe("persistent Claude Query execution controls", () => {
  test("rebinds native approval and question callbacks; old awaited replies cannot authorize a new turn", async () => {
    let options: any
    let release!: (value: boolean) => void
    let current = true, secondCalls = 0, secondQuestions = 0, applied = 0
    const modes: string[] = []
    const first = {
      permissionMode: "default" as const, isCurrent: () => current,
      approve: () => new Promise<boolean>(resolve => { release = resolve }),
      onToolRequest: async () => ({ answers: {} }), onApplied: async () => { applied++ },
    }
    const session = await startClaudeSession({
      localPath: "/tmp", model: "synthetic", planMode: false, sessionToken: null, forkSession: false, engineRuntime: runtime,
      onToolRequest: async () => { throw new Error("Boot callback must not handle later turns") }, executionControl: first,
      queryFn: ((args: any) => {
        options = args.options
        return { setPermissionMode: async (mode: string) => { modes.push(mode) }, close() {}, async *[Symbol.asyncIterator]() {} }
      }) as never,
    })
    const permissionArgs = { toolUseID: "request", signal: new AbortController().signal }
    const oldReply = options.canUseTool("Bash", { command: "first" }, permissionArgs)
    const second = {
      permissionMode: "acceptEdits" as const, isCurrent: () => true,
      approve: async () => { secondCalls++; return true },
      onToolRequest: async () => { secondQuestions++; return { answers: { Choice: "Yes" } } },
      onApplied: async () => { applied++ },
    }
    current = false
    session.setExecutionControl!(second)
    release(true)
    expect(await oldReply).toMatchObject({ behavior: "deny" })
    expect(await options.canUseTool("Bash", { command: "second" }, permissionArgs)).toMatchObject({ behavior: "allow" })
    expect(secondCalls).toBe(1)
    expect(await options.canUseTool("AskUserQuestion", { questions: [{ question: "Choice", header: "Choose", options: [{ label: "Yes" }, { label: "No" }] }] }, permissionArgs)).toMatchObject({ behavior: "allow", updatedInput: { answers: { Choice: "Yes" } } })
    expect(secondQuestions).toBe(1)
    await session.sendPrompt("second")
    expect(modes).toEqual(["acceptEdits"])
    expect(applied).toBe(1)
    await session.setPermissionMode(true)
    await session.sendPrompt("plan")
    expect(modes.slice(-2)).toEqual(["plan", "plan"])
    expect(applied).toBe(1)
    await session.setPermissionMode(false)
    await session.sendPrompt("execute")
    expect(modes.slice(-2)).toEqual(["acceptEdits", "acceptEdits"])
    expect(applied).toBe(2)
    session.close()
  })
})
