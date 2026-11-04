const { describe, it } = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { trackBackendProcess } = require("./backend-lifecycle.cjs")
const { isAppUrl, isExternalUrl, parseReadyLine } = require("./policy.cjs")
const { canGrantDesktopPermission, classifyNavigation, contentWindowOptions, installNavigationHandlers } = require("./navigation.cjs")

describe("desktop permissions", () => {
  const origin = "http://127.0.0.1:43210"
  const main = { isDestroyed: () => false, getURL: () => `${origin}/settings/general` }
  const details = { isMainFrame: true, requestingUrl: `${origin}/settings/general` }

  it("allows notifications only from the trusted main application document", () => {
    assert.equal(canGrantDesktopPermission(main, main, "notifications", details, origin), true)
    for (const requester of [null, { ...main }, { ...main, isDestroyed: () => true }]) {
      assert.equal(canGrantDesktopPermission(requester, main, "notifications", details, origin), false)
    }
    for (const invalid of [undefined, {}, { ...details, isMainFrame: false }, { ...details, requestingUrl: "https://example.com" }, { ...details, requestingUrl: `${origin}/__memosync/preview/1234/` }]) {
      assert.equal(canGrantDesktopPermission(main, main, "notifications", invalid, origin), false)
    }
    const navigated = { ...main, getURL: () => "https://example.com" }
    assert.equal(canGrantDesktopPermission(navigated, navigated, "notifications", details, origin), false)
    const destroyed = { ...main, isDestroyed: () => true }
    assert.equal(canGrantDesktopPermission(destroyed, destroyed, "notifications", details, origin), false)
  })

  it("continues denying other browser permissions", () => {
    for (const permission of ["media", "geolocation", "clipboard-read", "openExternal", "unknown"]) {
      assert.equal(canGrantDesktopPermission(main, main, permission, details, origin), false)
    }
  })
})

