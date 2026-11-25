const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { EventEmitter } = require("node:events")
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { createDesktopUpdater, getInstallMode, installerName, isNewerVersion, parseChecksum, parseRelease } = require("./updater.cjs")

const API_URL = "https://api.github.com/repos/SLEEPYBQ/MemoSync/releases/latest"
const WEB_URL = "https://github.com/SLEEPYBQ/MemoSync/releases/latest"
const BASE_URL = "https://github.com/SLEEPYBQ/MemoSync/releases/download/v0.47.0/"
const PACKAGE = Buffer.from("Synthetic installer fixture, not an executable")
const DIGEST = createHash("sha256").update(PACKAGE).digest("hex")
const SHA512 = createHash("sha512").update(PACKAGE).digest("base64")
const WINDOWS = { platform: "win32", arch: "x64", execPath: "C:\\Synthetic\\MemoSync.exe", exists: () => true }

function releaseBody(platform = "darwin", arch = "arm64", mode = "installer", version = "0.47.0") {
  const name = installerName(version, platform, arch, mode)
  const base = `https://github.com/SLEEPYBQ/MemoSync/releases/download/v${version}/`
  return {
    tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [
      { name, browser_download_url: `${base}${name}`, size: PACKAGE.length },
      { name: "SHA256SUMS", browser_download_url: `${base}SHA256SUMS`, size: 150 },
    ],
  }
}

async function fixture(t, overrides = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "memosync-updater-"))
  const calls = []
  const opened = []
  const body = releaseBody(overrides.platform, overrides.arch, overrides.env?.APPIMAGE ? "appimage" : "installer")
  const app = { isPackaged: true, getVersion: () => "0.46.0", getPath: name => name === "downloads" ? path.join(userData, "Downloads") : userData }
  const updater = createDesktopUpdater({
    app, platform: "darwin", arch: "arm64", env: {}, execPath: "/Applications/MemoSync.app/Contents/MacOS/MemoSync",
    prepareInstall: async () => { throw new Error("Manual installers must not stop the backend") },
    shell: { openPath: async filename => { opened.push(filename); return "" } },
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (url === API_URL) return Response.json(body)
      if (url === WEB_URL) return Response.json({ tag_name: body.tag_name })
      if (url === `${BASE_URL}SHA256SUMS`) return new Response(`${DIGEST}  ${body.assets[0].name}\n`)
      if (url === body.assets[0].browser_download_url) return new Response(PACKAGE)
      throw new Error(`Unexpected URL: ${url}`)
    },
    ...overrides,
  })
  t.after(async () => { updater.dispose(); await rm(userData, { recursive: true, force: true }) })
  return { updater, app, body, calls, opened, userData }
}

function nativeInfo(platform = "win32", version = "0.47.0") {
  const name = installerName(version, platform, "x64", platform === "linux" ? "appimage" : "automatic")
  return { version, tag: `v${version}`, files: [{ url: name, size: PACKAGE.length, sha512: SHA512 }] }
}

function nativeFixture(platform = "win32") {
  const native = new EventEmitter()
  native.setFeedURL = options => { native.feed = options }
  native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: nativeInfo(platform) })
  native.downloadUpdate = async () => ["synthetic-Setup.exe"]
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

