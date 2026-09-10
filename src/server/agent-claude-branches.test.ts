import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { MemoryService } from "./memory"
import { createCaptureService } from "./memory/capture"
import { createCheckupService } from "./memory/checkup"
import { createTransferDetectService } from "./memory/transfer-detect"
import { createTransferService } from "./memory/transfer"
import { createTraceService } from "./memory/trace"
import type { MemoryBranchInput } from "./memory/branch-runtime"
import type { AgentProvider, TranscriptEntry } from "../shared/types"
import type { HarnessEvent } from "./harness-types"
import { resolveConditionPolicy } from "./experiment/condition"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 4_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Coordinator did not reach the expected gate")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class Queue implements AsyncIterable<HarnessEvent> {
  private values: HarnessEvent[] = []
  private waiter: ((value: IteratorResult<HarnessEvent>) => void) | null = null
  private closed = false
  push(value: HarnessEvent) {
    if (this.waiter) { const next = this.waiter; this.waiter = null; next({ value, done: false }) }
    else this.values.push(value)
  }
  close() { this.closed = true; this.waiter?.({ value: undefined, done: true }); this.waiter = null }
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    return { next: async () => this.values.length ? { value: this.values.shift()!, done: false } : this.closed ? { value: undefined, done: true } : await new Promise((resolve) => { this.waiter = resolve }) }
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(provider: AgentProvider, failCandidate = false) {
  const directory = mkdtempSync(join(tmpdir(), "memosync-coordinator-branches-"))
  const store = new EventStore(join(directory, "events"))
  await store.initialize()
  const project = await store.openProject(directory, "Test project")
  const chat = await store.createChat(project.id)
  await store.setSessionToken(chat.id, "parent-before-turn")
  const memory = new MemoryService({ dbPath: ":memory:", dataDir: join(directory, "memory") })
  const rule = memory.store.create({ content: "Sort numeric results in ascending order", type: "constraint", scope: "project", projectId: project.id }, { actor: "user" })
  let sidecarCalls = 0
  const forbidden = async (): Promise<Record<string, unknown>> => { sidecarCalls++; throw new Error("Unexpected independent sidecar") }
  const candidate = deferred<Record<string, unknown>>()
  const created: MemoryBranchInput[] = []
  const calls: Array<{ purpose: string; prompt: string }> = []
  const disposed: string[] = []
  const mainPrompts: string[] = []
  const mainOptions: Array<Record<string, unknown>> = []
  const events = new Queue()
  const finishedMain = () => {
    events.push({ type: "session_token", sessionToken: "parent-after-turn" })
    events.push({ type: "transcript", origin: "human", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "assistant_text", text: "Sorted 1, 2, 3." } })
    events.push({ type: "transcript", origin: "human", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "result", subtype: "success", isError: false, durationMs: 1, result: "Sorted 1, 2, 3." } })
  }
  const coordinator = new AgentCoordinator({
    store, memory, memoryBranches: true, memoryPreview: true,
    policy: { ...resolveConditionPolicy("memosync"), studyMode: false },
    onStateChange: () => {},
    claudeSessionFileExists: () => true,
    generateTitle: async () => ({ title: "Test", usedFallback: true, failureMessage: null }),
    capture: createCaptureService({ memory, callJson: forbidden }),
    memoryCheckup: createCheckupService({ memory, callJson: forbidden, listRecentSessions: () => [] }),
    memoryTransferDetect: createTransferDetectService({ memory, callJson: forbidden, transfer: createTransferService({ callJson: forbidden }), listProjects: () => [project], listRecentSessions: () => [] }),
    memoryTrace: createTraceService({ callJson: forbidden }),
    memoryRelevance: { assess: forbidden } as never,
    memoryUsePlan: { plan: forbidden } as never,
    forkQuery: forbidden,
    forkTrace: forbidden as never,
    forkCapture: forbidden as never,
    getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: false }),
    createMemoryBranch(input) {
      created.push(input)
      const purpose = input.purpose!
      let asks = 0
      return {
        id: `branch-${purpose}`, mode: "fork", sessionToken: `child-${purpose}`,
        async ask(prompt) {
          calls.push({ purpose, prompt })
          asks++
          if (purpose === "candidate") return await candidate.promise
          if (asks > 1 && (purpose === "transfer" || purpose === "changes")) return { upsert: {}, remove: {} }
          if (purpose === "transfer") return { suggestions: [], analysis: "BRANCH_PRIVATE" }
          if (purpose === "changes") return { conflicts: [], redundancy: [], staleness: [], analysis: "BRANCH_PRIVATE" }
          if (purpose === "working-memory") return { selected: [{ id: rule.id, why: "Sorting numeric output", expectedUse: "Return the numbers in ascending order." }], analysis: "BRANCH_PRIVATE" }
          if (purpose === "audit") return { labels: [{ id: rule.id, label: "shaped", note: "The visible output is sorted", quote: "Sorted 1, 2, 3." }], analysis: "BRANCH_PRIVATE" }
          throw new Error(`Unexpected branch ${purpose}`)
        },
        dispose() { disposed.push(purpose) },
      }
    },
    startClaudeSession: async (options) => {
      mainOptions.push(options)
      return { provider: "claude", stream: events, interrupt: async () => {}, close: () => events.close(), setModel: async () => {}, setPermissionMode: async () => {}, sendPrompt: async (prompt) => { mainPrompts.push(prompt) } }
    },
    codexManager: {
      async startSession(options: Record<string, unknown>) { mainOptions.push(options); return "parent-before-turn" },
      async startTurn(options: { content: string; developerInstructions?: string | null }) {
        mainPrompts.push(`${options.content}\n${options.developerInstructions ?? ""}`)
        return { provider: "codex", stream: events, interrupt: async () => {}, close: () => events.close() }
      },
      stopSession() { events.close() },
      stopAll() { events.close() },
    } as never,
  })
  cleanups.push(async () => {
    events.close()
    await coordinator.shutdownStudyRuntime()
    memory.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await coordinator.send({ type: "chat.send", chatId: chat.id, provider, model: provider === "claude" ? "glm-5.3-flash" : "gpt-5.5", content: "Return the numbers 3, 1, 2 sorted. For this project remember to use Bun for scripts." })
  await until(() => calls.length === 3)
  if (failCandidate) candidate.reject(new Error("Candidate branch transport failed"))
  return { store, chat, memory, rule, coordinator, candidate, created, calls, disposed, mainOptions, mainPrompts, finishedMain, sidecarCalls: () => sidecarCalls }
}

describe("coordinator provider branches", () => {
  test("switching Claude vendors rebuilds the query with the same conversation token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memosync-vendor-switch-"))
    const store = new EventStore(join(directory, "events"))
    await store.initialize()
    const project = await store.openProject(directory)
    const chat = await store.createChat(project.id)
    const starts: Array<{ model: string; sessionToken: string | null; subprocessEnv?: Record<string, string | undefined> }> = []
    const setModels: string[] = []
    let results = 0
    const coordinator = new AgentCoordinator({
      store, onStateChange: () => {}, claudeSessionFileExists: () => true,
      generateTitle: async () => ({ title: "Vendor switch", usedFallback: true, failureMessage: null }),
      startClaudeSession: async (options) => {
        starts.push(options)
        const queue = new Queue()
        return {
          provider: "claude", stream: queue, interrupt: async () => {}, close: () => queue.close(),
          setModel: async (model) => { setModels.push(model) }, setPermissionMode: async () => {},
          sendPrompt: async () => {
            queue.push({ type: "session_token", sessionToken: "shared-conversation" })
            queue.push({ type: "transcript", origin: "human", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "result", subtype: "success", isError: false, durationMs: 1, result: "Ready" } })
            results++
          },
        }
      },
    })
    cleanups.push(async () => { await coordinator.shutdownStudyRuntime(); rmSync(directory, { recursive: true, force: true }) })
    for (const [index, model] of ["deepseek-v4-flash", "glm-5.3-flash", "sonnet"].entries()) {
      await coordinator.send({ type: "chat.send", chatId: chat.id, provider: "claude", model, content: "Reply ready" })
      await until(() => results === index + 1 && !coordinator.activeTurns.has(chat.id) && store.getMessages(chat.id).filter((entry) => entry.kind === "result").length === index + 1)
    }
    expect(starts.map((start) => start.model)).toEqual(["deepseek-v4-flash", "glm-5.3-flash", "sonnet"])
    expect(starts.map((start) => start.sessionToken)).toEqual([null, "shared-conversation", "shared-conversation"])
    expect(setModels).toEqual([])
  })

  for (const provider of ["claude"] as const) {
    test(`${provider}: concurrent preparation, reviewed-store working fork, and completed-turn audit stay out of the main context`, async () => {
      const h = await fixture(provider)
      expect(h.calls.map((call) => call.purpose)).toEqual(["candidate", "transfer", "changes"])
      expect(h.created.map((branch) => branch.parentSessionToken)).toEqual(["parent-before-turn", "parent-before-turn", "parent-before-turn"])
      expect(h.mainOptions).toHaveLength(0)
      h.candidate.resolve({ candidates: [{ proposalId: "C:1", content: "Use Bun for project scripts", type: "constraint", scope: "project", abstractionLevel: "contextual", sensitive: false, route: "new" }] })
      await until(() => h.memory.store.list({ status: "candidate" }).length === 1 && h.store.getMessages(h.chat.id).some((entry) => entry.kind === "memory_proposals_result"))
      const candidate = h.memory.store.list({ status: "candidate" })[0]!
      h.memory.store.update(candidate.id, { status: "active" }, { actor: "user" })
      const proposals = h.store.getMessages(h.chat.id).find((entry) => entry.kind === "memory_proposals")!
      if (proposals.kind !== "memory_proposals") throw new Error("Missing candidate review")
      await h.coordinator.respondMemoryProposals({ chatId: h.chat.id, proposalsId: proposals.proposalsId, decision: "reviewed" })
      await until(() => h.calls.some((call) => call.purpose === "working-memory"))
      const working = h.created.find((branch) => branch.purpose === "working-memory")!
      expect(working.parentSessionToken).toBe("parent-before-turn")
      expect(h.calls.find((call) => call.purpose === "working-memory")?.prompt).toContain("Use Bun for project scripts")
      expect(h.calls.filter((call) => call.purpose === "transfer").map((call) => call.prompt).slice(1).join("\n")).toContain("Candidate review")
      const changeReviews = h.calls.filter((call) => call.purpose === "changes").slice(1).map((call) => call.prompt).join("\n")
      expect(changeReviews).toContain("Candidate review")
      expect(changeReviews).toContain("Transfer and memory review")
      expect(h.created.filter((branch) => branch.purpose === "transfer")).toHaveLength(1)
      expect(h.created.filter((branch) => branch.purpose === "changes")).toHaveLength(1)
      await until(() => h.store.getMessages(h.chat.id).some((entry) => entry.kind === "memory_preview_relevance"))
      const preview = h.store.getMessages(h.chat.id).find((entry) => entry.kind === "memory_preview")!
      if (preview.kind !== "memory_preview") throw new Error("Missing working-memory review")
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: "go_on", memoryIds: [h.rule.id] })
      await until(() => h.mainPrompts.length === 1)
      expect(h.mainPrompts[0]).toContain("Return the numbers in ascending order.")
      expect(h.mainPrompts[0]).not.toContain("BRANCH_PRIVATE")
      h.finishedMain()
      await until(() => h.store.getMessages(h.chat.id).some((entry) => entry.kind === "memory_trace" && entry.status === "ok"))
      const audit = h.created.find((branch) => branch.purpose === "audit")!
      expect(audit.parentSessionToken).toBe("parent-after-turn")
      expect(h.calls.find((call) => call.purpose === "audit")?.prompt).toContain("Sorted 1, 2, 3.")
      expect(h.sidecarCalls()).toBe(0)
      expect(h.disposed).toContain("audit")
      const auditRow = h.store.getMessages(h.chat.id).filter((entry): entry is Extract<TranscriptEntry, { kind: "memory_trace" }> => entry.kind === "memory_trace" && entry.status === "ok").at(-1)!
      expect(auditRow.labels[0]?.id).toBe(h.rule.id)
      expect(auditRow.labels[0]?.label).toBe("operational")
    })
  }

  test("a preparation transport failure blocks execution without a sidecar fallback", async () => {
    const h = await fixture("codex", true)
    await until(() => h.store.requireChat(h.chat.id).lastTurnOutcome === "failed")
    expect(h.mainOptions).toHaveLength(0)
    expect(h.mainPrompts).toHaveLength(0)
    expect(h.sidecarCalls()).toBe(0)
  })
})
