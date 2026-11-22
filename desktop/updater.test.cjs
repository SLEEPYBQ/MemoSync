const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { EventEmitter } = require("node:events")
const { mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { createDesktopUpdater, getInstallMode, installerName, isNewerVersion, parseChecksum, parseRelease, verifyAppImageDestination } = require("./updater.cjs")

const API_URL = "https://api.github.com/repos/SLEEPYBQ/MemoSync/releases/latest"
const BASE_URL = "https://github.com/SLEEPYBQ/MemoSync/releases/download/v0.47.0/"
const PACKAGE = Buffer.from("Synthetic installer fixture, not an executable")
const DIGEST = createHash("sha256").update(PACKAGE).digest("hex")

function releaseBody(platform = "darwin", arch = "arm64") {
  const name = installerName("0.47.0", platform, arch, "installer")
  return {
    tag_name: "v0.47.0", draft: false, prerelease: false,
    assets: [
      { name, browser_download_url: `${BASE_URL}${name}`, size: PACKAGE.length },
      { name: "SHA256SUMS", browser_download_url: `${BASE_URL}SHA256SUMS`, size: 150 },
    ],
  }
}

async function fixture(t, overrides = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "memosync-updater-"))
  const calls = []
  const opened = []
  const body = releaseBody(overrides.platform, overrides.arch)
  const app = { isPackaged: true, getVersion: () => "0.46.0", getPath: () => userData }
  const updater = createDesktopUpdater({
    app, platform: "darwin", arch: "arm64", env: {}, execPath: "/Applications/MemoSync.app/Contents/MacOS/MemoSync",
    prepareInstall: async () => { throw new Error("Manual installers must not stop the backend") },
    checkAppImage: async () => {},
    shell: { openPath: async filename => { opened.push(filename); return "" } },
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (url === API_URL) return Response.json(body)
      if (url === `${BASE_URL}SHA256SUMS`) return new Response(`${DIGEST}  ${body.assets[0].name}\n`)
      if (url === body.assets[0].browser_download_url) return new Response(PACKAGE)
      throw new Error(`Unexpected URL: ${url}`)
    },
    ...overrides,
  })
  t.after(async () => { updater.dispose(); await rm(userData, { recursive: true, force: true }) })
  return { updater, app, body, calls, opened, userData }
}

function nativeFixture() {
  const native = new EventEmitter()
  native.setFeedURL = options => { native.feed = options }
  const name = installerName("0.47.0", "linux", "x64", "automatic")
  native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.47.0", files: [{ url: name }] } })
  native.downloadUpdate = async () => ["synthetic.AppImage"]
  native.quitAndInstall = () => {}
  return native
}

test("stable versions compare numerically and never accept a prerelease or downgrade", () => {
  assert.equal(isNewerVersion("0.9.0", "v0.10.0"), true)
  assert.equal(isNewerVersion("1.0.0", "0.99.0"), false)
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false)
  for (const version of ["v1.2.3-beta.1", "1.2", "1.02.3", "../1.2.3", "1.2.3?download=1"]) {
    assert.throws(() => isNewerVersion("0.46.0", version), /invalid stable version/)
  }
})

test("selects native automatic updates only for installed NSIS and AppImage", () => {
  const base = { isPackaged: true, platform: "win32", arch: "x64", env: {}, execPath: "C:\\Apps\\MemoSync\\MemoSync.exe", exists: () => false }
  let inspected
  assert.equal(getInstallMode({ ...base, exists: filename => { inspected = filename; return true } }), "automatic")
  assert.equal(inspected, "C:\\Apps\\MemoSync\\Uninstall MemoSync.exe")
  assert.equal(getInstallMode(base), "installer")
  assert.equal(getInstallMode({ ...base, platform: "linux", env: { APPIMAGE: "/tmp/MemoSync.AppImage" } }), "automatic")
  assert.equal(getInstallMode({ ...base, platform: "linux" }), "installer")
  assert.equal(getInstallMode({ ...base, platform: "darwin", arch: "arm64" }), "installer")
  assert.equal(getInstallMode({ ...base, platform: "darwin", arch: "x64" }), "installer")
  for (const override of [{ isPackaged: false }, { arch: "arm64" }, { platform: "freebsd" }]) {
    assert.equal(getInstallMode({ ...base, ...override }), "unsupported")
  }
})