describe("desktop backend process lifecycle", () => {
  it("releases shutdown wait when the runtime cannot be spawned", async () => {
    const child = new EventEmitter()
    const lifecycle = trackBackendProcess(child)
    child.emit("error", Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" }))
    assert.equal(await Promise.race([
      lifecycle.waitForStop().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]), true)
    assert.equal(lifecycle.stopped, true)
  })
})

describe("desktop navigation boundary", () => {
  const origin = "http://127.0.0.1:43210"
  it("allows application routes but not other origins or credential-bearing URLs", () => {
    assert.equal(isAppUrl(`${origin}/project/one`, origin), true)
    for (const url of ["http://127.0.0.1:43211", "http://localhost:43210", "https://example.com", "file:///etc/passwd", "http://user@127.0.0.1:43210"]) {
      assert.equal(isAppUrl(url, origin), false)
    }
  })
  it("only offers plain web links to the external browser", () => {
    assert.equal(isExternalUrl("https://example.com/docs"), true)
    assert.equal(isExternalUrl("http://localhost:3000"), true)
    for (const url of ["javascript:alert(1)", "file:///tmp/test", "vscode://file/test", "https://user:password@example.com", "not a URL"]) {
      assert.equal(isExternalUrl(url), false)
    }
  })

  it("dispatches content and external popups without forwarding rejected app URLs", () => {
    const webContents = new EventEmitter()
    webContents.setWindowOpenHandler = (handler) => { webContents.windowOpenHandler = handler }
    const actions = []
    installNavigationHandlers(webContents, origin, "main", {
      openContent: (url) => actions.push(["content", url]),
      openExternal: (url) => actions.push(["external", url]),
      navigateMain: (url) => actions.push(["main", url]),
    })

    const contentUrl = `${origin}/api/projects/project-1/uploads/file%2Fname/content`
    const contentNavigation = { prevented: false, preventDefault() { this.prevented = true } }
    webContents.emit("will-navigate", contentNavigation, contentUrl)
    assert.equal(contentNavigation.prevented, true)
    assert.deepEqual(actions, [["content", contentUrl]])

    const externalPopup = webContents.windowOpenHandler({ url: "https://example.com/docs" })
    assert.deepEqual(externalPopup, { action: "deny" })
    assert.deepEqual(actions.at(-1), ["external", "https://example.com/docs"])

    const rejectedPopup = webContents.windowOpenHandler({ url: `${origin}/api/projects/project-1/unknown` })
    assert.deepEqual(rejectedPopup, { action: "deny" })
    assert.equal(actions.length, 2)

    const previewNavigation = { prevented: false, preventDefault() { this.prevented = true } }
    webContents.emit("will-navigate", previewNavigation, `${origin}/__memosync/preview/4321/`)
    assert.equal(previewNavigation.prevented, true)
    assert.equal(actions.length, 2)

    const appPopup = webContents.windowOpenHandler({ url: `${origin}/settings/general` })
    assert.deepEqual(appPopup, { action: "deny" })
    assert.deepEqual(actions.at(-1), ["main", `${origin}/settings/general`])
  })

  it("allows only app routes in the main window, never arbitrary HTML paths", () => {
    for (const route of ["/", "/index.html", "/settings", "/settings/general", "/memory", "/chat/chat-1?view=files"]) {
      assert.equal(classifyNavigation(`${origin}${route}`, origin, "main"), "main")
    }
    for (const route of ["/project.html", "/assets/example.html", "/other", "/settings/general/example.html"]) {
      assert.equal(classifyNavigation(`${origin}${route}`, origin, "main"), "deny")
    }
    assert.equal(classifyNavigation(`${origin}/api/projects/project-1/files/page.html/content`, origin, "main"), "content")
  })

  it("keeps content windows on allowed content routes and blocks redirects", () => {
    const webContents = new EventEmitter()
    webContents.setWindowOpenHandler = (handler) => { webContents.windowOpenHandler = handler }
    const actions = []
    installNavigationHandlers(webContents, origin, "content", {
      openContent: (url) => actions.push(["content", url]),
    })

    const allowed = { prevented: false, preventDefault() { this.prevented = true } }
    const contentUrl = `${origin}/api/projects/project-1/files/file.txt/content`
    webContents.emit("will-redirect", allowed, contentUrl)
    assert.equal(allowed.prevented, false)

    const blocked = { prevented: false, preventDefault() { this.prevented = true } }
    webContents.emit("will-redirect", blocked, `${origin}/settings/general`)
    assert.equal(blocked.prevented, true)
    assert.deepEqual(actions, [])

    const popup = webContents.windowOpenHandler({ url: contentUrl })
    assert.deepEqual(popup, { action: "deny" })
    assert.deepEqual(actions, [["content", contentUrl]])
  })

  it("creates content windows with the isolated desktop session and no script execution", () => {
    const desktopSession = {}
    const options = contentWindowOptions(desktopSession)
    assert.equal(options.webPreferences.session, desktopSession)
    assert.equal(options.webPreferences.nodeIntegration, false)
    assert.equal(options.webPreferences.contextIsolation, true)
    assert.equal(options.webPreferences.sandbox, true)
    assert.equal(options.webPreferences.webSecurity, true)
    assert.equal(options.webPreferences.webviewTag, false)
    assert.equal(options.webPreferences.javascript, false)
    assert.equal("preload" in options.webPreferences, false)
  })
})

describe("desktop backend readiness", () => {
  it("ignores ordinary logs and validates the bound loopback port", () => {
    assert.equal(parseReadyLine("[memosync] starting"), null)
    assert.equal(parseReadyLine('MEMOSYNC_DESKTOP_READY:{"port":43210}'), "http://127.0.0.1:43210")
    for (const port of [0, -1, 65536, "3210", 1.5, null]) {
      assert.throws(() => parseReadyLine(`MEMOSYNC_DESKTOP_READY:${JSON.stringify({ port })}`))
    }
  })
})
