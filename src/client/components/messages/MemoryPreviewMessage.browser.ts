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
const artifacts = join(import.meta.dir, "../../../../artifacts/76")

beforeAll(async () => {
  vite = await createServer({
    configFile: false,
    root: join(import.meta.dir, "../../test-fixtures/archive-ui"),
    plugins: [react()],
    css: { postcss: join(import.meta.dir, "../../../..") },
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
  await mkdir(artifacts, { recursive: true })
})
afterAll(async () => {
  await page?.close()
  await browser?.close()
  await vite?.close()
})

test("archived preview rows stay in place and selection count excludes them", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1100 } })
  page.setDefaultTimeout(5_000)
  const errors: string[] = []
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack) })
  page.on("console", (message) => { if (message.type() === "error") { errors.push(message.text()); console.error(message.text()) } })
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: '{"data":[]}' }))
  await page.goto(url)
  const working = page.locator("#working-memory")
  const audit = page.locator("#audit")
  try {
    await working.getByText("Archived. It won't be used again.").waitFor()
  } catch (error) {
    console.error("Fixture content:", await page.locator("body").innerText(), "errors:", errors)
    throw error
  }
  expect(await working.getByText("Start (1 injected)").count()).toBe(1)
  expect(await working.getByText("Keep amounts in integer cents.").count()).toBe(0)
  expect(await audit.getByText("Archived. It won't be used again.").count()).toBe(1)
  expect(await audit.getByText("Enforce this next run").count()).toBe(0)
  const activeAuditRow = audit.locator(".group\\/trace").filter({ hasText: "M-02" })
  await activeAuditRow.hover()
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await page.waitForTimeout(500)
    await working.screenshot({ path: join(artifacts, `working-memory-${theme}.png`) })
    await activeAuditRow.hover()
    await audit.screenshot({ path: join(artifacts, `audit-${theme}.png`) })
  }
  await working.getByText("[M-02]").hover()
  const hover = page.locator("[data-radix-popper-content-wrapper]")
  const archive = hover.getByRole("button", { name: "Archive", exact: true })
  await archive.waitFor()
  await archive.click()
  expect(await working.getByText("Start without memory").count()).toBe(1)
  await working.getByText("[M-02]").hover()
  await hover.getByRole("button", { name: "Undo" }).waitFor()
  await hover.getByRole("button", { name: "Undo" }).click()
  expect(await working.getByText("Start (1 injected)").count()).toBe(1)
  await working.getByText("[M-01]").hover()
  await hover.getByRole("button", { name: "Undo" }).waitFor()
  await page.locator("#readonly").getByText("[M-01]").hover()
  await page.waitForTimeout(800)
  expect(await hover.getByRole("button", { name: "Undo" }).count()).toBe(0)
  await working.getByRole("button", { name: "Undo" }).click()
  expect(await working.getByText("Start (2 injected)").count()).toBe(1)
  expect(await working.getByText("Apply this rule to the task.").count()).toBe(2)
  const firstRow = working.locator(".relative").filter({ hasText: "M-01" }).first()
  await firstRow.getByRole("button", { name: "Archive: stop using this memory in every chat" }).click()
  expect(await working.getByText("Start (1 injected)").count()).toBe(1)
  await working.getByRole("button", { name: "Browse" }).click()
  const poolRow = working.locator(".group\\/pool").filter({ hasText: "M-03" })
  await poolRow.hover()
  await poolRow.getByRole("button", { name: "Archive: stop using this memory in every chat" }).click()
  expect(await poolRow.getByText("Archived. It won't be used again.").count()).toBe(1)
  await poolRow.getByRole("button", { name: "Undo" }).click()
  expect(await poolRow.getByText("Record a synthetic receipt.").count()).toBe(1)
  expect(errors).toEqual([])
}, 30_000)