test("release selection is pinned to this repository and the running platform", () => {
  for (const [platform, arch, extension] of [["darwin", "arm64", "macos-arm64.dmg"], ["darwin", "x64", "macos-x64.dmg"], ["win32", "x64", "windows-x64-Setup.exe"], ["linux", "x64", "linux-x64.deb"]]) {
    const options = { platform, arch, mode: "installer" }
    const body = releaseBody(platform, arch)
    const parsed = parseRelease(body, options)
    assert.equal(parsed.asset.name, `MemoSync-0.47.0-${extension}`)
    assert.equal(parsed.releaseUrl, "https://github.com/SLEEPYBQ/MemoSync/releases/tag/v0.47.0")
    for (const change of [
      { draft: true }, { prerelease: true }, { tag_name: "v0.47.0-rc.1" }, { assets: [] },
      { assets: [{ ...body.assets[0], browser_download_url: "https://example.com/installer" }, body.assets[1]] },
      { assets: [{ ...body.assets[0], size: 0 }, body.assets[1]] },
      { assets: [body.assets[0], ...body.assets] },
    ]) assert.throws(() => parseRelease({ ...body, ...change }, options))
  }
})

test("checksums must identify exactly one matching installer", () => {
  assert.equal(parseChecksum(`${DIGEST}  other.exe\r\n${DIGEST} *app.dmg\r\n`, "app.dmg"), DIGEST)
  assert.throws(() => parseChecksum(`${DIGEST}  other.exe\n`, "app.dmg"), /unique checksum/)
  assert.throws(() => parseChecksum(`${DIGEST}  app.dmg\n${DIGEST}  app.dmg\n`, "app.dmg"), /unique checksum/)
})

test("development builds and unsupported architectures never fetch or load a native updater", async t => {
  for (const override of [{ app: { isPackaged: false, getVersion: () => "0.46.0", getPath: () => os.tmpdir() } }, { platform: "linux", arch: "arm64" }]) {
    const { updater, calls } = await fixture(t, { ...override, getAutoUpdater: () => { throw new Error("Should not load") } })
    assert.equal((await updater.checkForUpdates()).status, "unsupported")
    assert.equal((await updater.downloadUpdate()).status, "unsupported")
    assert.equal((await updater.installUpdate()).status, "unsupported")
    assert.deepEqual(calls, [])
  }
})

test("manual updates download in-app, report progress and only open after verification and explicit install", async t => {
  const { updater, opened, calls, body } = await fixture(t)
  const states = []
  const unsubscribe = updater.onChange(state => states.push(state))
  assert.equal((await updater.checkForUpdates()).status, "available")
  assert.equal(calls.length, 1)
  assert.deepEqual(opened, [])
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  assert.deepEqual(opened, [])
  assert.ok(states.some(state => state.status === "downloading" && state.progress === 100))
  assert.equal((await updater.installUpdate()).status, "downloaded")
  assert.equal(path.basename(opened[0]), body.assets[0].name)
  assert.deepEqual(await readFile(opened[0]), PACKAGE)
  assert.equal(calls.length, 3)
  assert.equal(calls.every(call => call.options.redirect === "manual"), true)
  unsubscribe()
})

test("corrupt or truncated installers cannot be opened, partials are removed, and downloading can be retried", async t => {
  const body = releaseBody()
  let corrupt = true
  const { updater, opened, userData } = await fixture(t, {
    fetch: async url => {
      if (url === API_URL) return Response.json(body)
      if (url.endsWith("SHA256SUMS")) return new Response(`${DIGEST}  ${body.assets[0].name}\n`)
      return new Response(corrupt ? Buffer.from("corrupt") : PACKAGE)
    },
  })
  await updater.checkForUpdates()
  assert.equal((await updater.downloadUpdate()).status, "error")
  assert.match(updater.getSnapshot().error, /checksum/)
  assert.deepEqual(await readdir(path.join(userData, "desktop-updates")), [])
  await updater.installUpdate()
  assert.deepEqual(opened, [])
  corrupt = false
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  await updater.installUpdate()
  assert.equal(opened.length, 1)
})

