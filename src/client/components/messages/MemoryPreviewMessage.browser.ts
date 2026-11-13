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

test("citation archive and restore block Start until the server responds", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1100 } })
  page.setDefaultTimeout(5_000)
  type HeldPatch = { status: string; release: (fail: boolean) => void }
  let receivePatch: (patch: HeldPatch) => void = () => {}
  const nextPatch = () => new Promise<HeldPatch>((resolve) => { receivePatch = resolve })
  const item = {
    id: "M-02", content: "Validate each charge before submission.", scope: "personal",
    type: "constraint", abstractionLevel: "concrete", sensitive: false, createdAt: "", updatedAt: "",
    usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/memories/M-02") {
      const status = (request.postDataJSON() as { status: string }).status
      const held = new Promise<boolean>((resolve) => receivePatch({ status, release: resolve }))
      const fail = await held
      await route.fulfill({
        status: fail ? 500 : 200,
        contentType: "application/json",
        body: JSON.stringify(fail ? { error: { code: "TEST", message: "Synthetic failure" } } : { data: { ...item, status } }),
      })
      return
    }
    await route.fulfill({ contentType: "application/json", body: '{"data":[]}' })
  })
  await page.goto(`${url}?remote=1`)
  const working = page.locator("#working-memory")
  const start = working.getByRole("button", { name: /Start/ })
  await working.getByText("Start (1 injected)").waitFor()
  const expectPending = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("#working-memory button")]
      .some((button) => button.textContent?.includes("Start") && button.disabled))
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    expect(await page.evaluate(() => (window as unknown as { archiveFixtureResponses: number }).archiveFixtureResponses)).toBe(0)
  }
  const hover = page.locator("[data-radix-popper-content-wrapper]")
  await working.getByText("[M-02]").hover()
  const archive = hover.getByRole("button", { name: "Archive", exact: true })
  await archive.waitFor()
  const archiveArrival = nextPatch()
  await archive.click()
  const archivePatch = await archiveArrival
  expect(archivePatch.status).toBe("archived")
  await expectPending()
  await working.screenshot({ path: join(artifacts, "citation-archive-pending.png") })
  archivePatch.release(false)
  await working.getByText("Start without memory").waitFor()
  expect(await start.isEnabled()).toBe(true)

  await working.getByText("[M-02]").hover()
  const undo = hover.getByRole("button", { name: "Undo" })
  await undo.waitFor()
  const restoreArrival = nextPatch()
  await undo.click()
  const restorePatch = await restoreArrival
  expect(restorePatch.status).toBe("active")
  await expectPending()
  restorePatch.release(false)
  await working.getByText("Start (1 injected)").waitFor()
  expect(await start.isEnabled()).toBe(true)

  await working.getByText("[M-02]").hover()
  await archive.waitFor()
  const failureArrival = nextPatch()
  await archive.click()
  const failedPatch = await failureArrival
  await expectPending()
  failedPatch.release(true)
  await hover.getByText("Synthetic failure", { exact: false }).waitFor()
  expect(await start.isEnabled()).toBe(true)
  expect(await working.getByText("Start (1 injected)").count()).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { archiveFixtureResponses: number }).archiveFixtureResponses)).toBe(0)
}, 30_000)
