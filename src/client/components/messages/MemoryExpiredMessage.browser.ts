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
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/expiry-ui"), plugins: [react()],
    css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })

test("live receipt refreshes canonical status; readonly and demo do not fetch", async () => {
  for (const mode of ["live", "restore", "readonly", "demo"]) {
    page = await browser.newPage()
    page.setDefaultTimeout(5000)
    let listCalls = 0
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/memories") listCalls++
      const data = path === "/api/memories" ? [{
        id: "M-01", scope: "personal", type: "constraint", abstractionLevel: "concrete", sensitive: false,
        status: "archived", content: "Synthetic rule", expiresAt: mode === "restore" ? null : "2020-01-01T00:00:00.000Z",
        createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
      }] : {}
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) })
    })
    await page.goto(`${url}/?probe=${mode}`)
    const receipt = page.locator("#receipt")
    const chip = receipt.getByText("[M-01]", { exact: true })
    await chip.waitFor()
    if (mode === "live" || mode === "restore") {
      await page.waitForFunction(() => document.querySelector("#receipt .line-through") !== null)
      expect(listCalls).toBe(1)
      await chip.hover()
      await page.getByRole("button", { name: mode === "live" ? "Extend on Memory Board" : "Undo", exact: true }).waitFor()
      expect(await receipt.getByRole("button", { name: "View archived" }).count()).toBe(1)
    } else {
      await page.waitForTimeout(300)
      expect(listCalls).toBe(0)
      expect((await chip.getAttribute("class"))?.split(" ")).not.toContain("line-through")
      expect(await receipt.getByRole("button", { name: "View archived" }).count()).toBe(0)
    }
    await page.close()
  }
})

test("pending expiry disables independent mutations until saved", async () => {
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const patches: Array<Record<string, unknown>> = []
  const item = {
    id: "M-01", scope: "personal", type: "constraint", abstractionLevel: "concrete", sensitive: false,
    status: "active", content: "Keep synthetic tests isolated.", expiresAt: null,
    createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
  }
  await page.route("**/api/**", route => {
    const req = route.request()
    let data: unknown = { events: [] }
    if (req.method() === "PATCH") {
      const patch = req.postDataJSON()
      patches.push(patch)
      Object.assign(item, patch, { updatedAt: "2030-01-01" })
      data = item
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) })
  })
  await page.goto(`${url}/?probe=detail`)
  const detail = page.locator("#detail")
  await detail.getByRole("button", { name: "Keep: Forever" }).click()
  await page.getByRole("button", { name: "7 days", exact: true }).click()
  const scope = detail.getByRole("button", { name: "Project", exact: true })
  const sensitive = detail.getByRole("button", { name: "Not sensitive" })
  const hint = "Save the expiry change before moving this memory or changing its sensitivity."
  expect(await scope.isDisabled()).toBe(true)
  expect(await sensitive.isDisabled()).toBe(true)
  expect(await sensitive.getAttribute("title")).toBe(hint)
  expect(await detail.getByText(hint).count()).toBe(1)
  expect(await detail.getByRole("button", { name: /Keep:/ }).textContent()).not.toContain("Forever")
  expect(patches).toHaveLength(0)
  await detail.getByRole("button", { name: "Save", exact: true }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll<HTMLButtonElement>("#detail button")].find(button => button.textContent?.trim() === "Project")?.disabled)
  expect(await scope.isEnabled()).toBe(true)
  expect(await sensitive.isEnabled()).toBe(true)
  expect(await detail.getByText(hint).count()).toBe(0)
  expect(typeof patches[0]?.expiresAt).toBe("string")
  expect(patches[0]?.scope).toBeUndefined()
  expect(patches[0]?.sensitive).toBeUndefined()
})
