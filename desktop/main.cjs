const { app, BrowserWindow, dialog, Menu, session, shell } = require("electron")
const { spawn } = require("node:child_process")
const { randomBytes } = require("node:crypto")
const { createInterface } = require("node:readline")
const path = require("node:path")
const { trackBackendProcess } = require("./backend-lifecycle.cjs")
const { isAppUrl, isExternalUrl, parseReadyLine } = require("./policy.cjs")

let backend
let backendLifecycle
let mainWindow
let origin
let quitting = false
let stopped = false
let desktopSession

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
    backgroundColor: "#faf9f6",
    webPreferences: {
      session: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, origin)) {
      event.preventDefault()
      void openExternal(url)
    }
  })
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url, origin)) event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)
    return { action: "deny" }
  })
  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.on("closed", () => { mainWindow = undefined })
  mainWindow.loadURL(origin).catch((error) => {
    if (!quitting) {
      dialog.showErrorBox("MemoSync failed to load", error.message)
      app.quit()
    }
  })
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
    if (!backend || stopped || backendLifecycle.stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    mainWindow?.hide()
    const timer = setTimeout(() => { backend.kill("SIGKILL") }, 20_000)
    void backendLifecycle.waitForStop().then(() => { clearTimeout(timer); app.quit() })
    backend.stdin.end(`${JSON.stringify({ type: "stop" })}\n`)
  })
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]))
    desktopSession = session.fromPartition(`memosync-${randomBytes(12).toString("hex")}`)
    desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    desktopSession.setPermissionCheckHandler(() => false)
    const password = randomBytes(32).toString("hex")
    origin = await startBackend(password)
    await authenticate(password)
    createWindow()
  }).catch((error) => {
    dialog.showErrorBox("MemoSync could not start", `${error.message}\n\nYour existing data has not been removed.`)
    app.quit()
  })
}
