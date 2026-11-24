// Run against the packaged Electron executable, with synthetic data and no model calls.
const assert = require("node:assert/strict")
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { _electron } = require("playwright")

const desktopDir = __dirname
const executable = process.env.MEMOSYNC_SMOKE_EXECUTABLE || path.join(desktopDir, "release",
  ...(process.platform === "darwin"
    ? [process.arch === "arm64" ? "mac-arm64" : "mac", "MemoSync.app", "Contents", "MacOS", "MemoSync"]
    : process.platform === "win32" ? ["win-unpacked", "MemoSync.exe"] : ["linux-unpacked", "memosync"]))

async function command(page, value) {
  return page.evaluate(command => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace("http:", "ws:")}/ws`)
    const id = crypto.randomUUID()
    const timer = setTimeout(() => { socket.close(); reject(new Error("Command timed out")) }, 30_000)
    socket.onopen = () => socket.send(JSON.stringify({ v: 1, type: "command", id, command }))
    socket.onerror = () => { clearTimeout(timer); reject(new Error("Socket failed")) }
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.close()
      if (message.type === "error") reject(new Error(message.message))
      else if (message.type === "ack") resolve(message.result)
    }
  }), value)
}

async function checkDirtyQuit(app, page, workspace) {
  await page.getByRole("button", { name: "Files", exact: true }).click()
  await page.getByRole("button", { name: "README.md", exact: true }).click()
  await page.getByTitle("Edit source").click()
  const editor = page.locator(".cm-content[contenteditable=true]")
  const draft = "Synthetic unsaved desktop draft"
  await editor.fill(draft)
  const save = page.getByRole("button", { name: /^Save \(/ })
  await save.waitFor()

  // Drive Electron's actual quit and Files' beforeunload. Only answer the
  // blocking OS dialog in-process; no accessibility permissions on CI runners.
  page.once("dialog", () => {}) // Don't let Playwright auto-accept beforeunload over CDP.
  const options = await app.evaluate(async ({ app, Menu, dialog }) => {
    const original = dialog.showMessageBoxSync
    let timer
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Dirty Quit did not ask to discard")), 10_000)
        dialog.showMessageBoxSync = (_owner, options) => { resolve(options); return options.cancelId }
        if (process.platform === "darwin") Menu.sendActionToFirstResponder("terminate:")
        else app.quit()
      })
    } finally { clearTimeout(timer); dialog.showMessageBoxSync = original }
  })
  assert.match(options.message, /unsaved file changes|未保存的文件更改/)
  assert.match(options.buttons[options.cancelId], /^(Cancel|取消)$/)
  assert.equal(options.defaultId, options.cancelId)
  const win = await app.browserWindow(page)
  assert.equal(await win.evaluate(w => w.isVisible() && w.isEnabled()), true)
  assert.equal(await editor.innerText(), draft)
  const resumed = `${draft} after Cancel`
  await editor.fill(resumed)
  await save.click()
  await save.waitFor({ state: "hidden" })
  assert.equal(await readFile(path.join(workspace, "README.md"), "utf8"), resumed)
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memosync packaged smoke-"))
  const home = path.join(root, "home-测试")
  const workspace = path.join(home, "workspace with spaces")
  const dataDir = path.join(home, "data")
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, "README.md"), "# Synthetic desktop snapshot\n")
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ language: "en" }))
  await writeFile(path.join(dataDir, "release-check.json"), JSON.stringify({
    checkedAt: Date.now(),
    latest: { version: "999.0.0", url: "https://github.com/SLEEPYBQ/MemoSync/releases/tag/v999.0.0" },
  }))
  const env = {
    ...process.env, HOME: home, CFFIXED_USER_HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "local", "share"),
    XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"), CODEX_HOME: path.join(home, "codex"),
    MEMOSYNC_DESKTOP_DATA_DIR: dataDir, MEMOSYNC_DESKTOP_USER_DATA_DIR: path.join(home, "electron"),
    MEMOSYNC_USAGE_LOG: "0",
  }
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)) delete env[key]
  let app
  const launch = async () => {
    app = await _electron.launch({
      executablePath: executable, env, timeout: 60_000,
      args: ["--use-mock-keychain", "--password-store=basic", `--user-data-dir=${env.MEMOSYNC_DESKTOP_USER_DATA_DIR}`],
    })
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 })
    await page.waitForFunction(() => window.memosyncDesktop && document.getElementById("root")?.children.length > 0 && document.documentElement.lang === "en")
    const status = await page.evaluate(async () => (await fetch("/auth/status")).json())
    assert.equal(status.authenticated, true)
    assert.equal(status.canSignOut, false)
    assert.equal(await page.evaluate(() => window.memosyncDesktop.platform), process.platform)
    const update = await page.evaluate(() => window.memosyncDesktop.updates.getSnapshot())
    assert.equal(update.currentVersion, require("./package.json").version)
    assert.ok(["automatic", "installer"].includes(update.installMode))
    assert.notEqual(update.status, "unsupported")
    assert.equal(await page.evaluate(() => typeof window.memosyncDesktop.updates.onChange), "function")
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
    assert.equal(preferences.sandbox, true)
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.nodeIntegration, false)
    return page
  }
  try {
    let page = await launch()
    const origin = new URL(page.url()).origin
    const { projectId } = await command(page, { type: "project.create", localPath: workspace, title: "Synthetic desktop project" })
    assert.ok(projectId)
    await page.getByRole("heading", { name: "What should we build in workspace with spaces?", exact: true }).waitFor()
    const fileUrl = `${origin}/api/projects/${projectId}/files/README.md/content`
    assert.equal(await page.evaluate(async url => (await fetch(url)).text(), fileUrl), "# Synthetic desktop snapshot\n")
    const opened = app.waitForEvent("window")
    await page.evaluate(url => window.open(url), fileUrl)
    const content = await opened
    await content.waitForLoadState("domcontentloaded")
    assert.match(await content.locator("body").innerText(), /Synthetic desktop snapshot/)
    const contentWindow = await app.browserWindow(content)
    assert.equal(await contentWindow.evaluate(window => window.webContents.getLastWebPreferences().javascript), false)
    assert.equal(await content.evaluate(() => typeof window.memosyncDesktop), "undefined")
    await contentWindow.evaluate(window => window.close())
    await command(page, { type: "settings.writeAppSettingsPatch", patch: { theme: "dark" } })
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    const outputDir = path.join(desktopDir, "release", "smoke")
    await mkdir(outputDir, { recursive: true })
    // The app's real machine label is useful in the product, but not in test artifacts.
    let machineName = os.hostname().replace(/\.local$|\.lan$/i, "")
    if (process.platform === "darwin") machineName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() || machineName
    await page.screenshot({ path: path.join(outputDir, `${process.platform}-${process.arch}.png`), mask: [page.getByText(machineName)] })
    const sidebarWidth = (page) => page.getByRole("separator", { name: "Resize sidebar" }).evaluate(
      element => element.closest('[style*="--sidebar-width"]').style.getPropertyValue("--sidebar-width"),
    )
    await page.getByRole("separator", { name: "Resize sidebar" }).press("End")
    assert.equal(await sidebarWidth(page), "520px")
    await page.getByRole("button", { name: "Skip this version" }).click()
    await page.locator("[data-release-notice]").waitFor({ state: "hidden" })
    const { chatId } = await command(page, { type: "chat.create", projectId })
    await page.goto(`${origin}/chat/${chatId}`)
    await checkDirtyQuit(app, page, workspace)
    await page.goto(`${origin}/memory`)
    await page.getByRole("button", { name: "Board", exact: true }).click()
    await page.getByRole("button", { name: "Board", exact: true, pressed: true }).waitFor()
    await page.evaluate(() => localStorage.setItem("memosync:smoke-ephemeral", "synthetic"))
    await app.close()
    app = undefined
    await assert.rejects(fetch(`${origin}/auth/status`, { signal: AbortSignal.timeout(1000) }))
    page = await launch()
    await page.getByText("Synthetic desktop project", { exact: true }).first().waitFor()
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")).theme, "dark")
    assert.equal(await sidebarWidth(page), "520px")
    assert.equal(await page.locator("[data-release-notice]").count(), 0)
    assert.equal(await page.evaluate(() => localStorage.getItem("memosync:smoke-ephemeral")), null)
    await page.goto(`${new URL(page.url()).origin}/memory`)
    await page.getByRole("button", { name: "Board", exact: true, pressed: true }).waitFor()
    await app.close()
    app = undefined
    console.log(`Packaged ${process.platform}/${process.arch}: authenticated launch, file window, sandbox, dirty Quit/Cancel/save, persistence and clean restart passed`)
  } finally {
    if (app) {
      // A failed assertion can leave the synthetic editor dirty; don't hang cleanup on a dialog.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
