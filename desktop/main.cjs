const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell } = require("electron")
const { spawn } = require("node:child_process")
const { randomBytes } = require("node:crypto")
const { createInterface } = require("node:readline")
const path = require("node:path")
const { trackBackendProcess } = require("./backend-lifecycle.cjs")
const { isAppUrl, isExternalUrl, parseReadyLine } = require("./policy.cjs")
const { canGrantDesktopPermission, contentWindowOptions, installNavigationHandlers } = require("./navigation.cjs")

let backend
let backendLifecycle
let mainWindow
let origin
let quitting = false
let stopped = false
let desktopSession
const contentWindows = new Set()

// The page runs up to the top edge, with the traffic lights centred in its 48px
// top band. No background colour: that would switch off the sidebar's material.
const MAC_WINDOW_OPTIONS = process.platform === "darwin"
  ? { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLightPosition(1) }
  : {}

// The lights are native and ignore page zoom, so they follow the page's 48px band by hand.
function trafficLightPosition(zoom) {
  return { x: 18, y: Math.round(24 * zoom - 7) }
}

// The Dock icon follows the app's theme while it runs; Finder keeps icon.icns.
function syncDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(path.join(__dirname, nativeTheme.shouldUseDarkColors ? "icon-dark.png" : "icon-light.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#21201f" : "#fbfbf9"
}

async function openExternal(url) {
  if (!isExternalUrl(url)) return
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Open external link",
    message: "Open this link in your default browser?",
    detail: url,
    buttons: ["Cancel", "Open"],
    defaultId: 0,
    cancelId: 0,
  })
  if (response === 1) await shell.openExternal(url)
}

function createWindow() {
  if (!origin || quitting) return
  mainWindow = new BrowserWindow({
    title: "MemoSync",
    width: 1320,
    height: 880,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(),
    ...MAC_WINDOW_OPTIONS,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      session: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  installNavigationHandlers(mainWindow.webContents, origin, "main", {
    openContent: (url) => { createContentWindow(url) },
    openExternal: (url) => { void openExternal(url) },
    navigateMain: (url) => {
      if (!mainWindow?.isDestroyed()) {
        void mainWindow.loadURL(url)
        mainWindow.focus()
      }
    },
  })
  mainWindow.once("ready-to-show", () => mainWindow?.show())
  for (const [event, fullscreen] of [["enter-full-screen", true], ["leave-full-screen", false]]) {
    mainWindow.on(event, () => mainWindow?.webContents.send("memosync:fullscreen", fullscreen))
  }
  mainWindow.on("closed", () => { mainWindow = undefined })
  mainWindow.loadURL(origin).catch((error) => {
    if (!quitting) {
      dialog.showErrorBox("MemoSync failed to load", error.message)
      app.quit()
    }
  })
}

function createContentWindow(url) {
  if (!origin || quitting || !desktopSession) return
  const contentWindow = new BrowserWindow(contentWindowOptions(desktopSession))
  contentWindows.add(contentWindow)
  installNavigationHandlers(contentWindow.webContents, origin, "content", {
    openContent: (nextUrl) => { createContentWindow(nextUrl) },
  })
  contentWindow.on("closed", () => contentWindows.delete(contentWindow))
  contentWindow.loadURL(url).catch(() => contentWindow.close())
}

function startBackend(password) {
  const root = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.resolve(__dirname, "..")
  const bun = app.isPackaged
    ? path.join(root, process.platform === "win32" ? "bun.exe" : "bun")
    : process.env.MEMOSYNC_BUN_PATH || "bun"
  return new Promise((resolve, reject) => {
    let ready = false
    const timeout = setTimeout(() => reject(new Error("The local backend did not start within 60 seconds.")), 60_000)
    backend = spawn(bun, [path.join(root, "desktop", "server.ts")], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PATH: [root, process.env.PATH].filter(Boolean).join(path.delimiter),
        MEMOSYNC_RUNTIME_PROFILE: "prod",
        MEMOSYNC_EXTERNAL_AGENTS: "1",
      },
    })
    backendLifecycle = trackBackendProcess(backend)
    backend.stdin.on("error", () => {})
    backend.once("error", (error) => {
      clearTimeout(timeout)
      stopped = true
      reject(error)
    })
    backend.once("exit", (code) => {
      clearTimeout(timeout)
      stopped = true
      if (!ready) reject(new Error(`The local backend exited (${code}). Check that no other MemoSync instance is using your data directory.`))
      else if (!quitting) {
        dialog.showErrorBox("MemoSync backend stopped", "The local backend stopped unexpectedly. Quit and reopen MemoSync.")
        app.quit()
      }
    })
    backend.stderr.on("data", (data) => process.stderr.write(data))
    const lines = createInterface({ input: backend.stdout })
    lines.on("line", (line) => {
      try {
        const url = parseReadyLine(line)
        if (url && !ready) { ready = true; clearTimeout(timeout); resolve(url) }
        else if (!url) console.log(line)
      } catch (error) { clearTimeout(timeout); reject(error) }
    })
    backend.stdin.write(`${JSON.stringify({ type: "start", password, dataDir: process.env.MEMOSYNC_DESKTOP_DATA_DIR })}\n`)
  })
}

async function authenticate(password) {
  const response = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  if (!response.ok || !cookie?.startsWith("memosync_session=")) throw new Error("Could not authenticate the desktop session")
  await desktopSession.cookies.set({
    url: origin,
    name: "memosync_session",
    value: cookie.slice("memosync_session=".length),
    path: "/",
    httpOnly: true,
    sameSite: "strict",
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => {
    if (!mainWindow) createWindow()
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
  app.on("activate", () => { if (!mainWindow) createWindow() })
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
  app.on("before-quit", (event) => {
    for (const contentWindow of contentWindows) contentWindow.close()
    if (!backend || stopped || backendLifecycle.stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    mainWindow?.hide()
    const timer = setTimeout(() => { backend.kill("SIGKILL") }, 20_000)
    void backendLifecycle.waitForStop().then(() => { clearTimeout(timer); app.quit() })
    backend.stdin.end(`${JSON.stringify({ type: "stop" })}\n`)
  })
  // Follows the app's own theme setting, so the lights and the window behind the page match it.
  ipcMain.on("memosync:set-theme", (event, theme) => {
    if (event.sender !== mainWindow?.webContents) return
    if (theme === "system" || theme === "light" || theme === "dark") nativeTheme.themeSource = theme
    mainWindow.setBackgroundColor(windowBackground())
  })
  ipcMain.on("memosync:zoom", (event, zoom) => {
    if (event.sender !== mainWindow?.webContents || process.platform !== "darwin") return
    if (typeof zoom === "number" && zoom >= 0.25 && zoom <= 5) mainWindow.setWindowButtonPosition(trafficLightPosition(zoom))
  })
  nativeTheme.on("updated", syncDockIcon)
  app.whenReady().then(async () => {
    syncDockIcon()
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]))
    desktopSession = session.fromPartition(`memosync-${randomBytes(12).toString("hex")}`)
    desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback(canGrantDesktopPermission(webContents, mainWindow?.webContents, permission, details, origin))
    })
    desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      return isAppUrl(requestingOrigin, origin)
        && canGrantDesktopPermission(webContents, mainWindow?.webContents, permission, details, origin)
    })
    const password = randomBytes(32).toString("hex")
    origin = await startBackend(password)
    await authenticate(password)
    createWindow()
  }).catch((error) => {
    dialog.showErrorBox("MemoSync could not start", `${error.message}\n\nYour existing data has not been removed.`)
    app.quit()
  })
}
