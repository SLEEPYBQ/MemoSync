import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import type {} from "../../test-fixtures/desktop-update-ui/fixture"

let vite: ViteDevServer
let browser: Browser
let page: Page
let url: string
const errors: string[] = []
const screenshotDir = join(import.meta.dir, "../../../../.codex-runs/desktop-update-ui")

beforeAll(async () => {
  vite = await createServer({
    configFile: false,
    root: join(import.meta.dir, "../../test-fixtures/desktop-update-ui"),
    plugins: [react()],
    css: { postcss: join(import.meta.dir, "../../../..") },
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  if (process.env.MEMOSYNC_UPDATE_SCREENSHOTS) await mkdir(screenshotDir, { recursive: true })
})
afterEach(async () => {
  await page?.close()
  expect(errors).toEqual([])
  errors.length = 0
})
afterAll(async () => { await browser?.close(); await vite?.close() })

async function open(query = "") {
  page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  page.setDefaultTimeout(3000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort())
  await page.goto(`${url}/${query}`)
  await page.locator("#applicationUpdate").waitFor()
  await page.waitForFunction(() => window.desktopUpdateFixture.listeners() === 1)
}

test("checks, downloads with progress and installs only after the corresponding clicks", async () => {
  await open()
  expect(await page.evaluate(() => window.desktopUpdateFixture.calls())).toEqual([])
  await page.getByRole("button", { name: "Check for updates", exact: true }).click()
  expect(await page.getByRole("button", { name: "Checking…", exact: true }).isDisabled()).toBe(true)
  await page.evaluate(() => window.desktopUpdateFixture.finish({ status: "available", latestVersion: "1.1.0" }))
  await page.getByRole("button", { name: "Download update", exact: true }).click()
  await page.evaluate(() => window.desktopUpdateFixture.publish({ progress: 42.2 }))
  await page.getByRole("status").filter({ hasText: "Downloading update: 42%" }).waitFor()
  expect(await page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42")
  expect(await page.getByRole("button", { name: "Downloading…", exact: true }).isDisabled()).toBe(true)
  if (process.env.MEMOSYNC_UPDATE_SCREENSHOTS) await page.screenshot({ path: join(screenshotDir, "download-progress.png"), animations: "disabled" })
  expect(await page.evaluate(() => window.desktopUpdateFixture.calls())).toEqual(["check", "download"])
  await page.evaluate(() => window.desktopUpdateFixture.finish({ status: "downloaded", progress: 100 }))
  await page.getByText("Restarting stops running chats and terminals. Install when your work is ready.").waitFor()
  await page.getByRole("button", { name: "Restart and install", exact: true }).click()
  expect(await page.evaluate(() => window.desktopUpdateFixture.calls())).toEqual(["check", "download", "install"])
  // A canceled native confirmation leaves the verified download available.
  await page.evaluate(() => window.desktopUpdateFixture.finish({ status: "downloaded" }))
  await page.getByRole("button", { name: "Restart and install", exact: true }).waitFor()
})

test("shows errors and allows a fresh check before retrying the download", async () => {
  await open()
  await page.evaluate(() => window.desktopUpdateFixture.publish({ status: "error", error: "Checksum mismatch", latestVersion: "1.1.0" }))
  await page.getByRole("alert").filter({ hasText: "Checksum mismatch" }).waitFor()
  await page.getByRole("button", { name: "Check again", exact: true }).click()
  await page.evaluate(() => window.desktopUpdateFixture.finish({ status: "available", error: null }))
  await page.getByRole("button", { name: "Download update", exact: true }).waitFor()
  expect(await page.getByRole("alert").count()).toBe(0)
})

test("macOS offers the verified installer with Chinese replacement instructions", async () => {
  await open("?platform=darwin&language=zh-CN")
  await page.evaluate(() => window.desktopUpdateFixture.publish({ status: "downloaded", latestVersion: "1.1.0", progress: 100 }))
  await page.getByText("下载完成后打开安装包，退出 MemoSync，将新版应用拖入“应用程序”文件夹，再重新打开。").waitFor()
  expect(await page.getByRole("button", { name: "重启并安装", exact: true }).count()).toBe(0)
  await page.setViewportSize({ width: 420, height: 600 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (process.env.MEMOSYNC_UPDATE_SCREENSHOTS) await page.screenshot({ path: join(screenshotDir, "mac-installer-zh-narrow.png"), animations: "disabled" })
  await page.getByRole("button", { name: "打开安装包", exact: true }).click()
  expect(await page.evaluate(() => window.desktopUpdateFixture.calls())).toEqual(["install"])
})

test("late initial replies cannot overwrite download progress and unmount removes the listener", async () => {
  await open("?deferInitial")
  await page.evaluate(() => window.desktopUpdateFixture.publish({ status: "downloading", latestVersion: "1.1.0", progress: 73 }))
  await page.getByRole("status").filter({ hasText: "Downloading update: 73%" }).waitFor()
  await page.evaluate(() => window.desktopUpdateFixture.resolveInitial())
  expect(await page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("73")
  await page.evaluate(() => window.desktopUpdateFixture.unmount())
  expect(await page.evaluate(() => window.desktopUpdateFixture.listeners())).toBe(0)
})

test("unsupported builds show a reason without offering install actions", async () => {
  await open()
  await page.evaluate(() => window.desktopUpdateFixture.publish({ status: "unsupported", installMode: "unsupported" }))
  await page.getByText("Updates are available in supported packaged desktop builds.").waitFor()
  expect(await page.getByRole("button").count()).toBe(0)
})
