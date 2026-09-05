// Visual QA for the Session Memory Timeline: seed a chat whose transcript
// exercises every timeline surface (summary + citations, violation row with
// quote, capture rows incl. auto, no-memory turn), boot the real server over
// that data dir, and screenshot the Timeline tab in light & dark via
// Playwright. Usage: `bun run scripts/screenshot-timeline.ts [outDir]`.
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { EventStore } from "../src/server/event-store"
import { startMemoSyncServer } from "../src/server/server"
import type { TranscriptEntry } from "../src/shared/types"

const outDir = process.argv[2] || join(process.cwd(), "tmp")
mkdirSync(outDir, { recursive: true })

const dataDir = mkdtempSync(join(tmpdir(), "memv2-timeline-"))
const workspace = mkdtempSync(join(tmpdir(), "memv2-timeline-ws-"))

// ── Seed the chat + transcript before the server boots ─────────────────────
const store = new EventStore(dataDir)
await store.initialize()
const project = await store.openProject(workspace, "RenderX")
const chat = await store.createChat(project.id)
await store.setChatProvider(chat.id, "claude")
await store.renameChat(chat.id, "Fix flaky login test")

let ts = Date.now() - 1000 * 60 * 30
const entry = (e: Record<string, unknown>): TranscriptEntry =>
  ({ _id: crypto.randomUUID(), createdAt: (ts += 45_000), ...e }) as unknown as TranscriptEntry

const memories = [
  { id: "M-01", content: "Only run MainTests (~19s) before pushing", scope: "project" },
  { id: "M-02", content: "Prefer early returns over deeply nested conditionals", scope: "personal" },
  { id: "M-03", content: "The flaky login test needs --runInBand to pass", scope: "project" },
]

// t1: memories injected, trace with summary + operational verdicts.
await store.appendMessage(chat.id, entry({ kind: "user_prompt", content: "Why is the login test flaky?" }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview", previewId: "p1", turn: 1, memories }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview_decision", previewId: "p1", decision: "go_on" }))
await store.appendMessage(chat.id, entry({ kind: "assistant_text", text: "The login test races the session store. Run it with --runInBand while I check the setup." }))
await store.appendMessage(
  chat.id,
  entry({
    kind: "memory_trace",
    turn: 1,
    summary: "Diagnosed the flaky test using [M-03] and kept the fix small per [M-02].",
    labels: [
      { id: "M-03", label: "operational", quote: "Run it with --runInBand" },
      { id: "M-02", label: "operational" },
      { id: "M-01", label: "injected_without_effect" },
    ],
  }),
)

// t2: a violation with a jumpable quote + a capture.
await store.appendMessage(chat.id, entry({ kind: "user_prompt", content: "Push the fix once tests pass" }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview", previewId: "p2", turn: 2, memories }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview_decision", previewId: "p2", decision: "go_on" }))
await store.appendMessage(chat.id, entry({ kind: "assistant_text", text: "I ran the full suite to be safe before pushing — everything is green." }))
await store.appendMessage(
  chat.id,
  entry({
    kind: "memory_trace",
    turn: 2,
    summary: "Pushed the fix, but ran the FULL suite against [M-01].",
    labels: [
      { id: "M-01", label: "violated", note: "ran the full suite instead of MainTests", quote: "I ran the full suite to be safe" },
      { id: "M-03", label: "operational" },
    ],
  }),
)
await store.appendMessage(
  chat.id,
  entry({
    kind: "memory_candidates",
    turn: 2,
    candidates: [
      { id: "M-04", content: "CI reruns flaky suites twice before failing the build", type: "fact", scope: "project", status: "candidate" },
    ],
  }),
)

// t3: ran without memory.
await store.appendMessage(chat.id, entry({ kind: "user_prompt", content: "quick sanity check" }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview", previewId: "p3", turn: 3, memories: [] }))
await store.appendMessage(chat.id, entry({ kind: "memory_preview_decision", previewId: "p3", decision: "without_memory" }))
await store.appendMessage(chat.id, entry({ kind: "assistant_text", text: "All good." }))

// EventStore keeps no open handles that block a same-process server boot

// ── Boot the real server over the seeded data dir ──────────────────────────
const srv = await startMemoSyncServer({ port: 3922, dataDir, openBrowser: false, discoverProjects: () => [] })
const base = `http://127.0.0.1:${srv.port}`

// Seed the memory store so chips resolve content on hover/labels.
for (const m of [
  { content: "Only run MainTests (~19s) before pushing", scope: "project", type: "constraint", projectId: project.id },
  { content: "Prefer early returns over deeply nested conditionals", scope: "personal", type: "preference" },
  { content: "The flaky login test needs --runInBand to pass", scope: "project", type: "lesson", projectId: project.id },
  { content: "CI reruns flaky suites twice before failing the build", scope: "project", type: "fact", status: "candidate", projectId: project.id },
]) {
  await fetch(`${base}/api/memories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) })
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })

await page.goto(`${base}/chat/${chat.id}`, { waitUntil: "networkidle", timeout: 30000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: join(outDir, "debug-chat.png") })
if (errors.length) console.error("early console errors:", errors)

// Open the Session Memories panel, then the Timeline tab.
await page.locator('button[aria-label="Session memories"]').click()
await page.waitForTimeout(600)
await page.getByRole("tab", { name: "Timeline" }).click()
await page.waitForTimeout(800)

const panel = page.locator('div.flex.h-full.flex-col.overflow-hidden').last()
await page.screenshot({ path: join(outDir, "timeline-light.png") })
await panel.screenshot({ path: join(outDir, "timeline-panel-light.png") }).catch(() => {})
await page.evaluate(() => document.documentElement.classList.add("dark"))
await page.waitForTimeout(400)
await page.screenshot({ path: join(outDir, "timeline-dark.png") })
await panel.screenshot({ path: join(outDir, "timeline-panel-dark.png") }).catch(() => {})

await browser.close()
await srv.stop?.()
if (errors.length) {
  console.error("console errors:", errors)
  process.exit(1)
}
console.log("screenshots written to", outDir)
process.exit(0)
