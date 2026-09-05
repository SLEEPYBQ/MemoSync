// Memory E2E matrix — the three paths e2e-full-app.ts does not cover, driven
// over the WS protocol against a RUNNING instance (real model calls):
//   3. WITHOUT_MEMORY  preview → "proceed without memory" → turn runs, no trace
//   4. BRING-IN        curated session pins → only the pinned set is in play
//   5. LIFECYCLE       capture → user accepts → the NEXT turn cites the new
//                      memory from INJECTION (validates the Claude
//                      rebuild-on-memory-change fix live)
//
//   E2E_BASE=http://127.0.0.1:3210 bun run scripts/e2e-memory-matrix.ts
import type { ChatSnapshot, TranscriptEntry } from "../src/shared/types"

const BASE = process.env.E2E_BASE || "http://127.0.0.1:3210"
const PROVIDER = "claude"
const WS_URL = BASE.replace(/^http/, "ws") + "/ws"

let nextId = 0
const rid = () => `mx-${++nextId}`
const ws = new WebSocket(WS_URL)
const inbox: any[] = []
const waiters: Array<(m: any) => boolean> = []
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  inbox.push(m)
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!(m)) waiters.splice(i, 1)
}
await new Promise<void>((res, rej) => {
  ws.onopen = () => res()
  ws.onerror = () => rej(new Error(`cannot connect ${WS_URL}`))
})
const send = (e: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...e }))
function waitFor<T>(pred: (m: any) => T | undefined, ms: number, label: string): Promise<T> {
  return new Promise((res, rej) => {
    for (const m of inbox) {
      const h = pred(m)
      if (h !== undefined) return res(h)
    }
    const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)
    waiters.push((m) => {
      const h = pred(m)
      if (h === undefined) return false
      clearTimeout(t)
      res(h)
      return true
    })
  })
}

/** Drive one chat turn: send → auto-respond to the preview → until result. */
async function runTurn(opts: {
  chatId?: string
  projectId?: string
  content: string
  decision: "go_on" | "without_memory"
  postResultWaitMs?: number
}): Promise<{ chatId: string; entries: TranscriptEntry[] }> {
  const sendId = rid()
  send({
    type: "command",
    id: sendId,
    command: { type: "chat.send", chatId: opts.chatId, projectId: opts.projectId, provider: PROVIDER, content: opts.content },
  })
  const { chatId } = await waitFor<{ chatId: string }>(
    (m) => (m.type === "ack" && m.id === sendId ? (m.result as { chatId: string }) : undefined),
    30_000,
    "chat.send ack",
  )
  const subId = rid()
  send({ type: "subscribe", id: subId, topic: { type: "chat", chatId, recentLimit: 200 } })

  const seen = new Set<string>()
  const entries: TranscriptEntry[] = []
  // On a continued chat the snapshot REPLAYS prior turns; only entries that
  // appear AFTER the first snapshot (minus our still-pending preview) belong
  // to THIS turn. Prior results/previews are history.
  let baseline: Set<string> | null = null
  let responded = false
  let resultAt = 0
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const snap = await waitFor<ChatSnapshot | null>(
      (m) => (m.type === "snapshot" && m.snapshot?.type === "chat" ? (m.snapshot.data as ChatSnapshot | null) : undefined),
      Math.max(1000, deadline - Date.now()),
      "chat snapshot",
    ).catch(() => undefined)
    if (snap === undefined) break
    const idx = inbox.findIndex((m) => m.type === "snapshot" && m.snapshot?.type === "chat")
    if (idx >= 0) inbox.splice(idx, 1)
    if (!snap) continue
    const decidedPreviews = new Set(
      snap.messages.filter((e) => e.kind === "memory_preview_decision").map((e) => (e as any).previewId as string),
    )
    if (baseline === null) {
      // History = everything already decided/finished at subscribe time. The
      // fresh (undecided) preview and anything after it is this turn's.
      baseline = new Set(
        snap.messages
          .filter((e) => !(e.kind === "memory_preview" && !decidedPreviews.has((e as any).previewId)))
          .map((e) => e._id),
      )
    }
    for (const entry of snap.messages) {
      if (seen.has(entry._id)) continue
      seen.add(entry._id)
      if (baseline.has(entry._id)) continue
      entries.push(entry)
      if (entry.kind === "memory_preview" && !responded && !decidedPreviews.has((entry as any).previewId)) {
        responded = true
        send({
          type: "command",
          id: rid(),
          command: { type: "chat.respondMemoryPreview", chatId, previewId: (entry as any).previewId, decision: opts.decision },
        })
      }
      if (entry.kind === "result") resultAt = Date.now()
    }
    if (resultAt && Date.now() - resultAt > (opts.postResultWaitMs ?? 90_000)) break
    if (resultAt) await new Promise((r) => setTimeout(r, 1500))
  }
  send({ type: "unsubscribe", id: subId })
  return { chatId, entries }
}

const kinds = (es: TranscriptEntry[]) => es.map((e) => e.kind)
const text = (es: TranscriptEntry[]) =>
  es.filter((e): e is Extract<TranscriptEntry, { kind: "assistant_text" }> => e.kind === "assistant_text").map((e) => e.text).join("\n")
