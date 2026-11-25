const { isMainAppFrame, isMainNavigationUrl } = require("./navigation.cjs")

// Only the application document can invoke updater actions. In particular,
// attachment windows and preview frames must never be able to run an installer.
function installUpdateHandlers({ ipcMain, updater, getMainWindow, getOrigin, confirmInstall }) {
  let installation
  const methods = {
    "get-snapshot": () => updater.getSnapshot(),
    check: () => updater.checkForUpdates(),
    download: () => updater.downloadUpdate(),
    install: () => {
      if (!installation) {
        installation = (async () => {
          const snapshot = updater.getSnapshot()
          if (snapshot.status !== "downloaded") return snapshot
          if (snapshot.installMode === "automatic") {
            const confirmed = await confirmInstall()
            const current = updater.getSnapshot()
            // A periodic check can supersede the download while the dialog is open.
            if (!confirmed || current.status !== "downloaded" || current.latestVersion !== snapshot.latestVersion) return current
          }
          return updater.installUpdate()
        })().finally(() => { installation = undefined })
      }
      return installation
    },
  }
  for (const [name, action] of Object.entries(methods)) {
    ipcMain.handle(`memosync:updates:${name}`, (event) => {
      if (!isMainAppFrame(event, getMainWindow(), getOrigin())) {
        throw new Error("Updates are only available in the main app window")
      }
      return action()
    })
  }
  const unsubscribe = updater.onChange((snapshot) => {
    const owner = getMainWindow()
    if (owner && !owner.isDestroyed() && isMainNavigationUrl(owner.webContents.getURL(), getOrigin())) {
      owner.webContents.send("memosync:updates:changed", snapshot)
    }
  })
  return () => {
    unsubscribe()
    for (const name of Object.keys(methods)) ipcMain.removeHandler(`memosync:updates:${name}`)
  }
}

module.exports = { installUpdateHandlers }
