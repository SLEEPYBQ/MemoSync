// Consolidated UI flow check (Playwright, no LLM calls): boots a local
// serve-demo-style instance on a temp data dir and drives the memory UI —
// Board search / drag-to-transfer / detail edit / candidate accept, per-item
// History + rollback, and the session-start Bring-in panel. Asserts against
// the HTTP API after each interaction and fails on any console error.
//   bun run scripts/ui-flows-check.ts   (needs: bunx playwright install chromium)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { chromium } from "playwright"
import { startMemoSyncServer } from "../src/server/server"

// Bun auto-loads .env. This check is intentionally deterministic and must not
// spend API tokens merely because opening the transfer dialog requests a
// proposal in production.
process.env.DEEPSEEK_API_KEY = ""

const outDir = process.argv[2] || join(process.cwd(), "tmp")
mkdirSync(outDir, { recursive: true })

// isolated instance with an opened project (bring-in needs a chat on a project)
const dataDir = mkdtempSync(join(tmpdir(), "memv2-uiflow-"))
const workspace = mkdtempSync(join(tmpdir(), "memv2-uiflow-ws-"))
writeFileSync(join(workspace, "README.md"), "# ui flow demo\n")
execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init", { cwd: workspace, stdio: "ignore" })

const srv = await startMemoSyncServer({ port: 3927, dataDir, openBrowser: false })
const base = `http://127.0.0.1:${srv.port}`
const project = await srv.store.openProject(workspace, "UIFlow Project")

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${base}${path}`, init)
  const body = await res.json()
  if (body.error) throw new Error(`${path}: ${body.error.message}`)
  return body.data as T
}
const post = (body: unknown) =>
  api<any>("/api/memories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const mPersonal = await post({ content: "Use fnm instead of nvm", scope: "personal", type: "preference" })
const mProject = await post({
  content: "Only run MainTests before pushing",
  detail: "Full suite is slow; gate is `bun test src/main --bail`.",
  abstractionLevel: "concrete",
  scope: "project",
  type: "constraint",
  projectId: project.id,
  topic: "Testing",
})
const mCandidate = await post({ content: "Prefers pnpm over npm", scope: "project", type: "preference", status: "candidate", projectId: project.id })
// one item with edit history for the rollback flow
await api(`/api/memories/${mPersonal.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: "Use fnm instead of nvm (edited)" }),
})

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const consoleErrors: string[] = []
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e}`))
page.on("console", (m) => {
  const text = m.text()
  if (m.type() === "error" || (m.type() === "warning" && /Missing.*Description|aria-describedby/i.test(text))) {
    consoleErrors.push(text)
  }
})

const results: Array<{ name: string; pass: boolean; note: string }> = []
const record = (name: string, pass: boolean, note = "") => {
  results.push({ name, pass, note })
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`)
}

// ---------- BOARD ----------
await page.goto(`${base}/memory`, { waitUntil: "networkidle" })
await page.waitForTimeout(800)

// search filters every lane
await page.getByPlaceholder(/search/i).fill("MainTests")
await page.waitForTimeout(400)
const visibleNonMatchingCards = await page.getByRole("button", { name: /Use fnm instead of nvm/ }).count()
const visibleMatchingCards = await page.getByRole("button", { name: /Only run MainTests before pushing/ }).count()
record(
  "board: search filters memory cards across lanes",
  visibleNonMatchingCards === 0 && visibleMatchingCards === 1,
  `matching=${visibleMatchingCards} nonMatching=${visibleNonMatchingCards}`,
)
await page.getByPlaceholder(/search/i).fill("")
await page.waitForTimeout(400)

// candidate accept from the lane. NOTE: exact:true matters — MemoryCard itself
// carries role="button" (its accessible name contains "… Accept Edit Dismiss"),
// so a fuzzy /accept/i .first() matches the CARD, not the inner button.
await page.getByRole("button", { name: "Accept", exact: true }).first().click()
await page.waitForTimeout(600)
const accepted = await api<any[]>(`/api/memories?status=active`)
record("board: candidate accept persists", accepted.some((m) => m.id === mCandidate.id))

// Dragging across a scope boundary now opens the judged Transfer dialog. No
// scope mutation is allowed until the user confirms the proposal.
const dragged = await page.evaluate(
  ([id]) => {
    const card = document.querySelector(`[draggable="true"][data-memory-id="${id}"]`) ?? [...document.querySelectorAll('[draggable="true"]')].find((el) => el.textContent?.includes("Use fnm"))
    const columns = [...document.querySelectorAll("*")].filter((el) => el.textContent?.trim().startsWith("Project") && el.querySelector?.('[draggable="true"]'))
    if (!card) return "no card"
    const dt = new DataTransfer()
    dt.setData("text/plain", id)
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }))
    const drop = columns.at(-1) ?? document.body
    drop.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }))
    drop.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }))
    return "dispatched"
  },
  [mPersonal.id],
)
await page.waitForTimeout(800)
const afterDrag = await api<any[]>(`/api/memories`)
const draggedItem = afterDrag.find((m) => m.id === mPersonal.id)
const transferDialog = page.getByRole("dialog")
const transferOpened = (await transferDialog.count()) === 1
record(
  "board: cross-scope drag opens Transfer dialog without mutating",
  transferOpened && draggedItem?.scope === "personal",
  `scope=${draggedItem?.scope} dialog=${transferOpened} (${dragged})`,
)
if (transferOpened) {
  await transferDialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.waitForTimeout(300)
}

