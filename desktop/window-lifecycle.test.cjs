const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { test } = require("node:test")
const { installWindowLifecycle } = require("./window-lifecycle.cjs")

function prevented(target, name) {
  const event = new Event(name, { cancelable: true })
  target.emit(name, event)
  return event.defaultPrevented
}

function fixture() {
  const app = new EventEmitter()
  const owner = new EventEmitter()
  owner.webContents = new EventEmitter()
  owner.isDestroyed = () => false
  const actions = []
  owner.setEnabled = enabled => actions.push(enabled ? "enable" : "disable")
  app.quit = () => actions.push("quit")
  let answer = false
  let exited = false
  let release
  const lifecycle = installWindowLifecycle(app, {
    confirmDiscard(window) { assert.equal(window, owner); actions.push("ask"); return answer },
    stopBackend() {
      if (exited) return
      actions.push("stop")
      return new Promise(resolve => { release = () => { exited = true; resolve() } })
    },
  })
  lifecycle.guardWindow(owner)
  return { app, owner, actions, lifecycle, discard: () => { answer = true }, exit: () => release() }
}

test("a vetoed quit leaves the window and backend alone; discard lets the backend finish once", async () => {
  const f = fixture()
  assert.equal(prevented(f.app, "before-quit"), false)
  assert.equal(prevented(f.owner, "close"), false)
  assert.equal(prevented(f.owner.webContents, "will-prevent-unload"), false)
  assert.deepEqual(f.actions, ["ask"])
  assert.equal(f.lifecycle.quitting, false)

  f.discard()
  assert.equal(prevented(f.app, "before-quit"), false)
  assert.equal(prevented(f.owner.webContents, "will-prevent-unload"), true)
  assert.deepEqual(f.actions, ["ask", "ask"])
  assert.equal(prevented(f.app, "will-quit"), true)
  assert.equal(prevented(f.app, "will-quit"), true)
  assert.deepEqual(f.actions, ["ask", "ask", "stop"])
  f.exit()
  await Promise.resolve()
  assert.deepEqual(f.actions, ["ask", "ask", "stop", "quit"])
  assert.equal(prevented(f.app, "will-quit"), false)
})

test("closing just the window can discard without stopping a macOS background backend", () => {
  const f = fixture()
  f.discard()
  assert.equal(prevented(f.owner, "close"), false)
  assert.equal(prevented(f.owner.webContents, "will-prevent-unload"), true)
  assert.deepEqual(f.actions, ["ask"])
  assert.equal(f.lifecycle.quitting, false)
})

test("a failed automatic install preflight restores the editor and its discard guard", () => {
  const f = fixture()
  f.lifecycle.beginInstall(f.owner)
  assert.equal(prevented(f.owner, "close"), true)
  assert.equal(prevented(f.owner.webContents, "will-prevent-unload"), false)
  f.lifecycle.cancelInstall()
  assert.equal(prevented(f.owner, "close"), false)
  assert.equal(prevented(f.owner.webContents, "will-prevent-unload"), false)
  assert.deepEqual(f.actions, ["disable", "enable", "ask"])
  assert.equal(f.lifecycle.quitting, false)
})

test("an approved install can unload the locked editor without a second veto after shutdown", () => {
  const f = fixture()
  f.lifecycle.beginInstall(f.owner)
  f.lifecycle.finishInstall()
  assert.equal(prevented(f.owner, "close"), false)
  assert.equal(prevented(f.owner.webContents, "will-prevent-unload"), true)
  assert.deepEqual(f.actions, ["disable"])
})
