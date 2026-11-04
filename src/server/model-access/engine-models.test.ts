import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeModelsFrom, codexModelsFrom, readEngineModels } from "./engine-models"

describe("claudeModelsFrom", () => {
  test("preserves exact IDs, resolved aliases and effort capabilities from the CLI", () => {
    const read = claudeModelsFrom([
      { value: "default", displayName: "Default (recommended)" },
      { value: "opus", displayName: "Opus", supportsEffort: true, resolvedModel: "claude-opus-live", supportedEffortLevels: ["low", "high", "max"] },
      { value: "claude-fable-5-1[1m]", displayName: "Fable" },
      { value: "sonnet", displayName: "Sonnet", supportsEffort: false },
    ])
    expect(read?.models.map(model => model.id)).toEqual(["opus", "claude-fable-5-1[1m]", "sonnet"])
    expect(read?.models[0]).toEqual({ id: "opus", label: "Opus · claude-opus-live", resolvedModel: "claude-opus-live", supportsEffort: true, aliases: ["claude-opus-live"], reasoningEfforts: ["low", "high", "max"] })
    expect(read?.models[2]).toEqual({ id: "sonnet", label: "Sonnet", supportsEffort: false, reasoningEfforts: [] })
    expect(read?.defaultModel).toBe("sonnet")
  })

  test("shows versions from actual CLI metadata while keeping invocation aliases", () => {
    const read = claudeModelsFrom([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
      { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" },
      { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
      { value: "claude-fable-5-1[1m]", displayName: "Fable" },
    ])
    expect(read?.models.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "opus", label: "Opus 5.5" },
      { id: "fable", label: "Fable 5.1" },
      { id: "sonnet", label: "Sonnet 5.5" },
      { id: "haiku", label: "Haiku 5.5" },
      { id: "claude-fable-5-1[1m]", label: "Fable 5.1 [1m]" },
    ])
    expect(read?.models[2]?.resolvedModel).toBe("claude-sonnet-5-5")
    expect(read?.defaultModel).toBe("opus")
  })

  test("does not invent a version when the CLI only reports an alias", () => {
    expect(claudeModelsFrom([{ value: "sonnet", displayName: "Sonnet" }])?.models[0]?.label).toBe("Sonnet")
    expect(claudeModelsFrom([{ value: "claude-haiku-4-5-20251001", displayName: "Haiku" }])?.models[0]?.label).toBe("Haiku 4.5")
  })

  test("defaults to the first model when an account has no Sonnet", () => {
    expect(claudeModelsFrom([{ value: "opus" }])?.defaultModel).toBe("opus")
  })

  test("an empty answer leaves the fallback in place", () => {
    expect(claudeModelsFrom([{ value: "default" }])).toBeNull()
  })
})

describe("codexModelsFrom", () => {
  test("uses the account's models, effort choices and marked default", () => {
    const read = codexModelsFrom([
      { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }], defaultReasoningEffort: "ultra" },
      { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", supportedReasoningEfforts: [] },
      { id: "secret", model: "secret", hidden: true },
    ])
    expect(read?.models).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", supportsEffort: true, reasoningEfforts: ["low", "ultra"], defaultReasoningEffort: "ultra" },
      { id: "gpt-6-luna", label: "GPT-6-Luna", supportsEffort: false, reasoningEfforts: [] },
    ])
    expect(read?.defaultModel).toBe("gpt-6.1-sol")
  })

  test("an empty answer leaves the fallback in place", () => {
    expect(codexModelsFrom([])).toBeNull()
    expect(codexModelsFrom([{ id: "hidden", hidden: true }])).toBeNull()
  })
})

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** A synthetic JSON-RPC executable; it cannot access a real CLI profile or network. */
function fakeCodex(scenario: "pages" | "initialize-error" | "exit" | "close-stdout" | "cursor-loop" | "hang") {
  const directory = mkdtempSync(join(tmpdir(), "memosync-engine-models-"))
  directories.push(directory)
  const home = join(directory, "home")
  mkdirSync(home)
  const executable = join(directory, "codex.cjs")
  const requests = join(directory, "requests.jsonl")
  const pidFile = join(directory, "pid")
  writeFileSync(executable, `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const scenario = ${JSON.stringify(scenario)};
const reply = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');
  if (message.method === 'initialize') {
    if (scenario === 'initialize-error') process.stdout.write(JSON.stringify({id:message.id,error:{code:-1,message:'synthetic'}}) + '\\n');
    else reply(message.id, {userAgent:'fixture'});
  }
  if (message.method !== 'model/list') return;
  if (scenario === 'exit') process.exit(0);
  if (scenario === 'close-stdout') { fs.closeSync(1); return; }
  if (scenario === 'hang' && message.params.cursor) return;
  if (message.params.cursor === null) reply(message.id, {data:[{id:'first',model:'first',displayName:'First',supportedReasoningEfforts:[]}], nextCursor:'page-2'});
  else reply(message.id, {data:[{id:'second',model:'second',displayName:'Second',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:scenario === 'cursor-loop' ? 'page-2' : null});
});
`)
  // Bun keeps internal duplicates of stdout even after closeSync(1). A native
  // shell closes the actual output pipe while staying alive on stdin.
  const entry = scenario === "close-stdout" ? join(directory, "codex") : executable
  if (scenario === "close-stdout") {
    writeFileSync(entry, `#!/bin/sh
printf '%s' "$$" > '${pidFile}'
read -r init
printf '%s\\n' '{"id":1,"result":{}}'
read -r notification
read -r list
exec 1>&-
read -r pending
`)
    chmodSync(entry, 0o700)
  }
  return {
    read: () => readEngineModels("codex", entry, { HOME: home, CODEX_HOME: join(home, ".codex"), PATH: "" }),
    requests: () => readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line)),
    assertStopped: () => {
      const pid = Number(readFileSync(pidFile, "utf8"))
      let running = false
      try { process.kill(pid, 0); running = true } catch { /* The synthetic child was reaped. */ }
      expect(running).toBe(false)
    },
  }
}

describe("Codex model/list protocol", () => {
  test("reads every page before choosing the default and reaps the temporary process", async () => {
    const fixture = fakeCodex("pages")
    const result = await fixture.read()
    expect(result?.models.map(model => model.id)).toEqual(["first", "second"])
    expect(result?.defaultModel).toBe("second")
    expect(fixture.requests().filter(message => message.method === "model/list").map(message => message.params.cursor)).toEqual([null, "page-2"])
    fixture.assertStopped()
  })

  for (const [scenario, error] of [
    ["initialize-error", "engine-models-initialize-failed"],
    ["exit", "engine-models-"],
    ["close-stdout", "engine-models-stdout-closed"],
    ["cursor-loop", "engine-models-cursor-loop"],
  ] as const) {
    test.skipIf(process.platform === "win32" && scenario === "close-stdout")(`rejects ${scenario} and cleans up the process`, async () => {
      const fixture = fakeCodex(scenario)
      await expect(fixture.read()).rejects.toThrow(error)
      if (scenario === "initialize-error") expect(fixture.requests().some(message => message.method === "model/list")).toBe(false)
      fixture.assertStopped()
    })
  }

  test("the overall deadline also covers a hung later page", async () => {
    const fixture = fakeCodex("hang")
    await expect(fixture.read()).rejects.toThrow("engine-models-timeout")
    fixture.assertStopped()
  }, 20_000)
})
