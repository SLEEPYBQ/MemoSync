import { afterEach, expect, spyOn, test } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startClaudeSession } from "../agent"
import { CodexAppServerManager } from "../codex-app-server"
import { createMemoryBranch } from "../memory/branch-runtime"
import { runForkQuery } from "../memory/fork-query"
import { runClaudeStructured } from "../quick-response"
import { deployedProviders } from "../provider-catalog"
import { buildRegistryModel } from "../pi-agent"
import { ModelAccessService, setModelAccessService } from "./service"
import { resolveEngineRuntime } from "./runtime"

const dirs: string[] = []
afterEach(() => { setModelAccessService(undefined); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ma-launch-")); dirs.push(directory)
  const service = await new ModelAccessService({ dataDir: directory, env: { HOME: directory, PATH: directory }, readLegacyPi: async () => null }).initialize()
  return { directory, service }
}

test("main Claude, quick response, memory branch and fork use the resolved executable and credentials", async () => {
  const { directory, service } = await fixture()
  const c = await service.saveConnection({ name: "Gateway", apiKey: "original-key", endpoints: [{ protocol: "anthropic-messages", baseUrl: "https://gateway.test" }], models: [{ id: "private-model", contextWindow: 1_000_000 }] })
  await service.setEngine("claude", { access: { mode: "connection", connectionId: c.id }, executablePath: "/fake/selected-claude" })
  setModelAccessService(service)
  const runtime = await resolveEngineRuntime({ engine: "claude" })
  const calls: sdk.Options[] = []
  const mock = spyOn(sdk, "query").mockImplementation(args => {
    calls.push(args.options ?? {})
    return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, session_id: "child", result: '{"ok":true}', structured_output: { ok: true } } }, close() {}, async setModel() {}, async interrupt() {} } as unknown as ReturnType<typeof sdk.query>
  })
  try {
    const main = await startClaudeSession({ localPath: directory, model: "private-model", sessionToken: null, forkSession: false, planMode: false, onToolRequest: async () => ({}), engineRuntime: runtime })
    await service.saveConnection({ ...c, apiKey: "new-key" })
    const branch = createMemoryBranch({ provider: "claude", parentSessionToken: "main", localPath: directory, model: runtime.model, runtime })
    expect(await branch.ask("Return JSON")).toEqual({ ok: true })
    expect(await runForkQuery({ sessionToken: "main", localPath: directory, prompt: "Return JSON", runtime })).toEqual({ ok: true })
    expect(await runClaudeStructured({ cwd: directory, task: "title", prompt: "Return JSON", schema: { type: "object", properties: { ok: { type: "boolean" } } } })).toEqual({ ok: true })
    expect(calls).toHaveLength(4)
    for (const options of calls) { expect(options.pathToClaudeCodeExecutable).toBe("/fake/selected-claude"); expect(options.env?.CLAUDE_CONFIG_DIR).toBe(runtime.env.CLAUDE_CONFIG_DIR); expect(options.settingSources).toEqual([]) }
    expect(calls.map(options => options.env?.ANTHROPIC_AUTH_TOKEN)).toEqual(["original-key", "original-key", "original-key", "new-key"])
    main.close(); branch.dispose()
  } finally { mock.mockRestore() }
})

test("Codex spawns the selected fake executable with Responses args, private env, and no credential argv", async () => {
  const { directory, service } = await fixture()
  const executable = join(directory, "fake-codex")
  writeFileSync(executable, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nfor await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line); if(m.id === undefined) continue; const result=m.method==='thread/start' ? {thread:{id:'fake-thread'}} : {}; process.stdout.write(JSON.stringify({id:m.id,result})+'\\n'); }\n`)
  chmodSync(executable, 0o700)
  const c = await service.saveConnection({ name: "Code", apiKey: "code-secret", endpoints: [{ protocol: "openai-responses", baseUrl: "https://code.test/v1" }], models: [{ id: "code-model", contextWindow: 400_000 }] })
  await service.setEngine("codex", { access: { mode: "connection", connectionId: c.id }, executablePath: executable })
  const runtime = await resolveEngineRuntime({ engine: "codex", service })
  expect(runtime.args.join(" ")).not.toContain("code-secret")
  expect(runtime.env.MEMOSYNC_MODEL_API_KEY).toBe("code-secret")
  const manager = new CodexAppServerManager()
  try { expect(await manager.startSession({ chatId: "test", cwd: directory, model: runtime.model, sessionToken: null, runtime })).toBe("fake-thread") }
  finally { manager.stopAll() }
})

test("catalog keeps duplicate model ids distinct by connection and Pi uses the chosen native API", async () => {
  const { service } = await fixture()
  const endpoints = [{ protocol: "openai-chat" as const, baseUrl: "http://127.0.0.1:1234/v1" }, { protocol: "anthropic-messages" as const, baseUrl: "http://127.0.0.1:1234" }]
  const a = await service.saveConnection({ name: "A", endpoints, models: [{ id: "same-model", contextWindow: 500000 }] })
  const b = await service.saveConnection({ name: "B", endpoints, models: [{ id: "same-model" }] })
  setModelAccessService(service)
  const models = deployedProviders().find(p => p.id === "claude")!.models
  expect(models.filter(m => m.id === "same-model").map(m => [m.connectionId, m.vendor])).toEqual([[a.id, "A"], [b.id, "B"]])
  expect(models.some(m => m.id === "sonnet")).toBe(true)
  expect(deployedProviders().find(p => p.id === "codex")!.models.some(m => m.connectionId)).toBe(false)
  const runtime = await resolveEngineRuntime({ engine: "pi", connectionId: a.id, service })
  expect(buildRegistryModel(runtime.piConnection!, runtime.model).api).toBe("openai-completions")
  expect(buildRegistryModel({ ...runtime.piConnection!, protocol: "openai-responses" }, runtime.model).api).toBe("openai-responses")
  expect(buildRegistryModel(runtime.piConnection!, runtime.model).contextWindow).toBe(500000)
})
