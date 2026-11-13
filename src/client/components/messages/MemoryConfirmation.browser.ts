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
const artifacts = join(import.meta.dir, "../../../../artifacts/77")
beforeAll(async () => {
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/confirmation-ui"), plugins: [react()],
    css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
  await mkdir(artifacts, { recursive: true })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })
test("confirmation disclosure, selection and automatic receipt", async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 1300 } })
  page.setDefaultTimeout(5000)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: '{"data":[]}' }))
  await page.goto(url)
  const confirmation = page.locator("#confirmation")
  const receipt = page.locator("#receipt")
  const failure = page.locator("#failure")
  await confirmation.getByText("First in this chat").waitFor()
  expect(await confirmation.getByText("v1 → v2 changed").count()).toBe(1)
  expect(await confirmation.getByText("Start (5 injected)").count()).toBe(1)
  expect(await confirmation.getByText("Keep fixtures isolated.").count()).toBe(0)
  expect(await receipt.getByText("[M-01]").count()).toBe(1)
  expect(await receipt.getByText("[M-03]").count()).toBe(1)
  expect(await receipt.getByText("[M-02]").count()).toBe(0)
  expect(await failure.getByRole("alert").count()).toBe(1)
  expect(await failure.getByRole("button", { name: "Retry selection" }).count()).toBe(1)
  expect(await page.locator("#choosing").getByRole("button", { name: /Start/ }).isDisabled()).toBe(true)
  for (const theme of ["light", "dark"]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await page.waitForTimeout(350)
    await confirmation.screenshot({ path: join(artifacts, `confirmation-${theme}.png`) })
    await receipt.screenshot({ path: join(artifacts, `receipt-${theme}.png`) })
  }
  await page.setViewportSize({ width: 390, height: 1000 })
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await confirmation.screenshot({ path: join(artifacts, "confirmation-narrow.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const disclosure = confirmation.getByRole("button", { name: "Another 3 already confirmed" })
  await disclosure.click()
  expect(await disclosure.getAttribute("aria-expanded")).toBe("true")
  const row = confirmation.locator(".relative.min-w-0").filter({ hasText: "Keep fixtures isolated." })
  await row.getByRole("button", { name: "Remove from this turn's working memory" }).click()
  expect(await confirmation.getByText("Start (4 injected)").count()).toBe(1)
  await confirmation.getByRole("button", { name: "Another 2 already confirmed" }).click()
  await confirmation.getByRole("button", { name: "Browse" }).click()
  await confirmation.locator(".group\\/pool").filter({ hasText: "Keep fixtures isolated." }).getByRole("button", { name: "Add", exact: true }).click()
  expect(await confirmation.getByText("Keep fixtures isolated.").count()).toBe(1)
  expect(await confirmation.getByText("Start (5 injected)").count()).toBe(1)
  await receipt.locator("[data-expandable-toggle]").click()
  expect(await receipt.getByText("Apply M-01 to this synthetic task.").count()).toBe(1)
  expect(await receipt.getByText("Apply M-03 to this synthetic task.").count()).toBe(1)
  expect(await receipt.getByText("Apply M-02 to this synthetic task.").count()).toBe(0)
  await failure.locator(".group\\/pool").filter({ hasText: "Keep fixtures isolated." }).getByRole("button", { name: "Add", exact: true }).click()
  expect(await failure.getByRole("button", { name: /Start \(1 injected\)/ }).isEnabled()).toBe(true)
  const readonlyReceipt = page.locator("#readonly-receipt")
  await readonlyReceipt.locator("[data-expandable-toggle]").click()
  expect(await readonlyReceipt.getByText("Apply M-01 to this synthetic task.").count()).toBe(1)
  expect(await readonlyReceipt.getByRole("button", { name: /archive|remove|start/i }).count()).toBe(0)
  const settings = page.locator("#settings")
  await settings.getByRole("combobox", { name: "Confirm working memory" }).click()
  await page.getByRole("option", { name: "Every turn" }).click()
  expect(await settings.locator("output").textContent()).toBe("every_turn")
  await settings.getByRole("combobox", { name: "Confirm working memory" }).click()
  await page.getByRole("option", { name: "Only when there are changes" }).click()
  expect(await settings.locator("output").textContent()).toBe("on_change")
})
