const assert = require("node:assert/strict")
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { openUiPreferences } = require("./ui-preferences.cjs")

function profile(t) {
  const userData = mkdtempSync(path.join(os.tmpdir(), "memosync ui preferences-"))
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  return userData
}

test("only supported UI preferences survive reopening the desktop profile", (t) => {
  const userData = profile(t)
  const first = openUiPreferences(userData)
  assert.equal(first.get("memosync:sidebar-width"), null)
  first.set("memosync:sidebar-width", "375")
  first.set("memosync:memory-view", "board")
  first.set("memosync:dismissed-release", "0.46.0")
  first.set("memosync:last-open-external", "editor:cursor")

  first.set("memosync:sidebar-width", "999")
  first.set("memosync:memory-view", "project:synthetic")
  first.set("memosync:dismissed-release", "https://example.test")
  first.set("memosync:last-open-external", "editor:some-command")
  first.set("memosync_session", "synthetic")
  first.set("chat-input-drafts", "synthetic")

  const reopened = openUiPreferences(userData)
  assert.equal(reopened.get("memosync:sidebar-width"), "375")
  assert.equal(reopened.get("memosync:memory-view"), "board")
  assert.equal(reopened.get("memosync:dismissed-release"), "0.46.0")
  assert.equal(reopened.get("memosync:last-open-external"), "editor:cursor")
  assert.deepEqual(JSON.parse(readFileSync(path.join(userData, "ui-preferences.json"), "utf8")), {
    "memosync:sidebar-width": "375",
    "memosync:memory-view": "board",
    "memosync:dismissed-release": "0.46.0",
    "memosync:last-open-external": "editor:cursor",
  })
})

test("a malformed profile starts with defaults and can save a preference", (t) => {
  const userData = profile(t)
  writeFileSync(path.join(userData, "ui-preferences.json"), "{")
  const preferences = openUiPreferences(userData)
  assert.equal(preferences.get("memosync:memory-view"), null)
  preferences.set("memosync:memory-view", "graph")
  assert.equal(openUiPreferences(userData).get("memosync:memory-view"), "graph")
})
