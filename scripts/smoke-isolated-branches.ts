/** Live transport check. Supply GLM_API_KEY in the environment; never pass a key on argv. */
import { query } from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildClaudeSdkRuntimeOptions } from "../src/server/agent"
import { CodexAppServerManager } from "../src/server/codex-app-server"
import { createMemoryBranch, type MemoryBranch, parseMemoryBranchJson } from "../src/server/memory/branch-runtime"
import { buildIsolatedClaudeEnv, DEFAULT_GLM_MODEL } from "../src/server/provider-runtime"
import type { AgentProvider } from "../src/shared/types"

if (!process.env.GLM_API_KEY?.trim()) throw new Error("Set GLM_API_KEY in the environment before running the isolated smoke test")
const requested = process.argv.slice(2)
if (requested.some((name) => name !== "claude" && name !== "codex")) throw new Error("Usage: bun run scripts/smoke-isolated-branches.ts [claude] [codex]")
const providers = (requested.length ? requested : ["claude", "codex"]) as AgentProvider[]
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "memosync-live-branches-")))
const profile = join(workspace, "profiles")
const model = process.env.GLM_MODEL?.trim() || DEFAULT_GLM_MODEL
const baseEnv = {
  ...process.env,
  MEMOSYNC_ISOLATE_CLI: "1",
  MEMOSYNC_CLI_PROFILE_DIR: profile,
  MEMOSYNC_CODEX_PROVIDER: "glm",
  MEMOSYNC_CODEX_MODEL: model,
  DEEPSEEK_API_KEY: undefined,
  MEMOSYNC_USE_OWN_ANTHROPIC: undefined,
}
const proof = `fixture-${randomUUID()}`
writeFileSync(join(workspace, "project-proof.txt"), proof)
const summaries: Record<string, unknown>[] = []

async function smoke(provider: AgentProvider) {
  const codex = new CodexAppServerManager()
  const chatId = `smoke-main-${randomUUID()}`
  const contextToken = `context-${randomUUID()}`
  const reviewToken = `review-${randomUUID()}`
  const branches: MemoryBranch[] = []
  let parentToken: string | null = null
  const claudeRuntime = buildClaudeSdkRuntimeOptions({ requestedModel: model, env: buildIsolatedClaudeEnv(baseEnv) })
  const subprocessEnv = provider === "claude" ? claudeRuntime.env : baseEnv

  async function main(prompt: string): Promise<string> {
    if (provider === "claude") {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      const q = query({ prompt, options: {
        cwd: workspace,
        model: claudeRuntime.model,
        env: claudeRuntime.env,
        settings: claudeRuntime.settings,
        settingSources: [],
        resume: parentToken ?? undefined,
        tools: [],
        maxTurns: 2,
        effort: "low",
        abortController: controller,
      } })
      try {
        for await (const message of q) {
          if ("session_id" in message && typeof message.session_id === "string") parentToken = message.session_id
          if (message.type === "result") {
            if (message.subtype !== "success") throw new Error(`Claude main failed: ${message.subtype}`)
            return message.result
          }
        }
        throw new Error("Claude main ended without a result")
      } finally {
        clearTimeout(timer)
        q.close()
      }
    }
    if (!parentToken) {
      parentToken = await codex.startSession({ chatId, cwd: workspace, model, sessionToken: null, subprocessEnv: baseEnv, sandbox: "read-only" })
    }
    const turn = await codex.startTurn({ chatId, model, content: prompt, planMode: false, effort: "low", onToolRequest: async () => ({ error: "No interactive prompts in smoke test" }) })
    const timer = setTimeout(() => { void turn.interrupt() }, 120_000)
    let output = ""
    try {
      for await (const event of turn.stream) {
        if (event.type !== "transcript" || !event.entry) continue
        if (event.entry.kind === "assistant_text") output = event.entry.text
        if (event.entry.kind === "result" && event.entry.isError) throw new Error("Codex main turn failed")
      }
      return output
    } finally {
      clearTimeout(timer)
      turn.close()
    }
  }

  function branch(purpose: string) {
    const next = createMemoryBranch({ provider, parentSessionToken: parentToken, localPath: workspace, model: provider === "claude" ? claudeRuntime.model : model, effort: "low", subprocessEnv, timeoutMs: 120_000, purpose })
    branches.push(next)
    return next
  }

  try {
    await main(`Remember this private context token for the current coding conversation: ${contextToken}. Reply only READY. Do not inspect files or use tools.`)
    if (!parentToken) throw new Error("Parent session did not return its identifier")
    const parallel = [branch("candidate"), branch("transfer"), branch("changes")]
    const prepared = await Promise.all(parallel.map(async (current) => {
      const answer = await current.ask('Recall the private context token from the inherited coding conversation. Read project-proof.txt. Reply only JSON {"contextToken":"the token", "proof":"exact file contents"}.')
      if (answer.contextToken !== contextToken || answer.proof !== proof) throw new Error("Fork failed to inherit context or inspect the project fixture")
      return current.sessionToken
    }))
    if (new Set(prepared).size !== 3 || prepared.includes(parentToken)) throw new Error("Parallel branches did not obtain separate child sessions")
    const transferToken = parallel[1]!.sessionToken
    const revised = await parallel[1]!.ask(`Developer review: the candidate was dismissed. Record review code ${reviewToken}. Return JSON {"reviewCode":"${reviewToken}","contextToken":"the original private context token"}.`)
    if (revised.reviewCode !== reviewToken || revised.contextToken !== contextToken || parallel[1]!.sessionToken !== transferToken) throw new Error("Review did not continue the original transfer branch")
    writeFileSync(join(workspace, "approved-memory.json"), JSON.stringify({ items: [{ id: "M-07", content: "Use a stable ordering." }] }))
    const working = branch("working-memory")
    const selected = await working.ask('Read approved-memory.json, which contains the updated memory store after review. Select its memory and give expected use. Return JSON {"selectedId":"selected item id","expectedUse":"what it will affect","contextToken":"original private context token"}.')
    if (selected.selectedId !== "M-07" || selected.contextToken !== contextToken || typeof selected.expectedUse !== "string") throw new Error("Working memory did not select from the updated store in a fork")
    const mainResult = parseMemoryBranchJson(await main('Do not inspect files or use tools. Based only on our conversation, return JSON {"contextToken":"the private context token", "reviewCode":null} unless a developer review code was explicitly given in our conversation, in which case report that code.'))
    if (mainResult.contextToken !== contextToken || mainResult.reviewCode !== null) throw new Error("A branch review contaminated the main conversation")
    const audit = branch("audit")
    const audited = await audit.ask('Audit the latest main reply. Return JSON {"contextToken":"the private context token in that reply","reviewCode":null} if no review code appeared in the main reply.')
    if (audited.contextToken !== contextToken || audited.reviewCode !== null) throw new Error("Audit did not inherit the completed main turn")
    if (readFileSync(join(workspace, "project-proof.txt"), "utf8") !== proof) throw new Error("A memory branch changed the project fixture")
    console.log(`${provider}: parent, three parallel forks, review continuation, working-memory fork, main isolation, and audit fork passed`)
    summaries.push({ provider, status: "passed", parallelBranches: prepared.length, workingMemory: true, audit: true })
  } finally {
    for (const current of branches) current.dispose()
    codex.stopSession(chatId)
  }
}

try {
  for (const provider of providers) await smoke(provider)
  console.log(JSON.stringify(summaries))
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
