import { afterAll, beforeAll, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import type { MemoryItem } from "../../lib/memoriesApi"

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

test("archiving the local duplicate names the team rule as kept", async () => {
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const base = { scope: "project", projectId: "synthetic", type: "constraint", status: "active", abstractionLevel: "concrete",
    sensitive: false, createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 } as const
  let items: MemoryItem[] = [
    { ...base, id: "M-01", content: "Synthetic team rule", team: { id: "T-a123" } },
    { ...base, id: "M-03", content: "Synthetic local rule" },
  ]
  const actions: unknown[] = []
  await page.route("**/api/**", async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown = []
    if (path === "/api/memories" && request.method() === "GET") data = items
    else if (path === "/api/memories/attention-resolve" && request.method() === "POST") {
      actions.push(request.postDataJSON())
      items = items.map(item => item.id === "M-03" ? { ...item, status: "archived" } : item)
      data = items.find(item => item.id === "M-03")
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) })
  })
  await page.goto(`${url}/?checkup`)
  const checkup = page.locator("#checkup")
  await checkup.getByRole("button", { name: "Archive M-03" }).click()
  await checkup.getByText("kept M-01, archived M-03").waitFor()
  expect(actions).toHaveLength(1)
  expect(actions[0]).toMatchObject({ kind: "redundant", id: "M-03", otherId: "M-01", action: "archive" })
  expect(await checkup.getByText("1 of 1 handled").count()).toBe(1)
  const teamChip = checkup.getByText("[M-01]", { exact: true })
  expect(await teamChip.count()).toBe(1)
  expect((await teamChip.getAttribute("class"))?.split(" ")).not.toContain("line-through")
})
