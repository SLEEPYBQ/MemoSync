const { describe, it } = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { trackBackendProcess } = require("./backend-lifecycle.cjs")
const { isAppUrl, isExternalUrl, parseReadyLine } = require("./policy.cjs")

describe("desktop backend process lifecycle", () => {
  it("releases shutdown wait when the runtime cannot be spawned", async () => {
    const child = new EventEmitter()
    const lifecycle = trackBackendProcess(child)
    child.emit("error", Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" }))
    assert.equal(await Promise.race([
      lifecycle.waitForStop().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]), true)
    assert.equal(lifecycle.stopped, true)
  })
})

describe("desktop navigation boundary", () => {
  const origin = "http://127.0.0.1:43210"
  it("allows application routes but not other origins or credential-bearing URLs", () => {
    assert.equal(isAppUrl(`${origin}/project/one`, origin), true)
    for (const url of ["http://127.0.0.1:43211", "http://localhost:43210", "https://example.com", "file:///etc/passwd", "http://user@127.0.0.1:43210"]) {
      assert.equal(isAppUrl(url, origin), false)
    }
  })
  it("only offers plain web links to the external browser", () => {
    assert.equal(isExternalUrl("https://example.com/docs"), true)
    assert.equal(isExternalUrl("http://localhost:3000"), true)
    for (const url of ["javascript:alert(1)", "file:///tmp/test", "vscode://file/test", "https://user:password@example.com", "not a URL"]) {
      assert.equal(isExternalUrl(url), false)
    }
  })
})

describe("desktop backend readiness", () => {
  it("ignores ordinary logs and validates the bound loopback port", () => {
    assert.equal(parseReadyLine("[memosync] starting"), null)
    assert.equal(parseReadyLine('MEMOSYNC_DESKTOP_READY:{"port":43210}'), "http://127.0.0.1:43210")
    for (const port of [0, -1, 65536, "3210", 1.5, null]) {
      assert.throws(() => parseReadyLine(`MEMOSYNC_DESKTOP_READY:${JSON.stringify({ port })}`))
    }
  })
})
