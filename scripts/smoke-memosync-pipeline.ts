/** Real application orchestration against GLM, in an automatically removed CLI profile. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "../src/server/agent"
import { EventStore } from "../src/server/event-store"
import { CodexAppServerManager } from "../src/server/codex-app-server"
import { MemoryService } from "../src/server/memory"
import { createCaptureService } from "../src/server/memory/capture"
import { createCheckupService } from "../src/server/memory/checkup"
import { createTransferDetectService } from "../src/server/memory/transfer-detect"
import { createTransferService } from "../src/server/memory/transfer"
import { createTraceService } from "../src/server/memory/trace"
import { createMemoryBranch } from "../src/server/memory/branch-runtime"
import { resolveConditionPolicy } from "../src/server/experiment/condition"
import type { AgentProvider, TranscriptEntry } from "../src/shared/types"

const key = process.env.GLM_API_KEY?.trim()
if (!key) throw new Error("Set GLM_API_KEY in the environment")
const provider = process.argv[2] ?? "claude"
if (provider !== "claude" && provider !== "codex") throw new Error("Usage: bun run scripts/smoke-memosync-pipeline.ts [claude|codex]")
const directory = realpathSync(mkdtempSync(join(tmpdir(), "memosync-live-pipeline-")))
const workspace = join(directory, "project")
mkdirSync(workspace)
Object.assign(process.env, {
  MEMOSYNC_ISOLATE_CLI: "1",
  MEMOSYNC_CLI_PROFILE_DIR: join(directory, "profiles"),
  MEMOSYNC_CODEX_PROVIDER: "glm",
  MEMOSYNC_CODEX_MODEL: process.env.GLM_MODEL?.trim() || "glm-5.3-flash",
})
const model = process.env.GLM_MODEL?.trim() || "glm-5.3-flash"
const fixture = "314159"
writeFileSync(join(workspace, "project-proof.txt"), fixture)
const store = new EventStore(join(directory, "events"))
await store.initialize()
const project = await store.openProject(workspace, "MemoSync isolated smoke project")
const chat = await store.createChat(project.id)
const branchEvents: Array<Record<string, unknown>> = []
const memory = new MemoryService({
  dbPath: ":memory:", dataDir: join(directory, "memory"),
  logger: { event: (event) => { if (event.type === "memory.branch") branchEvents.push(event) } },
})
const rule = memory.store.create({ content: "After reading project-proof.txt, include its exact contents and the word VERIFIED in your final reply.", type: "constraint", scope: "project", projectId: project.id }, { actor: "user" })
let sidecarCalls = 0
const forbidden = async (): Promise<Record<string, unknown>> => { sidecarCalls++; throw new Error("An independent memory sidecar was called") }
const codexManager = new CodexAppServerManager()
const coordinator = new AgentCoordinator({
  store, memory, memoryBranches: true, memoryPreview: true, codexManager,
  createMemoryBranch: (input) => {
    const branch = createMemoryBranch(input)
    let calls = 0
    return {
      id: branch.id, mode: branch.mode,
      get sessionToken() { return branch.sessionToken },
      dispose: () => branch.dispose(),
      ask: async (prompt, options) => {
        const call = ++calls
        const started = Date.now()
        console.log(`${provider}: ${input.purpose} ${branch.mode} request ${call} started`)
        try {
          const result = await branch.ask(prompt, options)
          console.log(`${provider}: ${input.purpose} request ${call} completed in ${Math.round((Date.now() - started) / 1000)}s`)
          return result
        } catch (error) {
          console.log(`${provider}: ${input.purpose} request ${call} failed after ${Math.round((Date.now() - started) / 1000)}s`)
          throw error
        }
      },
    }
  },
  policy: { ...resolveConditionPolicy("memosync"), studyMode: false },
  onStateChange: () => {},
  generateTitle: async () => ({ title: "GLM pipeline smoke", usedFallback: true, failureMessage: null }),
  capture: createCaptureService({ memory, callJson: forbidden }),
  memoryCheckup: createCheckupService({ memory, callJson: forbidden, listRecentSessions: () => [] }),
  memoryTransferDetect: createTransferDetectService({ memory, callJson: forbidden, transfer: createTransferService({ callJson: forbidden }), listProjects: () => [project], listRecentSessions: () => [] }),
  memoryTrace: createTraceService({ callJson: forbidden }),
  getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: false }),
})
const handled = new Set<string>()
const deadline = Date.now() + 10 * 60_000

async function review(messages: TranscriptEntry[]) {
  for (const entry of messages) {
    if (entry.kind === "memory_proposals" && !handled.has(entry.proposalsId)) {
      const result = messages.find((row) => row.kind === "memory_proposals_result" && row.proposalsId === entry.proposalsId)
      if (!result || messages.some((row) => row.kind === "memory_proposals_decision" && row.proposalsId === entry.proposalsId)) continue
      for (const candidate of memory.store.list({ status: "candidate" }).filter((item) => item.provenanceSessionId === chat.id)) {
        if (!candidate.sensitive) memory.store.update(candidate.id, { status: "active" }, { actor: "user" })
      }
      await coordinator.respondMemoryProposals({ chatId: chat.id, proposalsId: entry.proposalsId, decision: "reviewed" })
      handled.add(entry.proposalsId)
      console.log(`${provider}: candidate review completed`)
    }
    if (entry.kind === "memory_transfer" && !handled.has(entry.transferId)) {
      const result = messages.find((row) => row.kind === "memory_transfer_result" && row.transferId === entry.transferId && row.done)
      if (!result || result.kind !== "memory_transfer_result" || result.suggestions.length === 0 || messages.some((row) => row.kind === "memory_transfer_decision" && row.transferId === entry.transferId)) continue
      await coordinator.respondMemoryTransfer({ chatId: chat.id, transferId: entry.transferId, decision: "skipped" })
      handled.add(entry.transferId)
    }
    if (entry.kind === "memory_checkup" && !handled.has(entry.checkupId)) {
      const result = messages.find((row) => row.kind === "memory_checkup_result" && row.checkupId === entry.checkupId)
      if (!result || result.kind !== "memory_checkup_result" || result.suggestions.length === 0 || messages.some((row) => row.kind === "memory_checkup_decision" && row.checkupId === entry.checkupId)) continue
      await coordinator.respondMemoryCheckup({ chatId: chat.id, checkupId: entry.checkupId, decision: "skipped" })
      handled.add(entry.checkupId)
    }
    if (entry.kind === "memory_preview" && !handled.has(entry.previewId)) {
      const relevance = messages.filter((row) => row.kind === "memory_preview_relevance" && row.previewId === entry.previewId).at(-1)
      if (!relevance || relevance.kind !== "memory_preview_relevance") continue
      if (relevance.error) throw new Error(`Working memory branch failed: ${relevance.error}`)
      const ids = relevance.relevant.map((item) => item.id)
      if (!ids.includes(rule.id)) throw new Error("Working-memory branch omitted the enforced smoke rule")
      await coordinator.respondMemoryPreview({ chatId: chat.id, previewId: entry.previewId, decision: "go_on", memoryIds: ids })
      handled.add(entry.previewId)
      console.log(`${provider}: working-memory review confirmed ${ids.length} item(s)`)
    }
  }
}

try {
  for (const turn of [1, 2]) {
    const from = store.getMessages(chat.id).length
    memory.store.setKv(`pay_attention:${chat.id}`, [{ id: rule.id }])
    await coordinator.send({
      type: "chat.send", chatId: chat.id, provider: provider as AgentProvider, model, effort: "low",
      content: turn === 1
        ? "Remember for this project: use Bun for any future package scripts. For this turn, read project-proof.txt and report its contents. Do not modify files or run other commands."
        : "Read project-proof.txt again and report its contents. Follow the project memory rules. Do not modify files or run other commands.",
    })
    while (true) {
      if (Date.now() > deadline) throw new Error("Live application pipeline exceeded its 10-minute limit")
      const messages = store.getMessages(chat.id).slice(from)
      if (store.requireChat(chat.id).lastTurnOutcome === "failed") throw new Error("Application turn failed; inspect retained smoke artifacts for the status entry")
      if (messages.some((entry) => entry.kind === "memory_checkup_decision" && entry.decision === "failed")) throw new Error("The memory-change branch failed; this is not a successful full pipeline run")
      await review(messages)
      const trace = messages.filter((entry) => entry.kind === "memory_trace" && entry.status !== "pending").at(-1)
      if (trace?.kind === "memory_trace") {
        if (trace.status !== "ok") throw new Error(`Audit failed with status ${trace.status}`)
        if (!trace.labels.some((label) => label.id === rule.id)) throw new Error("Audit omitted the injected smoke rule")
        const final = messages.filter((entry): entry is Extract<TranscriptEntry, { kind: "assistant_text" }> => entry.kind === "assistant_text").map((entry) => entry.text).join("\n")
        if (!final.includes(fixture) || !final.includes("VERIFIED")) throw new Error("Main reply did not follow the injected smoke rule")
        console.log(`${provider}: application turn ${turn} completed with ${trace.labels.length} audit verdict(s)`)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  if (sidecarCalls !== 0) throw new Error("Application invoked an independent memory sidecar")
  if (readFileSync(join(workspace, "project-proof.txt"), "utf8") !== fixture) throw new Error("Application changed the fixture")
  const forks = branchEvents.filter((event) => event.mode === "fork")
  if (!["candidate", "transfer", "changes", "working-memory", "audit"].every((purpose) => forks.some((event) => event.purpose === purpose))) throw new Error("Second application turn did not use all required forked stages")
  console.log(JSON.stringify({ provider, status: "passed", turns: 2, branchCount: branchEvents.length, realForks: forks.length, sidecarCalls }))
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error).replaceAll(key, "[redacted]"))
  process.exitCode = 1
} finally {
  await coordinator.cancel(chat.id).catch(() => {})
  await coordinator.shutdownStudyRuntime()
  codexManager.stopAll()
  memory.close()
  if (process.env.MEMOSYNC_KEEP_SMOKE_ARTIFACTS === "1") console.log(`Smoke artifacts: ${directory}`)
  else rmSync(directory, { recursive: true, force: true })
}
