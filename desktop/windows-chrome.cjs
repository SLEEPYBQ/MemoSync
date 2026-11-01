function titleBarColors(dark) {
  return { color: dark ? "#21201f" : "#ffffff", symbolColor: dark ? "#f2f0ee" : "#09090b", height: 36 }
}

function connectWindowTheme(window, ipcMain) {
  const updateTheme = (event, dark) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || typeof dark !== "boolean") return
    window.setTitleBarOverlay(titleBarColors(dark))
  }
  ipcMain.on("memosync:window-theme", updateTheme)
  window.once("closed", () => ipcMain.removeListener("memosync:window-theme", updateTheme))
}

module.exports = { titleBarColors, connectWindowTheme }