test("a verified installer changed or removed before opening must be downloaded again", async t => {
  const { updater, opened, userData, body } = await fixture(t)
  await updater.checkForUpdates()
  await updater.downloadUpdate()
  await writeFile(path.join(userData, "desktop-updates", body.assets[0].name), "tampered synthetic data")
  assert.equal((await updater.installUpdate()).status, "error")
  assert.match(updater.getSnapshot().error, /checksum/)
  assert.deepEqual(opened, [])
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  await rm(path.join(userData, "desktop-updates", body.assets[0].name))
  assert.equal((await updater.installUpdate()).status, "error")
  assert.deepEqual(opened, [])
})

test("installer launch errors are visible and opening can be retried without another download", async t => {
  let attempts = 0
  const { updater, calls } = await fixture(t, { shell: { openPath: async () => ++attempts === 1 ? "No associated application" : "" } })
  await updater.checkForUpdates()
  await updater.downloadUpdate()
  assert.equal((await updater.installUpdate()).status, "error")
  assert.match(updater.getSnapshot().error, /No associated application/)
  assert.equal((await updater.checkForUpdates()).status, "downloaded")
  assert.equal((await updater.installUpdate()).status, "downloaded")
  assert.equal(calls.length, 3)
  assert.equal(attempts, 2)
})

test("repeat checks share the operation instead of fetching twice", async t => {
  let finishCheck
  let requests = 0
  const body = releaseBody()
  const { updater } = await fixture(t, { fetch: async () => {
    requests++
    return new Promise(resolve => { finishCheck = () => resolve(Response.json(body)) })
  } })
  const first = updater.checkForUpdates()
  const second = updater.checkForUpdates()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(requests, 1)
  finishCheck()
  assert.equal((await first).status, "available")
})

test("older releases are never offered and do not require installer assets", async t => {
  const { updater } = await fixture(t, { fetch: async () => Response.json({ tag_name: "v0.45.0", assets: [] }) })
  assert.equal((await updater.checkForUpdates()).status, "up_to_date")
  assert.equal((await updater.downloadUpdate()).status, "error")
})

test("offline checks can be retried and redirects cannot leave GitHub", async t => {
  let attempt = 0
  const { updater } = await fixture(t, { fetch: async () => {
    if (++attempt === 1) throw new Error("Network unavailable")
    if (attempt === 2) return new Response(null, { status: 302, headers: { location: "https://example.com/installer.exe" } })
    return Response.json(releaseBody())
  } })
  assert.match((await updater.checkForUpdates()).error, /Network unavailable/)
  assert.match((await updater.checkForUpdates()).error, /outside GitHub/)
  assert.equal(attempt, 2)
  assert.equal((await updater.checkForUpdates()).status, "available")
})

test("native updater is configured for explicit stable updates and stops backend before installation", async t => {
  const native = nativeFixture()
  const actions = []
  native.downloadUpdate = async () => { actions.push("download"); native.emit("download-progress", { percent: 25 }); return ["synthetic.AppImage"] }
  native.quitAndInstall = (...args) => actions.push(["install", ...args])
  const { updater } = await fixture(t, {
    platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/MemoSync.AppImage" },
    getAutoUpdater: () => native, prepareInstall: async () => { actions.push("stop backend") },
  })
  const states = []
  updater.onChange(value => states.push(value))
  assert.equal((await updater.checkForUpdates()).status, "available")
  assert.equal(native.autoDownload, false)
  assert.equal(native.autoInstallOnAppQuit, false)
  assert.equal(native.allowPrerelease, false)
  assert.equal(native.allowDowngrade, false)
  assert.equal(native.disableWebInstaller, true)
  assert.deepEqual(native.feed, { provider: "github", owner: "SLEEPYBQ", repo: "MemoSync", releaseType: "release" })
  assert.deepEqual(actions, [])
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  assert.ok(states.some(state => state.progress === 25))
  assert.deepEqual(actions, ["download"])
  assert.equal((await updater.installUpdate()).status, "installing")
  assert.deepEqual(actions, ["download", "stop backend", ["install", false, true]])
  await updater.installUpdate()
  assert.equal(actions.length, 3)
})