test("selects automatic installation only for installed NSIS and a separate download for AppImage", () => {
  const base = { isPackaged: true, platform: "win32", arch: "x64", env: {}, execPath: "C:\\Apps\\MemoSync\\MemoSync.exe", exists: () => false }
  let inspected
  assert.equal(getInstallMode({ ...base, exists: filename => { inspected = filename; return true } }), "automatic")
  assert.equal(inspected, "C:\\Apps\\MemoSync\\Uninstall MemoSync.exe")
  assert.equal(getInstallMode(base), "installer")
  assert.equal(getInstallMode({ ...base, platform: "linux", env: { APPIMAGE: "/tmp/MemoSync.AppImage" } }), "appimage")
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
  assert.equal(calls.length, 4) // includes the fresh tag check, not a second package download
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

test("installed NSIS uses the public tag and native provider, never the shared REST quota", async t => {
  const native = nativeFixture()
  const actions = []
  native.downloadUpdate = async () => { actions.push("download"); native.emit("download-progress", { percent: 25 }); return ["synthetic-Setup.exe"] }
  native.quitAndInstall = (...args) => actions.push(["install", ...args])
  const { updater, calls } = await fixture(t, {
    ...WINDOWS,
    getAutoUpdater: () => native, prepareInstall: async () => { actions.push("stop backend") },
  })
  const states = []
  updater.onChange(value => states.push(value))
  assert.equal((await updater.checkForUpdates()).status, "available")
  assert.deepEqual(calls.map(({ url, options }) => [url, options.headers.Accept]), [[WEB_URL, "application/json"]])
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

test("invalid native release paths, tags, sizes and digests cannot be downloaded", async t => {
  const file = nativeInfo("linux").files[0]
  for (const info of [
    { version: "0.47.0-beta", files: [{ url: "MemoSync-0.47.0-linux-x64.AppImage" }] },
    { version: "0.47.0", files: [{ url: "https://example.com/installer.AppImage" }] },
    { version: "0.47.0", files: [{ url: "../../installer.AppImage" }] },
    { ...nativeInfo("linux"), tag: "v0.46.0" },
    { ...nativeInfo("linux"), files: [file, file] },
    { ...nativeInfo("linux"), files: [{ ...file, sha512: "" }] },
    { ...nativeInfo("linux"), files: [{ ...file, size: -1 }] },
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
    return ["synthetic-Setup.exe"]
  }
  native.quitAndInstall = () => { installed++ }
  const { updater } = await fixture(t, {
    ...WINDOWS, getAutoUpdater: () => native,
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
  const { updater } = await fixture(t, { ...WINDOWS, getAutoUpdater: () => native })
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
  native.downloadUpdate = () => { downloads++; return new Promise(resolve => { finishDownload = () => resolve(["synthetic-Setup.exe"]) }) }
  const { updater } = await fixture(t, { ...WINDOWS, getAutoUpdater: () => native })
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
    fetch: async url => { assert.equal(url, WEB_URL); return Response.json({ tag_name: "v0.46.0" }) },
    getAutoUpdater: () => { assert.fail("Current releases do not need a native manifest") },
  })
  assert.equal((await updater.checkForUpdates()).status, "up_to_date")
})

test("AppImage failure and success leave the running launcher and data alone; only its new folder is opened", async t => {
  const drive = await mkdtemp(path.join(os.tmpdir(), "synthetic removable drive-"))
  t.after(() => rm(drive, { recursive: true, force: true }))
  const old = path.join(drive, "my renamed MemoSync.AppImage")
  const data = path.join(drive, "synthetic-work.txt")
  await writeFile(old, "original synthetic launcher")
  await writeFile(data, "unchanged synthetic work")
  const native = nativeFixture("linux")
  let nativeInstalls = 0
  native.quitAndInstall = () => { nativeInstalls++ }
  native.downloadUpdate = () => { throw Error("Do not stage an AppImage in the updater's expiring cache") }
  let bytes = Buffer.alloc(PACKAGE.length) // same length, wrong manifest SHA512
  const name = nativeInfo("linux").files[0].url
  const { updater, app, opened } = await fixture(t, {
    platform: "linux", arch: "x64", env: { APPIMAGE: old }, getAutoUpdater: () => native,
    fetch: async url => {
      if (url === WEB_URL) return Response.json({ tag_name: "v0.47.0" })
      assert.equal(url, `${BASE_URL}${name}`)
      return new Response(bytes)
    },
  })
  const downloads = app.getPath("downloads")
  assert.equal((await updater.checkForUpdates()).installMode, "appimage")
  assert.match((await updater.downloadUpdate()).error, /checksum/)
  assert.deepEqual(await readdir(downloads), [])
  assert.deepEqual(opened, [])
  bytes = PACKAGE
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  assert.equal((await updater.installUpdate()).status, "downloaded")
  const [folder] = opened
  assert.equal(path.dirname(folder), downloads)
  assert.deepEqual(await readdir(folder), [name])
  const copy = path.join(folder, name)
  assert.deepEqual(await readFile(copy), PACKAGE)
  if (process.platform !== "win32") assert.ok((await stat(copy)).mode & 0o100)
  await writeFile(copy, "modified synthetic download")
  assert.match((await updater.installUpdate()).error, /checksum/)
  assert.equal(opened.length, 1)
  assert.equal(nativeInstalls, 0)
  assert.deepEqual((await readdir(drive)).sort(), [path.basename(old), path.basename(data)].sort())
  assert.equal(await readFile(old, "utf8"), "original synthetic launcher")
  assert.equal(await readFile(data, "utf8"), "unchanged synthetic work")
})

test("temporary provider failure preserves the verified target, but withdrawing rollout eligibility does not", async t => {
  const native = nativeFixture()
  const { updater } = await fixture(t, { ...WINDOWS, getAutoUpdater: () => native })
  await updater.checkForUpdates()
  await updater.downloadUpdate()
  native.checkForUpdates = async () => { throw Object.assign(new Error("Socket closed"), { code: "ECONNRESET" }) }
  assert.equal((await updater.checkForUpdates()).status, "downloaded")
  assert.match(updater.getSnapshot().error, /Socket closed/)
  native.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: nativeInfo() })
  assert.match((await updater.checkForUpdates()).error, /not available for this system/)
  assert.match((await updater.installUpdate()).error, /Download the update/)
})

test("failed checks never revive a different tag or a download whose manifest is known invalid", async t => {
  for (const [tag, code] of [
    ["v0.48.0", "ERR_UPDATER_INVALID_RELEASE_FEED"],
    ["v0.47.0", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"],
    ["v0.47.0", "ERR_UPDATER_INVALID_UPDATE_INFO"],
  ]) {
    const native = nativeFixture()
    let publicTag = "v0.47.0"
    const { updater } = await fixture(t, {
      ...WINDOWS, getAutoUpdater: () => native,
      fetch: async url => { assert.equal(url, WEB_URL); return Response.json({ tag_name: publicTag }) },
    })
    await updater.checkForUpdates()
    assert.equal((await updater.downloadUpdate()).status, "downloaded")
    publicTag = tag
    native.checkForUpdates = async () => { throw Object.assign(new Error("Synthetic provider failure"), { code }) }
    assert.equal((await updater.checkForUpdates()).status, "error")
    assert.match((await updater.installUpdate()).error, /Download the update/)
  }
})

test("rechecks preserve the same verified download but never offer a superseded or withdrawn installer", async t => {
  for (const automatic of [false, true]) {
    let version = "0.47.0"
    let downloads = 0
    let installations = 0
    let offline = false
    const native = nativeFixture()
    native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: nativeInfo("win32", version) })
    native.downloadUpdate = async () => { downloads++; return ["synthetic-Setup.exe"] }
    native.quitAndInstall = () => { installations++ }
    const { updater, opened } = await fixture(t, {
      ...(automatic ? WINDOWS : {}), getAutoUpdater: () => native,
      fetch: async url => {
        if (offline) throw new Error("Network unavailable")
        const body = releaseBody("darwin", "arm64", "installer", version)
        if (url === WEB_URL && automatic) return Response.json({ tag_name: body.tag_name })
        if (url === API_URL && !automatic) return Response.json(body)
        if (url === body.assets[1].browser_download_url) return new Response(`${DIGEST}  ${body.assets[0].name}\n`)
        assert.equal(url, body.assets[0].browser_download_url)
        downloads++
        return new Response(PACKAGE)
      },
    })
    assert.equal((await updater.checkForUpdates()).status, "available")
    assert.equal((await updater.downloadUpdate()).status, "downloaded")
    offline = true
    const cached = await updater.checkForUpdates()
    assert.equal(cached.status, "downloaded")
    assert.match(cached.error, /Network unavailable/)
    offline = false
    assert.equal((await updater.checkForUpdates()).status, "downloaded")
    version = "0.48.0"
    const newer = await updater.checkForUpdates()
    assert.equal(newer.status, "available")
    assert.equal(newer.latestVersion, version)
    assert.match((await updater.installUpdate()).error, /Download the update/)
    assert.equal(downloads, 1)
    assert.equal((await updater.downloadUpdate()).status, "downloaded")
    version = "0.46.0" // the newer release was withdrawn
    assert.equal((await updater.checkForUpdates()).status, "up_to_date")
    assert.match((await updater.installUpdate()).error, /Download the update/)
    assert.equal(downloads, 2)
    assert.deepEqual(opened, [])
    assert.equal(installations, 0)
  }
})
