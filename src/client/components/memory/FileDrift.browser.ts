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
const artifacts = join(import.meta.dir, "../../../../artifacts/80")
beforeAll(async () => {
  vite = await createServer({ configFile: false, root: join(import.meta.dir, "../../test-fixtures/file-drift-ui"), plugins: [react()],
    optimizeDeps: { entries: [join(import.meta.dir, "../../test-fixtures/file-drift-ui/fixture.tsx"), join(import.meta.dir, "../../app/MemoryBoardPage.tsx")] },
    css: { postcss: join(import.meta.dir, "../../../..") }, server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARCHIVE_UI_BROWSER || undefined })
  await mkdir(artifacts, { recursive: true })
})
afterAll(async () => { await page?.close(); await browser?.close(); await vite?.close() })

test("file drift surfaces and acknowledgements", async () => {
  page = await browser.newPage({ viewport: { width: 1400, height: 1200 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const base = { scope: "project", projectId: "synthetic", type: "constraint", status: "active", abstractionLevel: "concrete", sensitive: false,
    createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 } as const
  let items: MemoryItem[] = [
    { ...base, id: "M-01", content: "Validate requests in src/auth.ts.", fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }] },
    { ...base, id: "M-02", content: "Run the synthetic test before release.", fileRefs: [{ path: "AGENTS.md", kind: "source", drift: "line_removed" }] },
  ]
  const imports: unknown[] = []
  let releaseFirstAck!: () => void
  const firstAck = new Promise<void>(resolve => { releaseFirstAck = resolve })
  await page.route("**/api/**", async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const id = path.match(/^\/api\/memories\/([^/]+)\//)?.[1]
    let data: unknown = []
    if (path === "/api/memories" && request.method() === "GET") data = items
    else if (path === "/api/memories/needs-attention" || path === "/api/memories/muted") data = { items: [] }
    else if (path === "/api/projects") data = [{ id: "synthetic", title: "Synthetic project" }]
    else if (path === "/api/chats") data = []
    else if (path === "/api/memories/md-status") data = { files: [{ scope: "personal", path: "synthetic/personal.md" }] }
    else if (path === "/api/memories/md-file") data = { path: "synthetic/personal.md", content: "" }
    else if (path === "/api/memories/md-import/sources") data = { sources: ["AGENTS.md", "CLAUDE.md", ".cursorrules"] }
    else if (path === "/api/memories/md-import" && request.method() === "POST") {
      imports.push(request.postDataJSON())
      data = { created: ["M-05"], skipped: 0 }
    } else if (path.endsWith("/history")) data = { memory: items.find(item => item.id === id) ?? { ...base, id }, events: [] }
    else if (path.endsWith("/acknowledge")) {
      if (id === "M-01") await firstAck
      items = items.map(item => item.id === id
        ? { ...item, fileRefs: item.fileRefs?.flatMap(ref => ref.drift === "line_removed" ? [] : [{ ...ref, drift: null }]) }
        : item)
      data = items.find(item => item.id === id)
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) })
  })
  await page.goto(url)
  const library = page.locator('#board [data-memory-board-section="library"]')
  await library.getByRole("button", { name: /Needs check/ }).click()
  expect(await library.locator('[data-memory-board-id="M-01"]').count()).toBe(1)
  expect(await library.locator('[data-memory-board-id="M-02"]').count()).toBe(1)
  expect(await library.getByText("Check · auth.ts changed").count()).toBe(1)
  expect(await library.getByText("Check · removed from AGENTS.md").count()).toBe(1)
  await page.locator("#changed").getByRole("button", { name: "Still applies" }).waitFor()
  await page.locator("#removed").getByRole("button", { name: "Keep as its own memory" }).waitFor()
  const previewLabel = page.locator("#preview").getByText("auth.ts changed", { exact: true })
  await previewLabel.waitFor()
  expect(await previewLabel.getAttribute("title")).toBe("src/auth.ts")
  expect(await previewLabel.getAttribute("class")).toContain("bg-cand-surface")
  await page.locator("#import [data-expandable-toggle]").click()
  await page.locator("#import select").selectOption("synthetic")
  await page.locator("#import").getByRole("button", { name: "Import from AGENTS.md" }).click()
  expect(imports).toMatchObject([{ scope: "project", projectId: "synthetic", sourcePath: "AGENTS.md" }])
  await page.locator("#import").getByText("Source linked — you'll be told if a line is removed.").waitFor()
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await library.screenshot({ animations: "disabled", path: join(artifacts, `board-desktop-${theme}.png`) })
    for (const name of ["changed", "missing", "removed", "multiple", "preview", "import"]) {
      await page.locator(`#${name}`).screenshot({ animations: "disabled", path: join(artifacts, `${name}-desktop-${theme}.png`) })
    }
    await page.locator("#citation").getByText("[M-01]").hover()
    const popover = page.locator("[data-radix-popper-content-wrapper]").filter({ hasText: "Check · auth.ts changed" })
    await popover.waitFor()
    await popover.screenshot({ animations: "disabled", path: join(artifacts, `citation-desktop-${theme}.png`) })
  }
  await page.setViewportSize({ width: 390, height: 1000 })
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    for (const name of ["changed", "missing", "removed", "multiple", "preview"]) {
      await page.locator(`#${name}`).screenshot({ animations: "disabled", path: join(artifacts, `${name}-narrow-${theme}.png`) })
    }
  }
  await page.setViewportSize({ width: 1400, height: 1200 })
  await page.evaluate(async () => {
    document.documentElement.classList.remove("dark")
    await (window as unknown as { fixtureLanguage: (language: string) => Promise<unknown> }).fixtureLanguage("zh-CN")
  })
  await page.locator("#changed").getByRole("button", { name: "仍然适用" }).waitFor()
  await page.locator("#changed").screenshot({ animations: "disabled", path: join(artifacts, "changed-desktop-zh-CN.png") })
  await library.screenshot({ animations: "disabled", path: join(artifacts, "board-desktop-zh-CN.png") })
  await page.evaluate(async () => { await (window as unknown as { fixtureLanguage: (language: string) => Promise<unknown> }).fixtureLanguage("en") })
  for (const [id, action] of [["M-01", "Still applies"], ["M-02", "Keep as its own memory"]] as const) {
    await library.locator(`[data-memory-board-id="${id}"]`).click()
    const detail = page.locator(`[data-memory-detail-id="${id}"]`)
    await detail.getByRole("button", { name: action }).click()
    if (id === "M-01") {
      await detail.getByRole("button", { name: action }).locator(".animate-spin").waitFor()
      expect(await detail.getByRole("button", { name: action }).isDisabled()).toBe(true)
      releaseFirstAck()
    }
    await detail.getByRole("button", { name: action }).waitFor({ state: "hidden" })
    await detail.getByRole("button", { name: "Close" }).click()
  }
  await library.getByText("Nothing to check — referenced files match what was recorded.").waitFor()
  expect(await library.getByRole("button", { name: "Needs check" }).count()).toBe(1)
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark")
    await library.screenshot({ animations: "disabled", path: join(artifacts, `empty-desktop-${theme}.png`) })
  }
  expect(errors).toEqual([])
}, 60_000)
