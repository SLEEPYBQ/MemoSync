// FULL-APP memory-loop E2E — drives ONE real turn through the production
// coordinator over the WS protocol against a RUNNING instance (normally the
// local server on DeepSeek). Exercises the whole SPEC §4.10
// loop: per-turn preview gate → go_on → engine turn → [M-NN] citation →
// post-turn capture candidates + trace annotation entries.
//
//   E2E_BASE=http://127.0.0.1:3210 bun run scripts/e2e-full-app.ts [claude|codex]
//
// Makes real model calls; the instance needs a few seeded memories.
import type { ChatSnapshot, TranscriptEntry } from "../src/shared/types"

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3210"
const PROVIDER = (process.argv[2] || "claude") as "claude" | "codex"
const WS_URL = BASE.replace(/^http/, "ws") + "/ws"

let nextId = 0
const rid = () => `e2e-${++nextId}`

const ws = new WebSocket(WS_URL)
const inbox: any[] = []
const waiters: Array<(m: any) => boolean> = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  inbox.push(msg)
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!(msg)) waiters.splice(i, 1)
}
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = () => reject(new Error(`cannot connect ${WS_URL}`))
})

function send(envelope: Record<string, unknown>) {
  ws.send(JSON.stringify({ v: 1, ...envelope }))
}
function waitFor<T>(pred: (m: any) => T | undefined, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    for (const m of inbox) {
      const hit = pred(m)
      if (hit !== undefined) return resolve(hit)
    }
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs)
    waiters.push((m) => {
      const hit = pred(m)
      if (hit === undefined) return false
      clearTimeout(timer)
      resolve(hit)
      return true
    })
  })
}

// 1. Find the demo project via the sidebar snapshot.
send({ type: "subscribe", id: "sidebar", topic: { type: "sidebar" } })
const sidebar = await waitFor<any>(
  (m) => (m.type === "snapshot" && m.snapshot?.type === "sidebar" ? m.snapshot.data : undefined),
  10_000,
  "sidebar snapshot",
)
const group = sidebar.projectGroups?.[0]
if (!group) throw new Error("no project in sidebar — start the instance with DEMO_PROJECT")
const project = { id: group.groupKey as string, title: group.realTitle as string }
console.log(`[e2e] project: ${project.id} (${project.title}) provider=${PROVIDER}`)

// 2. Send the turn (creates the chat).
const sendId = rid()
send({
  type: "command",
  id: sendId,
  command: {
    type: "chat.send",
    projectId: project.id,
    provider: PROVIDER,
    content:
      "Which exact test command should I run before pushing in this project? Check your memory, load details if needed, and cite the memory id. Also: from now on, remember that I always want commit messages in English.",
  },
})
const { chatId } = await waitFor<{ chatId: string }>(
  (m) => (m.type === "ack" && m.id === sendId ? (m.result as { chatId: string }) : undefined),
  30_000,
  "chat.send ack",
)
console.log(`[e2e] chat: ${chatId}`)
send({ type: "subscribe", id: "chat", topic: { type: "chat", chatId } })

const seen = new Set<string>()
const entriesByKind = new Map<string, TranscriptEntry[]>()
let previewResponded = false
let sawResult = false

function ingest(snapshot: ChatSnapshot | null) {
  if (!snapshot) return
  for (const entry of snapshot.messages) {
    if (seen.has(entry._id)) continue
    seen.add(entry._id)
    const list = entriesByKind.get(entry.kind) ?? []
    list.push(entry)
    entriesByKind.set(entry.kind, list)
    if (entry.kind === "assistant_text") console.log(`[e2e] assistant: ${(entry as any).text.slice(0, 140)}`)
    if (entry.kind !== "assistant_text") console.log(`[e2e] entry: ${entry.kind}`)

    if (entry.kind === "memory_preview" && !previewResponded) {
      previewResponded = true
      const p = entry as Extract<TranscriptEntry, { kind: "memory_preview" }>
      console.log(
        `[e2e] PREVIEW: brings=[${p.memories.map((m) => m.id).join(",")}] — responding go_on`,
      )
      send({
        type: "command",
        id: rid(),
        command: { type: "chat.respondMemoryPreview", chatId, previewId: p.previewId, decision: "go_on" },
      })
    }
    if (entry.kind === "result") sawResult = true
  }
}

const deadline = Date.now() + 300_000
while (Date.now() < deadline) {
  const snap = await waitFor<ChatSnapshot | null>(
    (m) => (m.type === "snapshot" && m.snapshot?.type === "chat" ? (m.snapshot.data as ChatSnapshot | null) : undefined),
    Math.max(1000, deadline - Date.now()),
    "chat snapshot",
  ).catch(() => undefined)
  if (snap === undefined) break
  // Consume this snapshot message so the next waitFor sees a fresh one.
  const idx = inbox.findIndex((m) => m.type === "snapshot" && m.snapshot?.type === "chat")
  if (idx >= 0) inbox.splice(idx, 1)
  ingest(snap)
  // After the result, linger for the background passes (capture/trace).
  if (sawResult && entriesByKind.has("memory_trace") && entriesByKind.has("memory_candidates")) break
  if (sawResult && Date.now() > deadline - 180_000) {
    // give the post-turn passes up to ~2 minutes after the result
    await new Promise((r) => setTimeout(r, 1500))
  }
}

const assistantText = (entriesByKind.get("assistant_text") ?? []).map((e: any) => e.text).join("\n")
const cited = /\[M-\d+\]/.test(assistantText)
const preview = (entriesByKind.get("memory_preview") ?? []).length > 0
const decision = (entriesByKind.get("memory_preview_decision") ?? []).length > 0
const candidates = (entriesByKind.get("memory_candidates") ?? []).length > 0
const trace = (entriesByKind.get("memory_trace") ?? []).length > 0

// Server-side ground truth: usage events recorded for cited memories.
const memories = await fetch(`${BASE}/api/memories`).then((r) => r.json()).then((b) => b.data ?? [])
const used = memories.filter((m: any) => m.usageCount > 0).map((m: any) => `${m.id}:${m.usageCount}`)

console.log("\n===== FULL-APP E2E SUMMARY =====")
console.log(`preview gate shown+resolved : ${preview && decision ? "PASS" : "FAIL"}`)
console.log(`turn completed (result)     : ${sawResult ? "PASS" : "FAIL"}`)
console.log(`[M-NN] cited in answer      : ${cited ? "PASS" : "FAIL"}`)
console.log(`usage recorded server-side  : ${used.length ? `PASS (${used.join(", ")})` : "FAIL"}`)
console.log(`capture candidates appeared : ${candidates ? "PASS" : "(none surfaced — check necessity gate)"}`)
console.log(`trace annotation appeared   : ${trace ? "PASS" : "FAIL"}`)
const pass = preview && decision && sawResult && cited && trace
console.log(`FULL_APP_E2E: ${pass ? "PASS" : "FAIL"} (provider=${PROVIDER})`)
ws.close()
process.exit(pass ? 0 : 1)
