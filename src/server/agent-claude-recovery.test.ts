import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { MemoryService } from "./memory"
import { resolveConditionPolicy } from "./experiment/condition"
import type { HarnessEvent } from "./harness-types"

class Queue implements AsyncIterable<HarnessEvent> {
  private values: HarnessEvent[] = []
  private waiting: ((item: IteratorResult<HarnessEvent>) => void) | undefined
  private closed = false
  push(value: HarnessEvent) {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value, done: false }) }
    else this.values.push(value)
  }
  close() { this.closed = true; this.waiting?.({ value: undefined, done: true }); this.waiting = undefined }
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    return { next: async () => this.values.length ? { value: this.values.shift()!, done: false }
      : this.closed ? { value: undefined, done: true } : await new Promise(resolve => { this.waiting = resolve }) }
  }
}

async function until(condition: () => boolean) {
  const end = Date.now() + 4000
  while (!condition()) {
    if (Date.now() > end) throw new Error("Recovery test did not reach the expected state")
    await Bun.sleep(5)
  }
}

test("Claude recovery removes deselected expected-use instructions and detail-tool access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memosync-claude-recovery-"))
  const store = new EventStore(join(directory, "events"))
  await store.initialize()
  const project = await store.openProject(directory, "Recovery test")
  const chat = await store.createChat(project.id)
  await store.setSessionToken(chat.id, "main-session")
  const memory = new MemoryService({ dbPath: ":memory:", dataDir: join(directory, "memory") })
  const removed = memory.store.create({ content: "Deploy after every edit", type: "constraint", scope: "project", projectId: project.id }, { actor: "user" })
  const kept = memory.store.create({ content: "Use integer-cent prices", type: "constraint", scope: "project", projectId: project.id }, { actor: "user" })
  const removedUse = "DEPLOY_EXPECTATION: publish the latest edited page."
  const keptUse = "PRICE_EXPECTATION: store the total in integer cents."
  const events = new Queue()
  const deliveries: Array<{ prompt: string; ids?: readonly string[] }> = []
  let starts = 0
  const coordinator = new AgentCoordinator({
    store, memory, memoryBranches: true, memoryPreview: true,
    policy: { ...resolveConditionPolicy("memosync"), studyMode: false },
    onStateChange() {},
    claudeSessionFileExists: () => true,
    generateTitle: async () => ({ title: "Recovery", usedFallback: true, failureMessage: null }),
    getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: false }),
    createMemoryBranch(input) {
      return { id: `branch-${input.purpose}`, mode: "fork", sessionToken: "branch-session", dispose() {},
        async ask() {
          if (input.purpose === "working-memory") return { selected: [
            { id: removed.id, why: "Deployment rule", expectedUse: removedUse },
            { id: kept.id, why: "Price representation", expectedUse: keptUse },
          ] }
          if (input.purpose === "candidate") return { candidates: [] }
          if (input.purpose === "transfer") return { suggestions: [] }
          return { conflicts: [], redundancy: [], staleness: [] }
        },
      }
    },
    startClaudeSession: async () => {
      starts += 1
      return { provider: "claude", stream: events, interrupt: async () => {}, close() {}, setModel: async () => {}, setPermissionMode: async () => {},
        async sendPrompt(prompt, context) { deliveries.push({ prompt, ids: context?.allowedMemoryIds }) },
      }
    },
  })
  try {
    await coordinator.send({ type: "chat.send", chatId: chat.id, provider: "claude", model: "glm-5.3-flash", content: "Update the pricing page" })
    await until(() => store.getMessages(chat.id).some(message => message.kind === "memory_preview_relevance"))
    const preview = store.getMessages(chat.id).find(message => message.kind === "memory_preview")
    if (preview?.kind !== "memory_preview") throw new Error("Missing preview")
    await coordinator.respondMemoryPreview({ chatId: chat.id, previewId: preview.previewId, decision: "go_on", memoryIds: [removed.id, kept.id] })
    await until(() => deliveries.length === 1)
    expect(deliveries[0].prompt).toContain(removedUse)
    expect(deliveries[0].prompt).toContain(keptUse)
    events.push({ type: "transcript", origin: "human", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "system_init", provider: "claude", model: "glm-5.3-flash", tools: [], agents: [], slashCommands: [], mcpServers: [] } })
    await until(() => store.getMessages(chat.id).some(message => message.kind === "system_init"))
    await coordinator.interruptMemory({ chatId: chat.id, memoryId: removed.id, quote: "Started deploying before review" })
    events.push({ type: "transcript", origin: "human", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "interrupted" } })
    await until(() => store.getMessages(chat.id).filter(message => message.kind === "interrupted").length >= 2)
    const interruption = store.getMessages(chat.id).find(message => message.kind === "memory_interrupt")
    if (interruption?.kind !== "memory_interrupt") throw new Error("Missing interruption")
    await coordinator.resumeInterrupted({ chatId: chat.id, interruptId: interruption.interruptId, correction: "Continue with the price rule only; do not deploy.", selectedIds: [kept.id] })
    await until(() => deliveries.length === 2)
    expect(deliveries[1].prompt).not.toContain(removedUse)
    expect(deliveries[1].prompt).toContain(keptUse)
    expect(deliveries[1].prompt).toContain("RESUMING AN INTERRUPTED TURN")
    expect(deliveries[1].ids).toEqual([kept.id])
    expect(starts).toBe(1)
  } finally {
    events.close()
    await coordinator.shutdownStudyRuntime()
    memory.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
