import { mkdir, writeFile } from "node:fs/promises"
import { EventStore } from "../src/server/event-store"
import type { TranscriptEntry } from "../src/shared/types"
const home = process.env.I18N_QA_HOME
if (!home || !home.startsWith("/tmp/memosync-i18n-") || process.env.HOME !== home) {
  throw new Error("Set I18N_QA_HOME and HOME to the same new /tmp/memosync-i18n-* directory")
}
const workspace = `${home}/workspace`
await mkdir(workspace, { recursive: true })
await writeFile(`${workspace}/README.md`, "# Example project\n\nThis is test content, not UI copy.\n")
const store = new EventStore(`${home}/.memosync-dev/data`)
await store.initialize()
const project = await store.openProject(workspace, "Example project")
const chat = await store.createChat(project.id)
await store.setChatProvider(chat.id, "claude")
await store.renameChat(chat.id, "Review memory and fix tests")
let at = Date.now() - 100000
type FixtureEntry = TranscriptEntry extends infer T ? T extends TranscriptEntry ? Omit<T, "_id" | "createdAt"> : never : never
const entry = (fields: FixtureEntry): TranscriptEntry => ({ _id: crypto.randomUUID(), createdAt: at += 1000, ...fields }) as TranscriptEntry
await store.appendMessage(chat.id, entry({ kind: "user_prompt", content: "Please fix the test and review these memories." }))
await store.appendMessage(chat.id, entry({ kind: "memory_proposals", proposalsId: "qa-proposals", turn: 1, candidates: [{ id: "M-04", content: "Use isolated fixtures for tests.", scope: "project", type: "lesson" }], pending: false }))
await store.appendMessage(chat.id, entry({ kind: "memory_proposals_decision", proposalsId: "qa-proposals", decision: "reviewed" }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview", previewId: "qa-preview", turn: 1, memories: [
  { id: "M-01", content: "Store money as integer cents.", scope: "project" },
  { id: "M-02", content: "Prefer early returns.", scope: "personal" },
], relevancePending: false }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview_relevance", previewId: "qa-preview", relevant: [{ id: "M-01", why: "This task changes checkout calculations." }], expectedUses: [{ id: "M-01", expectedUse: "Keep all calculations in integer cents." }] }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview_decision", previewId: "qa-preview", decision: "go_on", selectedIds: ["M-01"] }))
await store.appendMessage(chat.id, entry({ kind: "assistant_text", text: "I fixed the test using integer cents [M-01]. User and agent content stays in its original language." }))
await store.appendMessage(chat.id, entry({ kind: "memory_trace", turn: 1, status: "ok", labels: [
  { id: "M-01", label: "operational", quote: "using integer cents", cited: true },
  { id: "M-02", label: "injected_without_effect" },
], summary: "Applied [M-01] to the checkout fix." }))
await store.appendMessage(chat.id, entry({ kind: "memory_candidates", turn: 1, candidates: [{ id: "M-04", content: "Use isolated fixtures for tests.", scope: "project", type: "lesson" }] }))
await writeFile(`${home}/qa-state.json`, JSON.stringify({ home, workspace, projectId: project.id, chatId: chat.id }))
console.log({ home, projectId: project.id, chatId: chat.id })
