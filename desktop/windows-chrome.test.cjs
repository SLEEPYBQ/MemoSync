const { test } = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { titleBarColors, connectWindowTheme } = require("./windows-chrome.cjs")

test("titlebar colors follow the selected application theme", () => {
  assert.equal(titleBarColors(true).color, "#21201f")
  assert.equal(titleBarColors(false).color, "#ffffff")
  assert.equal(titleBarColors(true).height, 36)
})

test("only the main window frame can change its theme and the listener is disposed", () => {
  const ipcMain = new EventEmitter()
  const window = new EventEmitter()
  const applied = []
  window.webContents = { mainFrame: {} }
  window.setTitleBarOverlay = (value) => applied.push(value)
  connectWindowTheme(window, ipcMain)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  ipcMain.emit("memosync:window-theme", { ...event, sender: {} }, true)
  ipcMain.emit("memosync:window-theme", { ...event, senderFrame: {} }, true)
  ipcMain.emit("memosync:window-theme", event, "dark")
  assert.equal(applied.length, 0)
  ipcMain.emit("memosync:window-theme", event, true)
  assert.deepEqual(applied, [titleBarColors(true)])
  window.emit("closed")
  assert.equal(ipcMain.listenerCount("memosync:window-theme"), 0)
})
