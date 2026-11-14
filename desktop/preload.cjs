// The smallest bridge the page needs to sit inside a native desktop window. The
// app stays a normal web page: everything here is optional and absent in a browser.
const { contextBridge, ipcRenderer, webFrame } = require("electron")

contextBridge.exposeInMainWorld("memosyncDesktop", {
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.send("memosync:set-theme", theme),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke("memosync:choose-directory", defaultPath),
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