// detail panel: open + edit content. The panel's content textarea is inline-
// editable; find it by its CURRENT VALUE (other textareas exist on the page).
await page.getByText("Only run MainTests before pushing").first().click()
await page.waitForTimeout(500)
let editPass = false
const textareas = page.locator("textarea")
for (let i = 0; i < (await textareas.count()); i++) {
  const box = textareas.nth(i)
  if ((await box.inputValue()).startsWith("Only run MainTests")) {
    await box.fill("Only run MainTests before pushing (v2)")
    await page.getByRole("button", { name: "Save", exact: true }).first().click()
    await page.waitForTimeout(700)
    const updated = await api<any[]>(`/api/memories`)
    editPass = updated.some((m) => m.id === mProject.id && m.content.includes("(v2)"))
    break
  }
}
record("board: detail-panel edit persists", editPass)

// ---------- HISTORY + ROLLBACK ----------
await page.getByRole("button", { name: /Use fnm instead of nvm/ }).first().click()
await page.waitForTimeout(500)
const historyTab = page.getByRole("button", { name: /history/i }).first()
let rollbackPass = false
let historyVisiblePass = false
if (await historyTab.count()) {
  await historyTab.click()
  await page.waitForTimeout(700)
  historyVisiblePass = (await page.getByText(/create/i).count()) > 0
  const rollback = page.getByRole("button", { name: /roll back/i }).first()
  if (await rollback.count()) {
    await rollback.click()
    await page.waitForTimeout(300)
    // two-step confirm: second click (same or a confirm-labeled button)
    const confirm = page.getByRole("button", { name: /confirm|roll back/i }).first()
    await confirm.click()
    await page.waitForTimeout(800)
    const after = await api<any>(`/api/memories/${mPersonal.id}/history`)
    rollbackPass = after.events.some((e: any) => e.kind === "revert")
  }
}
record("history: timeline renders", historyVisiblePass)
record("history: two-step rollback appends a revert event", rollbackPass)
await page.screenshot({ path: join(outDir, "uiflow-board.png") })

// ---------- BRING-IN PANEL ----------
// create a chat over WS, then open its (empty) page
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`)
await new Promise<void>((res) => (ws.onopen = () => res()))
const chatCreated: Promise<any> = new Promise((res) => {
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.type === "ack" && m.id === "c1") res(m.result)
  }
})
ws.send(JSON.stringify({ v: 1, type: "command", id: "c1", command: { type: "chat.create", projectId: project.id } }))
const createdChat = await chatCreated
const chatId = createdChat.chatId ?? createdChat.id
ws.close()

await page.goto(`${base}/chat/${chatId}`, { waitUntil: "networkidle" })
await page.waitForTimeout(1200)
const panelVisible = (await page.getByText(/working on this session|bring/i).count()) > 0
record("bring-in: panel replaces the empty state", panelVisible)

let pinPass = false
if (panelVisible) {
  // suggest with an intent, toggle nothing, start with selected
  const intent = page.getByPlaceholder(/working on/i).first()
  if (await intent.count()) {
    await intent.fill("fix the MainTests failure before pushing")
    const suggest = page.getByRole("button", { name: /suggest/i }).first()
    if (await suggest.count()) {
      await suggest.click()
      await page.waitForTimeout(800)
    }
  }
  const startSelected = page.getByRole("button", { name: /start with selected/i }).first()
  if (await startSelected.count()) {
    await startSelected.click()
    await page.waitForTimeout(800)
    const pins = await api<{ ids: string[] | null }>(`/api/memories/session-pins/${chatId}`)
    pinPass = Array.isArray(pins.ids) && pins.ids.length > 0
    record("bring-in: start-with-selected PUTs session pins", pinPass, `ids=${JSON.stringify(pins.ids)}`)
  } else {
    record("bring-in: start-with-selected PUTs session pins", false, "button not found")
  }
}
await page.screenshot({ path: join(outDir, "uiflow-bringin.png") })

// ---------- WRAP ----------
record("zero console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "))
await browser.close()
await srv.stop()

console.log("\n===== UI FLOWS SUMMARY =====")
const allPass = results.every((r) => r.pass)
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
console.log(`UI_FLOWS: ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