const api = <T,>(path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, init).then(async (r) => (await r.json()).data as T)

// project id from the sidebar
send({ type: "subscribe", id: "sb", topic: { type: "sidebar" } })
const sidebar = await waitFor<any>((m) => (m.type === "snapshot" && m.snapshot?.type === "sidebar" ? m.snapshot.data : undefined), 10_000, "sidebar")
const projectId = sidebar.projectGroups[0].groupKey as string
console.log(`[matrix] project ${projectId}`)
const results: Array<{ name: string; pass: boolean; note: string }> = []

// ---------- PATH 3: without_memory ----------
{
  console.log("\n[matrix] PATH 3 — without_memory")
  const { entries } = await runTurn({
    projectId,
    content: "Which test command should I run before pushing? Answer briefly.",
    decision: "without_memory",
    postResultWaitMs: 45_000,
  })
  const ks = kinds(entries)
  const decision = entries.find((e) => e.kind === "memory_preview_decision") as any
  const pass = decision?.decision === "without_memory" && ks.includes("result") && !ks.includes("memory_trace")
  results.push({
    name: "without_memory: turn runs, injection+trace skipped",
    pass,
    note: `decision=${decision?.decision} result=${ks.includes("result")} trace=${ks.includes("memory_trace")}`,
  })
}

// ---------- PATH 4: bring-in pins ----------
{
  console.log("\n[matrix] PATH 4 — bring-in pins")
  const createId = rid()
  send({ type: "command", id: createId, command: { type: "chat.create", projectId } })
  const created = await waitFor<any>((m) => (m.type === "ack" && m.id === createId ? m.result : undefined), 15_000, "chat.create ack")
  const chatId = (created.chatId ?? created.id) as string

  const memories = await api<any[]>("/api/memories?status=active")
  const target = memories.find((m) => m.content.includes("MainTests"))!
  await api(`/api/memories/session-pins/${chatId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [target.id] }),
  })
  console.log(`[matrix] pinned only ${target.id}`)

  const { entries } = await runTurn({
    chatId,
    content: "Which exact test command should I run before pushing? Use only your injected memories and cite the id.",
    decision: "go_on",
    postResultWaitMs: 20_000,
  })
  const preview = entries.find((e) => e.kind === "memory_preview") as any
  const previewIds: string[] = preview?.memories?.map((m: any) => m.id) ?? []
  const onlyPinned = previewIds.every((id) => id === target.id)
  const cited = text(entries).includes(`[${target.id}]`)
  results.push({
    name: "bring-in: only the pinned set is in play + cited",
    pass: Boolean(preview) && onlyPinned && cited,
    note: `preview=[${previewIds.join(",")}] citedPinned=${cited}`,
  })
}

// ---------- PATH 5: capture → accept → next turn injects ----------
{
  console.log("\n[matrix] PATH 5 — lifecycle (accept mid-session, next turn cites)")
  const marker = `zebra-${Date.now() % 100000}`
  const turnA = await runTurn({
    projectId,
    content: `From now on, remember this project rule: before every commit you must run \`bun run ${marker}-lint\`. Confirm you saved it.`,
    decision: "go_on",
    postResultWaitMs: 120_000,
  })
  const candidatesEntry = turnA.entries.find((e) => e.kind === "memory_candidates") as any
  if (!candidatesEntry) {
    results.push({ name: "lifecycle: capture surfaced a candidate", pass: false, note: "no memory_candidates entry" })
  } else {
    const cand = candidatesEntry.candidates.find((c: any) => c.content.includes(marker)) ?? candidatesEntry.candidates[0]
    console.log(`[matrix] accepting candidate ${cand.id}: ${cand.content.slice(0, 60)}`)
    await api(`/api/memories/${cand.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    })

    const turnB = await runTurn({
      chatId: turnA.chatId,
      content:
        "From your INJECTED memories only (do not call search_memory): what exactly must I run before every commit? Cite the memory id inline.",
      decision: "go_on",
      postResultWaitMs: 20_000,
    })
    // MECHANISM assertion (what this path exists to prove): after the accept,
    // the very next turn's preview plan includes the new memory — i.e. the
    // Claude session was rebuilt with the fresh injected set — and the answer
    // uses the rule. Whether the model formats an inline [M-NN] citation is a
    // model-compliance signal, reported but non-fatal.
    const previewB = turnB.entries.find((e) => e.kind === "memory_preview") as any
    const inPlan = Boolean(previewB?.memories?.some((m: any) => m.id === cand.id))
    const answer = text(turnB.entries)
    const citedNew = answer.includes(`[${cand.id}]`)
    const usedMarker = answer.includes(marker)
    results.push({
      name: "lifecycle: accepted candidate reaches the NEXT turn's injected plan",
      pass: inPlan && usedMarker,
      note: `inPlan=${inPlan} marker=${usedMarker} inlineCitation=${citedNew} (${cand.id})`,
    })
  }
}

console.log("\n===== MEMORY MATRIX SUMMARY =====")
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name} — ${r.note}`)
const allPass = results.every((r) => r.pass)
console.log(`MEMORY_MATRIX: ${allPass ? "PASS" : "FAIL"}`)
ws.close()
process.exit(allPass ? 0 : 1)
