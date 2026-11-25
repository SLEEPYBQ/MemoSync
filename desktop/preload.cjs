// The smallest bridge the page needs to sit inside a native desktop window. The
// app stays a normal web page: everything here is optional and absent in a browser.
const { contextBridge, ipcRenderer, webFrame } = require("electron")

contextBridge.exposeInMainWorld("memosyncDesktop", {
  platform: process.platform,
  uiPreferences: {
    get: (key) => ipcRenderer.sendSync("memosync:get-ui-preference", key),
    set: (key, value) => { ipcRenderer.sendSync("memosync:set-ui-preference", key, value) },
  },
  setTheme: (theme) => ipcRenderer.send("memosync:set-theme", theme),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke("memosync:choose-directory", defaultPath),
  updates: {
    getSnapshot: () => ipcRenderer.invoke("memosync:updates:get-snapshot"),
    checkForUpdates: () => ipcRenderer.invoke("memosync:updates:check"),
    downloadUpdate: () => ipcRenderer.invoke("memosync:updates:download"),
    installUpdate: () => ipcRenderer.invoke("memosync:updates:install"),
    onChange: (listener) => {
      const handler = (_event, snapshot) => listener(snapshot)
      ipcRenderer.on("memosync:updates:changed", handler)
      return () => ipcRenderer.removeListener("memosync:updates:changed", handler)
    },
  },
})

// The traffic lights leave in full screen, so the room kept for them has to go too.
ipcRenderer.on("memosync:fullscreen", (_event, fullscreen) => {
  document.documentElement.toggleAttribute("data-fullscreen", Boolean(fullscreen))
})

// Page zoom scales the page but not the lights: tell both sides, so they stay lined up.
function syncZoom() {
  const zoom = webFrame.getZoomFactor()
  document.documentElement.style.setProperty("--desktop-zoom", String(zoom))
  ipcRenderer.send("memosync:zoom", zoom)
}
window.addEventListener("DOMContentLoaded", syncZoom)
window.addEventListener("resize", syncZoom)
