function installWindowLifecycle(app, { confirmDiscard, stopBackend }) {
  let quitting = false
  let stopping
  let installWindow

  // before-quit is too early: Electron hasn't asked the renderer whether it may close.
  app.on("will-quit", (event) => {
    quitting = true
    if (!stopping) {
      stopping = stopBackend()
      stopping?.then(() => { stopping = undefined; app.quit() })
    }
    if (stopping) event.preventDefault()
  })

  return {
    get quitting() { return quitting },
    guardWindow(owner) {
      owner.on("close", (event) => {
        if (owner === installWindow && !quitting) event.preventDefault()
      })
      owner.webContents.on("will-prevent-unload", (event) => {
        // Electron keeps the document by default. preventDefault here *allows* the unload.
        if (owner === installWindow ? quitting : confirmDiscard(owner)) event.preventDefault()
      })
    },
    // The native restart dialog explicitly authorizes discarding edits. Don't allow
    // new edits during the filesystem preflight or while waiting for the backend.
    beginInstall(owner) { installWindow = owner; owner?.setEnabled(false) },
    cancelInstall() {
      if (quitting) return
      if (installWindow && !installWindow.isDestroyed()) installWindow.setEnabled(true)
      installWindow = undefined
    },
    finishInstall() { quitting = true },
  }
}

module.exports = { installWindowLifecycle }
