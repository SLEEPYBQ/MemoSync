const { describe, it } = require("node:test")
const assert = require("node:assert/strict")
const { installUpdateHandlers } = require("./update-ipc.cjs")

function fixture() {
  const handlers = new Map()
  const sent = []
  const origin = "http://127.0.0.1:43210"
  const mainFrame = { url: `${origin}/settings/about` }
  const webContents = { mainFrame, getURL: () => mainFrame.url, send: (...args) => sent.push(args) }
  const mainWindow = { webContents, isDestroyed: () => false }
  const event = { sender: webContents, senderFrame: mainFrame }
  const calls = []
  let changed
  let confirm = async () => true
  let snapshot = { status: "downloaded", installMode: "automatic" }
  const updater = {
    getSnapshot: () => snapshot,
    checkForUpdates: async () => { calls.push("check"); return snapshot },
    downloadUpdate: async () => { calls.push("download"); return snapshot },
    installUpdate: async () => { calls.push("install"); return snapshot },
    onChange: (callback) => { changed = callback; return () => { changed = undefined } },
  }
  const dispose = installUpdateHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    updater, getMainWindow: () => mainWindow, getOrigin: () => origin,
    confirmInstall: () => confirm(),
  })
  return {
    handlers, event, mainFrame, mainWindow, calls, sent, dispose,
    invoke: (name, input = event, ...args) => handlers.get(`memosync:updates:${name}`)(input, ...args),
    setSnapshot: value => { snapshot = value },
    setConfirm: value => { confirm = value },
    emit: value => changed?.(value),
  }
}

describe("desktop update IPC", () => {
  it("rejects every updater action from other windows, iframes and non-app documents", () => {
    for (const name of ["get-snapshot", "check", "download", "install"]) {
      const f = fixture()
      for (const event of [
        { ...f.event, sender: {} },
        { ...f.event, senderFrame: { ...f.mainFrame } },
      ]) assert.throws(() => f.invoke(name, event), /main app window/)
      for (const url of ["https://example.com", "http://127.0.0.1:43211/settings/about", "http://127.0.0.1:43210/api/projects/id/files/page.html/content", "http://127.0.0.1:43210/__memosync/preview/1234/"]) {
        f.mainFrame.url = url
        assert.throws(() => f.invoke(name), /main app window/)
      }
      assert.deepEqual(f.calls, [])
    }
  })

  it("exposes fixed operations, broadcasts only to the app, and cleans up handlers", async () => {
    const f = fixture()
    await f.invoke("check", f.event, "https://example.com/installer.exe")
    await f.invoke("download", f.event, "/tmp/untrusted.exe")
    assert.deepEqual(f.calls, ["check", "download"])
    f.emit({ status: "downloading", progress: 40 })
    assert.deepEqual(f.sent, [["memosync:updates:changed", { status: "downloading", progress: 40 }]])
    f.mainFrame.url = "http://127.0.0.1:43210/api/projects/id/files/page.html/content"
    f.emit({ status: "downloaded" })
    assert.equal(f.sent.length, 1)
    f.dispose()
    assert.equal(f.handlers.size, 0)
  })

  it("requires a downloaded update and explicit confirmation before restarting", async () => {
    const f = fixture()
    let confirmations = 0
    f.setConfirm(async () => { confirmations++; return false })
    f.setSnapshot({ status: "available", installMode: "automatic" })
    await f.invoke("install")
    assert.equal(confirmations, 0)
    f.setSnapshot({ status: "downloaded", installMode: "automatic" })
    await f.invoke("install")
    assert.equal(confirmations, 1)
    assert.deepEqual(f.calls, [])
    f.setConfirm(async () => true)
    await f.invoke("install")
    assert.deepEqual(f.calls, ["install"])
  })

  it("coalesces repeated install clicks while the confirmation is open", async () => {
    const f = fixture()
    let answer
    let confirmations = 0
    f.setConfirm(() => { confirmations++; return new Promise(resolve => { answer = resolve }) })
    const first = f.invoke("install")
    const second = f.invoke("install")
    assert.equal(confirmations, 1)
    answer(true)
    await Promise.all([first, second])
    assert.deepEqual(f.calls, ["install"])
  })

  it("does not apply an old confirmation to a newer download", async () => {
    const f = fixture()
    let answer
    f.setSnapshot({ status: "downloaded", installMode: "automatic", latestVersion: "1.0.1" })
    f.setConfirm(() => new Promise(resolve => { answer = resolve }))
    const pending = f.invoke("install")
    f.setSnapshot({ status: "downloaded", installMode: "automatic", latestVersion: "1.0.2" })
    answer(true)
    assert.equal((await pending).latestVersion, "1.0.2")
    assert.deepEqual(f.calls, [])
  })

  it("opens a verified manual installer without promising an automatic restart", async () => {
    const f = fixture()
    f.setSnapshot({ status: "downloaded", installMode: "installer" })
    f.setConfirm(async () => { throw new Error("No restart confirmation for a manual installer") })
    await f.invoke("install")
    assert.deepEqual(f.calls, ["install"])
  })
})
