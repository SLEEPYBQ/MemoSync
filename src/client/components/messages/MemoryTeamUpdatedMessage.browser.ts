import { afterAll, beforeAll, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"

let vite: ViteDevServer
let browser: Browser
let page: Page
let url: string

beforeAll(async () => {
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/team-memory-ui"), plugins: [react()],
    css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })

test("team notice refreshes added, changed and removed citations only in live mode", async () => {
  for (const mode of ["live", "readonly", "demo"]) {
    page = await browser.newPage()
    page.setDefaultTimeout(5000)
    let listCalls = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const base = { scope: "project", projectId: "synthetic", type: "constraint", abstractionLevel: "concrete", sensitive: false,
      createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 }
    const items = [
      { ...base, id: "M-05", status: "active", content: "Synthetic new team rule", team: { id: "T-c345" } },
      { ...base, id: "M-01", status: "active", content: "Synthetic updated team rule", version: 2, team: { id: "T-a123" } },
      { ...base, id: "M-03", status: "archived", content: "Synthetic removed team rule" },
    ]
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/memories") {
        listCalls++
        await pending
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: path === "/api/memories" ? items : {} }) })
    })
    await page.goto(`${url}/?teamNotice=${mode}`)
    const notice = page.locator("#notice")
    const removed = notice.getByText("[M-03]", { exact: true })
    await removed.waitFor()
    expect((await removed.getAttribute("class"))?.split(" ")).not.toContain("line-through")
    if (mode === "live") {
      release()
      await page.waitForFunction(() => [...document.querySelectorAll("#notice span")].some(element => element.textContent === "[M-03]" && element.classList.contains("line-through")))
      expect(listCalls).toBe(1)
      await removed.hover()
      await page.getByRole("button", { name: "Undo", exact: true }).waitFor()
      await notice.getByText("[M-01]", { exact: true }).hover()
      await page.getByText("Synthetic updated team rule", { exact: true }).waitFor()
      await notice.getByText("[M-05]", { exact: true }).hover()
      await page.getByText("Synthetic new team rule", { exact: true }).waitFor()
      expect(await notice.getByRole("button", { name: "View", exact: true }).count()).toBe(1)
    } else {
      await page.waitForTimeout(300)
      expect(listCalls).toBe(0)
      expect(await notice.getByRole("button", { name: "View", exact: true }).count()).toBe(0)
    }
    release()
    await page.close()
  }
})
