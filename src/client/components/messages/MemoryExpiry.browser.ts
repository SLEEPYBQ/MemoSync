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
const artifacts = join(import.meta.dir, "../../../../artifacts/78")
beforeAll(async () => {
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/expiry-ui"), plugins: [react()], css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
  await mkdir(artifacts, { recursive: true })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })
test("expiry picker, board restoration and receipt", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1500 } })
  const base = { scope: "personal", type: "constraint", abstractionLevel: "concrete", sensitive: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 }
  const items: Array<Record<string, any>> = [
    { ...base, id: "M-01", status: "candidate", content: "For now, use the synthetic cache.", expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() },
    { ...base, id: "M-02", status: "active", content: "Keep synthetic tests isolated.", expiresAt: new Date(Date.now() + 6 * 86400000 - 1000).toISOString() },
    { ...base, id: "M-03", status: "archived", content: "Use the temporary synthetic service.", expiresAt: "2020-01-01T00:00:00.000Z" },
    { ...base, id: "M-04", status: "archived", content: "Keep the temporary synthetic queue.", expiresAt: "2020-01-01T00:00:00.000Z" },
  ]
  const patches: Array<Record<string, any>> = []
  await page.route("**/api/**", async route => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data } : { error: { code: "BAD_REQUEST", message: "Invalid expiry date" } }) })
    if (path === "/api/memories" && req.method() === "GET") return respond(items)
    if (req.method() === "PATCH" && /^\/api\/memories\/M-\d+$/.test(path)) {
      const patch = req.postDataJSON()
      patches.push(patch)
      const item = items.find(value => path.endsWith(value.id))!
      if (patch.expiresAt && (!Number.isFinite(Date.parse(patch.expiresAt)) || Date.parse(patch.expiresAt) <= Date.now())) return respond(null, 400)
      if (patch.status === "active" && (patch.expiresAt === undefined ? item.expiresAt : patch.expiresAt) && Date.parse(patch.expiresAt ?? item.expiresAt) <= Date.now()) return respond(null, 400)
      Object.assign(item, patch)
      return respond(item)
    }
    if (path.endsWith("/history")) return respond({ events: [] })
    if (path.endsWith("/needs-attention") || path.endsWith("/muted")) return respond({ items: [] })
    return respond({})
  })
  await page.goto(url)
  await page.locator("#board").getByRole("button", { name: "Restore for 7 days" }).first().waitFor()
  await page.locator("#candidate").getByRole("button", { name: /Keep:/ }).click()
  await page.getByRole("button", { name: "Custom date" }).click()
  for (const theme of ["light", "dark"]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(artifacts, `picker-${theme}.png`) })
    await page.keyboard.press("Escape")
    for (const section of ["card", "receipt", "board"]) await page.locator(`#${section}`).screenshot({ path: join(artifacts, `${section}-${theme}.png`) })
    await page.locator("#candidate").getByRole("button", { name: /Keep:/ }).click()
  }
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const localDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`
  await page.locator('input[type="date"]').fill(localDate)
  await page.getByRole("button", { name: "Apply", exact: true }).click()
  await page.locator("#candidate").getByText("Temporary memory").waitFor()
  const selected = await page.evaluate(value => {
    const date = new Date(value)
    return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]
  }, patches[0]!.expiresAt)
  const expected = await page.evaluate(value => {
    const [year, month, day] = value.split("-").map(Number)
    return [year, month! - 1, day, 23]
  }, localDate)
  expect(selected).toEqual(expected)
  await page.locator("#candidate").getByRole("button", { name: /Keep:/ }).click()
  expect(await page.getByRole("button", { name: "Custom date", exact: true }).locator("svg").count()).toBe(1)
  await page.getByRole("button", { name: "Forever", exact: true }).click()
  await page.locator("#candidate").getByText("Temporary memory").waitFor({ state: "hidden" })
  expect(patches[1]!.expiresAt).toBeNull()
  await page.locator("#candidate").getByRole("button", { name: /Keep:/ }).click()
  const saveCandidate = page.waitForResponse(response => response.url().endsWith("/api/memories/M-01") && response.request().method() === "PATCH")
  await page.getByRole("button", { name: "7 days", exact: true }).click()
  await saveCandidate
  const accept = page.waitForResponse(response => response.url().endsWith("/api/memories/M-01") && response.request().method() === "PATCH")
  await page.locator("#candidate").getByRole("button", { name: "Accept", exact: true }).click()
  await accept
  expect(patches[3]!.status).toBe("active")
  expect(patches[3]!.expiresAt).toBe(patches[2]!.expiresAt)
  await page.locator("#detail").getByRole("button", { name: /Keep:/ }).click()
  await page.getByRole("button", { name: "30 days", exact: true }).click()
  const save = page.waitForResponse(response => response.url().endsWith("/api/memories/M-02") && response.request().method() === "PATCH")
  await page.locator("#detail").getByRole("button", { name: "Save", exact: true }).click()
  await save
  expect(Date.parse(patches[4]!.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400000)
  await page.locator("#detail").getByRole("button", { name: /Keep:/ }).click()
  await page.getByRole("button", { name: "Forever", exact: true }).click()
  const clear = page.waitForResponse(response => response.url().endsWith("/api/memories/M-02") && response.request().method() === "PATCH")
  await page.locator("#detail").getByRole("button", { name: "Save", exact: true }).click()
  await clear
  expect(patches[5]!.expiresAt).toBeNull()
  await page.locator("#board").getByRole("button", { name: /M-04 Keep the temporary synthetic queue/ }).click()
  await page.locator("#board").getByRole("button", { name: /Keep:/ }).click()
  await page.getByRole("button", { name: "Forever", exact: true }).click()
  const clearArchived = page.waitForResponse(response => response.url().endsWith("/api/memories/M-04") && response.request().method() === "PATCH")
  await page.locator("#board").getByRole("button", { name: "Save", exact: true }).click()
  await clearArchived
  expect(patches[6]!.expiresAt).toBeNull()
  await page.locator("#board").getByRole("button", { name: "Close", exact: true }).click()
  await page.locator("#board").getByRole("button", { name: "Restore", exact: true }).click()
  await page.locator("#board").getByText("Keep the temporary synthetic queue.").waitFor({ state: "hidden" })
  expect(patches[7]!.status).toBe("active")
  expect(patches[7]!.expiresAt).toBeUndefined()
  await page.locator("#board").getByRole("button", { name: "Restore for 7 days", exact: true }).click()
  await page.locator("#board").getByText("Use the temporary synthetic service.").waitFor({ state: "hidden" })
  expect(patches[8]!.status).toBe("active")
  expect(Date.parse(patches[8]!.expiresAt) - Date.now()).toBeGreaterThan(6 * 86400000)
}, 30_000)
