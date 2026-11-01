const { isAppContentUrl, isAppUrl, isExternalUrl } = require("./policy.cjs")

function isMainNavigationUrl(value, origin) {
  if (!isAppUrl(value, origin)) return false
  const pathname = new URL(value).pathname
  return pathname === "/"
    || pathname === "/index.html"
    || /^\/(?:settings(?:\/[^/]+)?|memory|chat\/[^/]+)\/?$/.test(pathname)
}

function classifyNavigation(value, origin, target) {
  if (target === "content") return isAppContentUrl(value, origin) ? "content" : "deny"
  if (isAppContentUrl(value, origin)) return "content"
  if (isMainNavigationUrl(value, origin)) return "main"
  if (isAppUrl(value, origin)) return "deny"
  if (isExternalUrl(value)) return "external"
  return "deny"
}

function installNavigationHandlers(webContents, origin, target, actions = {}) {
  const allowedTarget = target === "content" ? "content" : "main"
  const dispatch = (url) => {
    const decision = classifyNavigation(url, origin, allowedTarget)
    if (allowedTarget === "main") {
      if (decision === "content") actions.openContent?.(url)
      else if (decision === "external") actions.openExternal?.(url)
      else if (decision === "main") actions.navigateMain?.(url)
    } else if (decision === "content") {
      actions.openContent?.(url)
    }
    return decision
  }

  webContents.on("will-navigate", (event, url) => {
    const decision = classifyNavigation(url, origin, allowedTarget)
    if (decision === allowedTarget) return
    event.preventDefault()
    if (allowedTarget === "main" && (decision === "content" || decision === "external")) {
      dispatch(url)
    }
  })

  webContents.on("will-redirect", (event, url) => {
    if (classifyNavigation(url, origin, allowedTarget) !== allowedTarget) event.preventDefault()
  })

  webContents.setWindowOpenHandler(({ url }) => {
    dispatch(url)
    return { action: "deny" }
  })
}

function contentWindowOptions(desktopSession) {
  return {
    title: "MemoSync attachment",
    show: true,
    webPreferences: {
      session: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      javascript: false,
    },
  }
}

module.exports = {
  classifyNavigation,
  contentWindowOptions,
  installNavigationHandlers,
  isAppContentUrl,
  isMainNavigationUrl,
}
