import { afterAll, beforeAll, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"

let vite: ViteDevServer
let browser: Browser
let page: Page
let url: string
const artifacts = join(import.meta.dir, "../../../../artifacts/79")
beforeAll(async () => {
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/correction-ui"), plugins: [react()], css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
  await mkdir(artifacts, { recursive: true })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })
test("correction controls and record visuals", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1600 } })
  type Correction = { label: "operational" | "not_applicable" | "violated" | "injected_without_effect" | null; note?: string }
  const events: Array<{ seq: number; kind: string; sessionId: string; turn: number; meta: Record<string, unknown> }> = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, kind: "trace", sessionId: "synthetic-chat", turn: i + 1, meta: { label: i % 2 ? "operational" : "violated" } }))
  events.push({ seq: 7, kind: "trace_correction", sessionId: "synthetic-chat", turn: 2, meta: { label: "not_applicable" } })
  events.push({ seq: 8, kind: "trace_correction", sessionId: "synthetic-chat", turn: 4, meta: { label: "violated" } })
  let stored: Correction | null = null
  let failNext = false
  const posts: unknown[] = []
  const item = {
    id: "M-07", content: "Use integer cents for all amounts.", scope: "personal", type: "constraint", status: "active",
    abstractionLevel: "concrete", sensitive: false, createdAt: "", updatedAt: "", usageCount: 6,
    reinforcedCount: 0, citedInCurrentSession: 0, version: 1, lastTraceLabel: "not_applicable", lastTraceCorrected: true,
  }
  await page.route("**/api/**", async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data } : { error: { message: "Synthetic failure", code: "TEST" } }) })
    if (path === "/api/fixture-correction") return respond(stored)
    if (path === "/api/memories" && request.method() === "GET") return respond([item])
    if (path.endsWith("/history")) return respond({ memory: item, events })
    if (path.endsWith("/trace-correction") && request.method() === "POST") {
      const body = request.postDataJSON() as Correction
      posts.push(body)
      if (failNext) { failNext = false; return respond(null, 500) }
      stored = { label: body.label, ...(body.note ? { note: body.note } : {}) }
      events.push({ seq: events.length + 1, kind: "trace_correction", sessionId: "synthetic-chat", turn: 1, meta: body.label ? { label: body.label, ...(body.note ? { note: body.note } : {}) } : { withdrawn: true } })
      await respond({ auditLabel: "violated", changed: true, label: body.label, note: body.note })
      await page.evaluate(value => window.correctionFixture.publish(value), stored)
      return
    }
    return respond({})
  })
  await page.goto(url)
  const editor = page.locator("#editor")
  const record = page.locator("#record")
  const section = (heading: string) => editor.locator("section").filter({ has: page.getByText(heading, { exact: true }) })
  expect(await section("Violated").getByText("[M-07]").count()).toBe(1)
  expect(await record.getByText("Synthetic audit says this shaped the turn.").count()).toBe(1)
  await editor.getByRole("button", { name: "Not right?" }).click()
  await page.locator("#detail").getByText("You corrected 2 of the last 6 verdicts.").waitFor()
  expect(await page.locator("#corrected").getByText("1 corrected").count()).toBe(1)
  for (const theme of ["light", "dark"]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await page.waitForTimeout(500)
    for (const section of ["editor", "corrected", "detail", "board"]) await page.locator(`#${section}`).screenshot({ path: join(artifacts, `${section}-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await page.setViewportSize({ width: 390, height: 1000 })
  await page.waitForTimeout(500)
  await editor.screenshot({ path: join(artifacts, "editor-compact-light.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.setViewportSize({ width: 1100, height: 1600 })

  const input = editor.getByRole("textbox", { name: "Why? Optional. The audit sees this next time." })
  const choice = editor.getByRole("button", { name: "not applicable this turn" })
  await choice.click()
  await input.fill("stale text")
  await editor.getByRole("button", { name: "Cancel" }).click()
  await editor.getByRole("button", { name: "Not right?" }).click()
  expect(await input.inputValue()).toBe("")
  expect(await editor.getByRole("button", { name: "Save" }).isDisabled()).toBe(true)
  await choice.click()
  await input.fill("temporary")
  await input.press("Escape")
  await editor.getByRole("button", { name: "Not right?" }).click()
  expect(await input.inputValue()).toBe("")
  expect(await editor.getByRole("button", { name: "Save" }).isDisabled()).toBe(true)
  await page.evaluate(() => window.correctionFixture.setReadonly(true))
  await editor.getByText("What actually happened?").waitFor({ state: "hidden" })
  expect(await editor.getByRole("button", { name: "Not right?" }).count()).toBe(0)
  await page.evaluate(() => window.correctionFixture.setReadonly(false))
  await editor.getByRole("button", { name: "Not right?" }).click()
  await page.evaluate(() => window.correctionFixture.setStatus("archived"))
  await editor.getByText("What actually happened?").waitFor({ state: "hidden" })
  expect(await editor.getByRole("button", { name: "Not right?" }).count()).toBe(0)
  await page.evaluate(() => window.correctionFixture.setStatus("active"))
  await editor.getByRole("button", { name: "Not right?" }).click()
  await choice.click()
  await input.fill("  No monetary amounts  ")
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })))
  expect(posts).toHaveLength(0)
  failNext = true
  await editor.getByRole("button", { name: "Save" }).click()
  await editor.getByText("Couldn't save the correction", { exact: false }).waitFor()
  await editor.getByRole("button", { name: "Cancel" }).click()
  expect(await editor.getByText("Couldn't save the correction", { exact: false }).count()).toBe(0)
  await editor.getByRole("button", { name: "Not right?" }).click()
  expect(await input.inputValue()).toBe("")
  expect(await editor.getByRole("button", { name: "Save" }).isDisabled()).toBe(true)
  await choice.click()
  await input.fill("  No monetary amounts  ")
  await editor.getByRole("button", { name: "Save" }).click()
  await editor.getByText("You: not applicable this turn").waitFor()
  expect(await section("Not applicable this turn").getByText("[M-07]").count()).toBe(1)
  expect(await section("Violated").count()).toBe(0)
  expect(await record.getByText("Synthetic audit says this shaped the turn.").count()).toBe(1)
  expect(await record.getByText("1 shaped").count()).toBe(1)
  expect(posts).toEqual([
    { sessionId: "synthetic-chat", turn: 1, label: "not_applicable", note: "No monetary amounts" },
    { sessionId: "synthetic-chat", turn: 1, label: "not_applicable", note: "No monetary amounts" },
  ])
  await page.locator("#detail").getByText("You corrected 3 of the last 6 verdicts.").waitFor()
  await page.reload()
  await editor.getByText("You: not applicable this turn").waitFor()
  expect(await editor.getByText("Your note: No monetary amounts").count()).toBe(1)
  await page.evaluate(() => window.correctionFixture.setReadonly(true))
  await editor.getByRole("button", { name: "Undo" }).waitFor({ state: "hidden" })
  expect(await editor.getByRole("button", { name: "Undo" }).count()).toBe(0)
  await page.evaluate(() => window.correctionFixture.setReadonly(false))
  await page.evaluate(() => window.correctionFixture.setStatus("archived"))
  await editor.getByRole("button", { name: "Undo", exact: true }).first().click()
  await editor.getByText("You: not applicable this turn").waitFor({ state: "hidden" })
  expect(await section("Violated").getByText("[M-07]").count()).toBe(1)
  expect(await section("Not applicable this turn").count()).toBe(0)
  expect(await record.getByText("Synthetic audit says this shaped the turn.").count()).toBe(1)
  expect(posts.at(-1)).toEqual({ sessionId: "synthetic-chat", turn: 1, label: null })
  await page.locator("#detail").getByText("You corrected 2 of the last 6 verdicts.").waitFor()
}, 30_000)

test("hidden automatic audit can be corrected, synced and withdrawn from the record", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1300 } })
  page.setDefaultTimeout(5_000)
  type Correction = { label: "violated" | null; note?: string }
  const posts: Correction[] = []
  const item = {
    id: "M-07", content: "Use integer cents for all amounts.", scope: "personal", type: "constraint", status: "active",
    abstractionLevel: "concrete", sensitive: false, createdAt: "", updatedAt: "", usageCount: 6,
    reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
  }
  await page.route("**/api/**", async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = {}
    let status = 200
    if (path === "/api/fixture-correction") data = null
    else if (path === "/api/memories" && request.method() === "GET") data = [item]
    else if (path.endsWith("/history")) data = { memory: item, events: [] }
    else if (path.endsWith("/trace-correction") && request.method() === "POST") {
      const body = request.postDataJSON() as Correction
      posts.push(body)
      data = { auditLabel: "operational", changed: true, label: body.label, note: body.note, transcriptPending: true }
      status = 202
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) })
  })
  await page.goto(url)
  const record = page.locator("#record")
  await record.getByText("Synthetic audit says this shaped the turn.").waitFor()
  expect(await record.getByText("1 shaped").count()).toBe(1)
  await record.getByRole("button", { name: "Review audit" }).click()
  const dialog = page.getByRole("dialog")
  await page.evaluate(() => window.correctionFixture.setReadonly(true))
  await dialog.getByRole("button", { name: "Not right?" }).waitFor({ state: "hidden" })
  await page.evaluate(() => window.correctionFixture.setReadonly(false))
  await dialog.getByRole("button", { name: "Not right?" }).click()
  await dialog.getByRole("button", { name: "violated", exact: true }).click()
  await dialog.getByRole("textbox", { name: "Why? Optional. The audit sees this next time." }).fill("The response ignored the rule")
  await dialog.getByRole("button", { name: "Save" }).click()
  await dialog.getByText("Correction saved. Updating chat history…").waitFor()
  expect(await dialog.getByText("Couldn't save the correction", { exact: false }).count()).toBe(0)
  expect(await record.getByText("1 shaped").count()).toBe(1)
  await page.evaluate(() => window.correctionFixture.publishHidden({ label: "violated", note: "The response ignored the rule" }))
  await dialog.getByText("You: violated").waitFor()
  expect(await dialog.getByText("Correction saved. Updating chat history…").count()).toBe(0)
  expect(await record.getByText("audit complete").count()).toBe(1)
  expect(await record.getByText("1 violated").count()).toBe(1)
  expect(await record.getByText("Synthetic audit says this shaped the turn.").count()).toBe(0)

  for (const theme of ["light", "dark"]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await dialog.screenshot({ animations: "disabled", path: join(artifacts, `hidden-audit-dialog-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await page.setViewportSize({ width: 390, height: 1000 })
  await dialog.screenshot({ animations: "disabled", path: join(artifacts, "hidden-audit-dialog-compact.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.setViewportSize({ width: 1100, height: 1300 })

  await page.evaluate(() => window.correctionFixture.setReadonly(true))
  await dialog.getByRole("button", { name: "Undo", exact: true }).waitFor({ state: "hidden" })
  expect(await dialog.getByRole("button", { name: "Not right?" }).count()).toBe(0)
  await page.evaluate(() => window.correctionFixture.setReadonly(false))
  item.status = "archived"
  await page.evaluate(() => window.correctionFixture.setStatus("archived"))
  await dialog.getByRole("button", { name: "Undo", exact: true }).first().click()
  await dialog.getByText("Correction saved. Updating chat history…").waitFor()
  expect(await dialog.getByText("Couldn't save the correction", { exact: false }).count()).toBe(0)
  await page.evaluate(() => window.correctionFixture.publishHidden(null))
  await dialog.getByText("You: violated").waitFor({ state: "hidden" })
  expect(await dialog.getByText("Correction saved. Updating chat history…").count()).toBe(0)
  expect(await dialog.getByRole("button", { name: "Not right?" }).count()).toBe(0)
  expect(await record.getByText("Synthetic audit says this shaped the turn.").count()).toBe(1)
  expect(await record.getByText("1 shaped").count()).toBe(1)
  expect(posts).toEqual([
    { sessionId: "synthetic-chat", turn: 2, label: "violated", note: "The response ignored the rule" },
    { sessionId: "synthetic-chat", turn: 2, label: null },
  ])
}, 30_000)

test("inherited audit controls stay read-only in chat and Memory Record", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
  page.setDefaultTimeout(5_000)
  const errors: string[] = []
  const posts: string[] = []
  page.on("pageerror", error => { errors.push(error.message); console.error(error.stack) })
  const item = {
    id: "M-07", content: "Use integer cents for all amounts.", scope: "personal", type: "constraint", status: "active",
    abstractionLevel: "concrete", sensitive: false, createdAt: "", updatedAt: "", usageCount: 6,
    reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
  }
  await page.route("**/api/**", async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith("/trace-correction") && request.method() === "POST") posts.push(path)
    const data = path === "/api/fixture-correction" ? null
      : path === "/api/memories" && request.method() === "GET" ? [item]
        : path.endsWith("/history") ? { memory: item, events: [] } : {}
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) })
  })
  await page.goto(`${url}?inherited=1`)
  const editor = page.locator("#editor")
  const corrected = page.locator("#corrected")
  await editor.getByText("Read-only in this chat").waitFor()
  await corrected.getByText("Read-only in this chat").waitFor()
  expect(await editor.getByRole("button", { name: "Not right?" }).count()).toBe(0)
  expect(await corrected.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0)
  expect(await corrected.getByText("Your note: No monetary amounts were produced.").count()).toBe(1)
  for (const [size, viewport] of [
    ["desktop", { width: 1100, height: 1400 }],
    ["narrow", { width: 390, height: 1000 }],
  ] as const) {
    await page.setViewportSize(viewport)
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(dark => { document.documentElement.classList.toggle("dark", dark); window.scrollTo(0, 0) }, theme === "dark")
      const first = await editor.boundingBox()
      const second = await corrected.boundingBox()
      if (!first || !second) throw new Error("Missing audit cards")
      const x = Math.max(0, Math.min(first.x, second.x) - 8)
      const y = Math.max(0, first.y - 8)
      await page.screenshot({
        animations: "disabled",
        clip: { x, y, width: Math.min(viewport.width - x, Math.max(first.x + first.width, second.x + second.width) - x + 8), height: Math.min(viewport.height - y, second.y + second.height - y + 8) },
        path: join(artifacts, `inherited-audit-${size}-${theme}.png`),
      })
    }
  }
  await page.locator("#record").getByRole("button", { name: "Review audit" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByText("Read-only in this chat").waitFor()
  expect(await dialog.getByRole("button", { name: "Not right?" }).count()).toBe(0)
  expect(await dialog.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0)
  expect(posts).toEqual([])
  expect(errors).toEqual([])
}, 30_000)
