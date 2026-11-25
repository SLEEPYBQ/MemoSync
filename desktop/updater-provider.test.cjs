// Exercise the locked provider against synthetic release responses. No real
// network, Electron profile, signature tool, executable or installer is used.
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises")
const { createRequire } = require("node:module")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { AppImageUpdater, NsisUpdater } = require("electron-updater")
const { HttpError } = createRequire(require.resolve("electron-updater"))("builder-util-runtime")
const { createDesktopUpdater } = require("./updater.cjs")

for (const platform of ["win32", "linux"]) test(`locked ${platform} provider: stable feed, digest and handoff`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memosync provider fixture-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const linux = platform === "linux"
  const old = path.join(root, linux ? "Original launcher.AppImage" : "MemoSync.exe")
  await writeFile(old, "synthetic old launcher; never execute")
  const file = linux ? "MemoSync-1.0.1-linux-x64.AppImage" : "MemoSync-1.0.1-windows-x64-Setup.exe"
  const bytes = Buffer.from("synthetic new package; never execute")
  const sha512 = createHash("sha512").update(bytes).digest("base64")
  const base = "https://github.com/SLEEPYBQ/MemoSync/releases"
  const asset = `${base}/download/v1.0.1/${file}`
  const info = { version: "1.0.1", files: [{ url: file, sha512, size: bytes.length }], path: file, sha512 }
  const feed = linux ? "latest-linux.yml" : "latest.yml"
  const env = linux ? { APPIMAGE: old } : {}
  for (const [key, value] of Object.entries({ ...env, TEST_UPDATER_ARCH: "x64" })) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const config = path.join(root, "app-update.yml")
  await writeFile(config, "updaterCacheDirName: synthetic-cache\npublisherName: Synthetic Publisher\n")
  const native = new (linux ? AppImageUpdater : NsisUpdater)(null, {
    version: "1.0.0", isPackaged: true, whenReady: async () => {},
    userDataPath: root, baseCachePath: root, appUpdateConfigPath: config,
  })
  native.logger = null
  native._testOnlyOptions = { platform }
  const requests = []
  const handoff = []
  let manifestError
  let providerError
  native.on("error", error => { providerError = error.code })
  native.httpExecutor = {
    async request({ protocol, hostname, path: pathname }) {
      // GenericProvider adds a noCache query to channel files, not to assets.
      const parsed = new URL(`${protocol}//${hostname}${pathname}`)
      const url = parsed.origin + parsed.pathname
      requests.push(url)
      assert.equal(url, `${base}/download/v1.0.1/${feed}`)
      if (manifestError) throw manifestError
      return JSON.stringify(info) // JSON is also valid YAML
    },
    async download(url, filename, options) {
      assert.equal(linux, false)
      assert.equal(url.href, asset)
      assert.equal(options.sha512, sha512)
      await writeFile(filename, bytes)
    },
  }
  native.verifyUpdateCodeSignature = async (names, filename) => {
    assert.deepEqual(names, ["Synthetic Publisher"])
    assert.deepEqual(await readFile(filename), bytes)
    handoff.push("publisher check")
    return null
  }
  native.quitAndInstall = (silent, runAfter) => {
    assert.equal(linux, false, "must not call the AppImage unlink/move/launch implementation")
    assert.deepEqual([silent, runAfter], [false, true])
    // Use the actual NSIS command builder but never spawn or quit anything.
    native.spawnLog = async (exe, args) => {
      assert.equal(exe, path.join(root, "synthetic-cache", "pending", file))
      handoff.push(args)
    }
    assert.equal(native.doInstall({ isSilent: silent, isForceRunAfter: runAfter }), true)
  }
  const updater = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "1.0.0", getPath: name => name === "downloads" ? path.join(root, "Downloads") : root },
    platform, arch: "x64", env, execPath: old, exists: filename => path.win32.basename(filename) === "Uninstall MemoSync.exe",
    getAutoUpdater: () => native, prepareInstall: async () => { handoff.push("stop backend") },
    shell: { openPath: async dir => {
      assert.equal(linux, true)
      assert.equal(path.dirname(dir), path.join(root, "Downloads"))
      assert.deepEqual(await readdir(dir), [file])
      assert.deepEqual(await readFile(path.join(dir, file)), bytes)
      handoff.push("opened folder only")
      return ""
    } },
    fetch: async (url, options) => {
      if (url === `${base}/latest`) {
        requests.push(url)
        assert.equal(options.headers.Accept, "application/json")
        return Response.json({ tag_name: "v1.0.1" })
      }
      assert.ok(linux && url === asset)
      return new Response(bytes)
    },
  })
  t.after(() => updater.dispose())
  assert.equal((await updater.checkForUpdates()).status, "available")
  assert.deepEqual(requests, [`${base}/latest`, `${base}/download/v1.0.1/${feed}`])
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  // The public lookup still sees the same tag. Exercise the locked provider's
  // real error propagation for the two different tagged-manifest outcomes.
  manifestError = Object.assign(new Error("Synthetic connection reset"), { code: "ECONNRESET" })
  const offline = await updater.checkForUpdates()
  assert.equal(providerError, "ECONNRESET")
  assert.equal(offline.status, "downloaded")
  assert.equal(offline.latestVersion, "1.0.1")
  assert.match(offline.error, /connection reset/i)
  manifestError = new HttpError(404)
  const missing = await updater.checkForUpdates()
  assert.equal(providerError, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")
  assert.equal(missing.status, "error", "404 is not a connectivity loss")
  assert.equal(missing.error, "The release is missing its update manifest.")
  assert.match((await updater.installUpdate()).error, /Download the update/)
  assert.match((await updater.downloadUpdate()).error, /Check for a newer version/)
  manifestError = null
  assert.equal((await updater.checkForUpdates()).status, "available")
  assert.equal((await updater.downloadUpdate()).status, "downloaded")
  assert.equal((await updater.installUpdate()).status, linux ? "downloaded" : "installing")
  assert.deepEqual(handoff, linux ? ["opened folder only"] : ["publisher check", "stop backend", ["--updated", "--force-run"]])
  assert.equal(await readFile(old, "utf8"), "synthetic old launcher; never execute")
})