test("native update metadata cannot introduce a foreign installer URL or prerelease", async t => {
  for (const info of [
    { version: "0.47.0-beta", files: [{ url: "MemoSync-0.47.0-linux-x64.AppImage" }] },
    { version: "0.47.0", files: [{ url: "https://example.com/installer.AppImage" }] },
    { version: "0.47.0", files: [{ url: "../../installer.AppImage" }] },
  ]) {
    const native = nativeFixture()
    native.checkForUpdates = async () => ({ updateInfo: info })
    native.downloadUpdate = async () => { assert.fail("Invalid metadata must never be downloaded") }
    const { updater } = await fixture(t, { platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/app" }, getAutoUpdater: () => native })
    assert.equal((await updater.checkForUpdates()).status, "error")
    assert.equal((await updater.downloadUpdate()).status, "error")
  }
})

test("failed native download or backend shutdown never invokes the installer", async t => {
  const native = nativeFixture()
  let failDownload = true
  let failShutdown = true
  let installed = 0
  native.downloadUpdate = async () => {
    if (failDownload) throw new Error("Network unavailable")
    return ["synthetic.AppImage"]
  }
  native.quitAndInstall = () => { installed++ }
  const { updater } = await fixture(t, {
    platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/app" }, getAutoUpdater: () => native,
    prepareInstall: async () => { if (failShutdown) throw new Error("Backend is still running") },
  })
  await updater.checkForUpdates()
  assert.equal((await updater.downloadUpdate()).status, "error")
  assert.equal((await updater.installUpdate()).status, "error")
  assert.equal(installed, 0)
  failDownload = false
  await updater.downloadUpdate()
  assert.match((await updater.installUpdate()).error, /still running/)
  assert.equal(installed, 0)
  failShutdown = false
  assert.equal((await updater.installUpdate()).status, "installing")
  assert.equal(installed, 1)
})

test("disposing cancels downloads and removes native event subscriptions", async t => {
  const native = nativeFixture()
  let cancelled = false
  const originalCheck = native.checkForUpdates
  native.checkForUpdates = async () => ({ ...await originalCheck(), cancellationToken: { cancel: () => { cancelled = true } } })
  const { updater } = await fixture(t, { platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/app" }, getAutoUpdater: () => native })
  await updater.checkForUpdates()
  assert.equal(native.listenerCount("download-progress"), 1)
  updater.dispose()
  assert.equal(cancelled, true)
  assert.equal(native.listenerCount("download-progress"), 0)
  assert.equal(native.listenerCount("error"), 0)
})

test("repeat downloads share a single download and checks cannot change its target", async t => {
  const native = nativeFixture()
  let finishDownload
  let downloads = 0
  native.downloadUpdate = () => { downloads++; return new Promise(resolve => { finishDownload = () => resolve(["synthetic.AppImage"]) }) }
  const { updater } = await fixture(t, { platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/app" }, getAutoUpdater: () => native })
  await updater.checkForUpdates()
  const first = updater.downloadUpdate()
  const second = updater.downloadUpdate()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(updater.checkForUpdates(), first)
  assert.equal(downloads, 1)
  finishDownload()
  assert.equal((await first).status, "downloaded")
})

test("automatic mode does not require manifests from already-current older releases", async t => {
  const { updater } = await fixture(t, {
    platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/app" },
    fetch: async () => Response.json({ tag_name: "v0.46.0" }),
    getAutoUpdater: () => { assert.fail("Current releases do not need a native manifest") },
  })
  assert.equal((await updater.checkForUpdates()).status, "up_to_date")
})

test("AppImage destination preflight fails before stopping the backend", async t => {
  const native = nativeFixture()
  const { updater } = await fixture(t, {
    platform: "linux", arch: "x64", env: { APPIMAGE: "/read-only/MemoSync.AppImage" }, getAutoUpdater: () => native,
    checkAppImage: async () => { throw new Error("Move the AppImage to a writable folder") },
    prepareInstall: async () => { assert.fail("A failed preflight must keep the backend running") },
  })
  await updater.checkForUpdates()
  await updater.downloadUpdate()
  assert.match((await updater.installUpdate()).error, /writable folder/)
})

test("AppImage destination preflight accepts a regular file and rejects missing or relative paths", async t => {
  const { userData } = await fixture(t)
  const filename = path.join(userData, "MemoSync.AppImage")
  await writeFile(filename, "Synthetic AppImage fixture")
  await verifyAppImageDestination(filename)
  await assert.rejects(verifyAppImageDestination("MemoSync.AppImage"), /invalid/)
  await assert.rejects(verifyAppImageDestination(path.join(userData, "missing")), /cannot be replaced/)
  await assert.rejects(verifyAppImageDestination(userData), /cannot be replaced/)
})
