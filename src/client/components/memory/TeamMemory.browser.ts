import { afterAll, beforeAll, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import type { MemoryItem } from "../../lib/memoriesApi"

let vite: ViteDevServer
let browser: Browser
let page: Page
let url: string
const artifacts = join(import.meta.dir, "../../../../artifacts/81")
beforeAll(async () => {
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/team-memory-ui"), plugins: [react()],
    optimizeDeps: { entries: [join(import.meta.dir, "../../test-fixtures/team-memory-ui/fixture.tsx"), join(import.meta.dir, "../../app/MemoryBoardPage.tsx")] },
    css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
  await mkdir(artifacts, { recursive: true })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })

test("team rules, conflict, propose, share and transcript UI", async () => {
  page = await browser.newPage({ viewport: { width: 1400, height: 1200 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const base = { scope: "project", projectId: "synthetic", type: "constraint", status: "active", abstractionLevel: "concrete", sensitive: false,
    createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 } as const
  let items: MemoryItem[] = [
    { ...base, id: "M-01", content: "Validate requests in src/auth.ts.", team: { id: "T-a123" }, fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }] },
    { ...base, id: "M-02", content: "Run the synthetic suite before release.", version: 3, team: { id: "T-b234" } },
    { ...base, id: "M-03", content: "Document the synthetic deployment procedure." },
    { ...base, id: "M-04", status: "archived", content: "Keep a synthetic change log.", team: { id: "T-a123" } },
  ]
  const actions: Array<{ path: string; body: unknown }> = []
  await page.route("**/api/**", async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const id = path.match(/^\/api\/memories\/([^/]+)\//)?.[1]
    let data: unknown = []
    if (path === "/api/memories" && request.method() === "GET") data = items
    else if (path === "/api/memories/needs-attention" || path === "/api/memories/muted") data = { items: [] }
    else if (path === "/api/projects") data = [{ id: "synthetic", title: "Synthetic project" }]
    else if (path === "/api/chats") data = [{ id: "synthetic-chat", title: "Synthetic chat", projectId: "synthetic" }]
    else if (path === "/api/memories/team-status") data = { exists: true, conflict: true, path: ".memosync/team.md", canShare: url.searchParams.get("projectId") !== "no-path" }
    else if (path.endsWith("/history")) data = { memory: items.find(item => item.id === id), events: [] }
    else if (path.endsWith("/team/propose")) {
      const body = request.postDataJSON() as { content: string }
      actions.push({ path, body })
      items = items.map(item => item.id === id ? { ...item, content: body.content, version: item.version + 1, updatedAt: "2030-01-01" } : item)
      data = items.find(item => item.id === id)
    } else if (path.endsWith("/team/publish")) {
      actions.push({ path, body: null })
      items = items.map(item => item.id === id ? { ...item, team: { id: "T-c345" } } : item)
      data = items.find(item => item.id === id)
    } else if (path.endsWith("/team/unshare")) {
      actions.push({ path, body: null })
      items = items.map(item => item.id === id ? { ...item, team: undefined, status: "active" } : item)
      data = items.find(item => item.id === id)
    } else if (/^\/api\/memories\/[^/]+$/.test(path) && request.method() === "PATCH") {
      const id = path.split("/").at(-1)
      const body = request.postDataJSON() as Partial<MemoryItem>
      actions.push({ path, body })
      items = items.map(item => item.id === id ? { ...item, ...body } : item)
      data = items.find(item => item.id === id)
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) })
  })
  await page.goto(url)
  const library = page.locator('#board [data-memory-board-section="library"]')
  await library.getByRole("button", { name: /Team rules/ }).click()
  expect(await library.locator('[data-memory-board-id="M-01"]').count()).toBe(1)
  expect(await library.locator('[data-memory-board-id="M-02"]').count()).toBe(1)
  expect(await library.locator('[data-memory-board-id="M-03"]').count()).toBe(0)
  await library.getByText(/unresolved merge conflicts/).waitFor()
  await page.locator("#ordinary").getByRole("button", { name: "Share with team" }).waitFor()
  expect(await page.locator("#ordinary-no-path").getByRole("button", { name: "Share with team" }).count()).toBe(0)
  expect(await page.locator("#team-default textarea").first().getAttribute("readonly")).not.toBeNull()
  expect(await page.locator("#preview").getByText("Team rule · new").count()).toBe(1)
  expect(await page.locator("#preview").getByText("Team rule changed · v2 → v3").count()).toBe(1)
  expect(await page.locator("#notice").getByText("Team memory updated · 1 new · 1 changed · 1 removed").count()).toBe(1)
  await page.locator("#notice").getByRole("button", { name: "View" }).click()
  expect(await page.evaluate(() => (window as unknown as { fixtureLaunches: Array<{ initialLens: string }> }).fixtureLaunches[0]?.initialLens)).toBe("team")

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await library.screenshot({ animations: "disabled", path: join(artifacts, `board-team-desktop-${theme}.png`) })
    await library.getByText(/unresolved merge conflicts/).locator("..").screenshot({ animations: "disabled", path: join(artifacts, `conflict-desktop-${theme}.png`) })
    for (const name of ["card", "team-default", "team-off", "ordinary", "preview", "notice"]) {
      await page.locator(`#${name}`).screenshot({ animations: "disabled", path: join(artifacts, `${name}-desktop-${theme}.png`) })
    }
    await page.locator("#citation").getByText("[M-01]").hover()
    const popover = page.locator("[data-radix-popper-content-wrapper]").filter({ hasText: "Turn off on this machine" })
    await popover.waitFor()
    await popover.screenshot({ animations: "disabled", path: join(artifacts, `citation-desktop-${theme}.png`) })
  }
  await page.setViewportSize({ width: 390, height: 1000 })
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    for (const name of ["team-default", "team-off", "ordinary"]) {
      await page.locator(`#${name}`).screenshot({ animations: "disabled", path: join(artifacts, `${name}-narrow-${theme}.png`) })
    }
  }
  await page.setViewportSize({ width: 1400, height: 1200 })
  const detail = page.locator("#team-propose")
  await detail.getByRole("button", { name: "Propose a change" }).click()
  expect(await detail.locator("textarea").first().evaluate(element => element === document.activeElement)).toBe(true)
  expect(await detail.locator("textarea").first().getAttribute("readonly")).toBeNull()
  for (const width of ["desktop", "narrow"] as const) {
    await page.setViewportSize(width === "desktop" ? { width: 1400, height: 1200 } : { width: 390, height: 1000 })
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
      await detail.screenshot({ animations: "disabled", path: join(artifacts, `team-proposing-${width}-${theme}.png`) })
    }
  }
  await detail.locator("textarea").first().fill("A temporary synthetic draft.")
  await detail.getByRole("button", { name: "Cancel" }).click()
  expect(await detail.locator("textarea").first().inputValue()).toBe("Run the synthetic suite before release.")
  await detail.getByRole("button", { name: "Propose a change" }).click()
  await detail.locator("textarea").first().fill("Run the revised synthetic suite.")
  await detail.getByRole("button", { name: "Write to team.md" }).click()
  await detail.getByText("Written to .memosync/team.md — commit it with your pull request.").waitFor()
  expect(actions).toContainEqual({ path: "/api/memories/M-02/team/propose", body: { content: "Run the revised synthetic suite." } })
  for (const width of ["desktop", "narrow"] as const) {
    await page.setViewportSize(width === "desktop" ? { width: 1400, height: 1200 } : { width: 390, height: 1000 })
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
      await detail.screenshot({ animations: "disabled", path: join(artifacts, `team-written-${width}-${theme}.png`) })
    }
  }
  const ordinary = page.locator("#ordinary")
  await ordinary.getByRole("button", { name: "Share with team" }).click()
  await ordinary.getByText("Written to .memosync/team.md — commit it with your pull request.").waitFor()
  expect(actions).toContainEqual({ path: "/api/memories/M-03/team/publish", body: null })
  for (const width of ["desktop", "narrow"] as const) {
    await page.setViewportSize(width === "desktop" ? { width: 1400, height: 1200 } : { width: 390, height: 1000 })
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
      await ordinary.screenshot({ animations: "disabled", path: join(artifacts, `shared-${width}-${theme}.png`) })
    }
  }
  await page.locator("#team-off").getByRole("button", { name: "Turn back on" }).click()
  await page.locator("#team-off").getByRole("button", { name: "Turn off on this machine" }).waitFor()
  await ordinary.getByRole("button", { name: "Remove from team file…" }).click()
  await ordinary.getByRole("button", { name: "Remove from team file", exact: true }).click()
  await ordinary.getByRole("button", { name: "Share with team" }).waitFor()
  expect(actions).toContainEqual({ path: "/api/memories/M-03/team/unshare", body: null })
  await page.setViewportSize({ width: 1400, height: 1200 })
  await page.evaluate(async () => {
    document.documentElement.classList.remove("dark")
    await (window as unknown as { fixtureLanguage: (language: string) => Promise<unknown> }).fixtureLanguage("zh-CN")
  })
  await page.locator("#team-default").getByRole("button", { name: "提议修改" }).waitFor()
  await page.locator("#team-default").screenshot({ animations: "disabled", path: join(artifacts, "team-default-desktop-zh-CN.png") })
  await library.screenshot({ animations: "disabled", path: join(artifacts, "board-team-desktop-zh-CN.png") })
  expect(errors).toEqual([])
}, 60_000)
