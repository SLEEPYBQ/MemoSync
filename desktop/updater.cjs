const { createHash } = require("node:crypto")
const { createReadStream, existsSync } = require("node:fs")
const { mkdir, mkdtemp, open, rename, rm, rmdir } = require("node:fs/promises")
const path = require("node:path")

const REPOSITORY = "SLEEPYBQ/MemoSync"
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const ALLOWED_HOSTS = new Set(["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"])
const MAX_PACKAGE_SIZE = 4 * 1024 * 1024 * 1024

// The public tag request uses Node fetch; the native manifest request uses
// Chromium's network stack. Unknown failures (including TLS errors) fail closed.
const TEMPORARY_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_TIMED_OUT",
])

function isTemporaryLookupFailure(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.rateLimited === true || [408, 429].includes(error.statusCode) || (error.statusCode >= 500 && error.statusCode < 600)
  }
  return TEMPORARY_NETWORK_CODES.has(error?.cause?.code) || TEMPORARY_NETWORK_CODES.has(error?.code)
    || TEMPORARY_NETWORK_CODES.has(error?.message?.match(/^net::(ERR_[A-Z_]+)$/)?.[1])
    // builder-util-runtime uses plain errors for these two transport failures.
    || error?.message === "Request timed out" || error?.message === "Request has been aborted by the server"
}

function stableVersion(value) {
  return typeof value === "string" && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    ? value.replace(/^v/, "") : null
}

function isNewerVersion(current, latest) {
  const left = stableVersion(current)?.split(".").map(BigInt)
  const right = stableVersion(latest)?.split(".").map(BigInt)
  if (!left || !right) throw new Error("The release has an invalid stable version.")
  for (let index = 0; index < 3; index++) {
    if (right[index] !== left[index]) return right[index] > left[index]
  }
  return false
}

function getInstallMode({ isPackaged, platform, arch, env, execPath, exists = existsSync }) {
  if (!isPackaged || !(platform === "darwin" ? ["arm64", "x64"].includes(arch) : ["win32", "linux"].includes(platform) && arch === "x64")) {
    return "unsupported"
  }
  if (platform === "linux" && env.APPIMAGE) return "appimage"
  if (platform === "win32" && exists(path.win32.join(path.win32.dirname(execPath), "Uninstall MemoSync.exe"))) return "automatic"
  return "installer"
}

function installerName(version, platform, arch, mode) {
  if (platform === "darwin") return `MemoSync-${version}-macos-${arch}.dmg`
  if (platform === "win32") return `MemoSync-${version}-windows-${arch}-Setup.exe`
  return `MemoSync-${version}-linux-${arch}.${mode === "appimage" ? "AppImage" : "deb"}`
}

function parseRelease(body, { platform, arch, mode }) {
  if (!body || typeof body !== "object" || body.draft || body.prerelease) throw new Error("No stable desktop release is available.")
  const version = stableVersion(body.tag_name)
  if (!version) throw new Error("The release has an invalid stable version.")
  const base = `${RELEASES_URL}/download/${body.tag_name}/`
  const name = installerName(version, platform, arch, mode)
  const findAsset = (assetName) => {
    const matches = Array.isArray(body.assets) ? body.assets.filter(asset => asset?.name === assetName) : []
    const asset = matches[0]
    if (matches.length !== 1 || asset.browser_download_url !== `${base}${assetName}`
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE_SIZE) {
      throw new Error(`The release is missing a valid ${assetName} download.`)
    }
    return { name: assetName, url: asset.browser_download_url, size: asset.size }
  }
  return { version, releaseUrl: `${RELEASES_URL}/tag/${body.tag_name}`, asset: findAsset(name), checksums: findAsset("SHA256SUMS") }
}

function parseChecksum(text, filename) {
  const matching = text.split(/\r?\n/).map(line => /^([a-f\d]{64}) [ *](.+)$/i.exec(line))
    .filter(match => match && match[2] === filename)
  if (matching.length !== 1) throw new Error("The release does not contain a unique checksum for this installer.")
  return matching[0][1].toLowerCase()
}

async function hashFile(filename, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest(encoding)
}

async function readText(response, limit) {
  let bytes = 0
  const chunks = []
  if (!response.body) throw new Error("The update server returned an empty response.")
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > limit) throw new Error("The update server returned an unexpectedly large response.")
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

function parseNativeRelease(info, platform, arch, mode, tag) {
  const version = stableVersion(info?.version)
  if (!version || stableVersion(tag) !== version || (info.tag != null && info.tag !== tag)) {
    throw new Error("The update manifest does not match the stable release tag.")
  }
  const expected = installerName(version, platform, arch, mode)
  const names = platform === "win32"
    ? [expected, `MemoSync-${version}-windows-${arch}.zip`]
    : [expected, `MemoSync-${version}-linux-${arch}.deb`]
  // Only the checked platform asset from this repository's release is usable.
  const matches = Array.isArray(info.files) ? info.files.filter(file => file?.url === expected) : []
  const file = matches[0]
  if (matches.length !== 1 || info.files.some(file => !names.includes(file?.url)) || info.packages != null
    || typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
    || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_PACKAGE_SIZE
    || (info.path != null && !names.includes(info.path))) {
    throw new Error("The release contains unexpected desktop update files.")
  }
  return {
    version, releaseUrl: `${RELEASES_URL}/tag/${tag}`, sha512: file.sha512,
    asset: { name: expected, url: `${RELEASES_URL}/download/${tag}/${expected}`, size: file.size },
  }
}

/** Desktop-only updater. No renderer-provided paths, feeds, versions or commands. */
function createDesktopUpdater({
  app, shell, prepareInstall,
  platform = process.platform, arch = process.arch, env = process.env, execPath = process.execPath,
  exists = existsSync, fetch: fetchImpl = globalThis.fetch,
  getAutoUpdater = () => require("electron-updater").autoUpdater,
}) {
  const mode = getInstallMode({ isPackaged: app.isPackaged, platform, arch, env, execPath, exists })
  const usesManifest = mode === "automatic" || mode === "appimage"
  const listeners = new Set()
  let snapshot = Object.freeze({
    status: mode === "unsupported" ? "unsupported" : "idle",
    currentVersion: app.getVersion(), latestVersion: null, releaseUrl: null,
    progress: null, error: null, lastCheckedAt: null, installMode: mode,
  })
  let operation = null
  let disposed = false
  let release = null
  let downloaded = null
  let nativeUpdater
  let nativeCancellation
  let controller
  const nativeListeners = []
  const directory = path.join(app.getPath("userData"), "desktop-updates")

  function publish(patch) {
    if (disposed) return snapshot
    snapshot = Object.freeze({ ...snapshot, ...patch })
    for (const listener of listeners) listener(snapshot)
    return snapshot
  }

  function errorMessage(error) {
    if (error?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") return "The release is missing its update manifest."
    if (error?.code === "ERR_UPDATER_INVALID_UPDATE_INFO") return "The release has an invalid update manifest."
    if (Number.isInteger(error?.statusCode)) return `Could not download update information (HTTP ${error.statusCode}). Please try again.`
    return error instanceof Error ? error.message : String(error)
  }

  function fail(error) {
    return publish({ status: "error", error: errorMessage(error) })
  }

  function keepVerifiedDownload(error) {
    return publish({ status: "downloaded", progress: 100, error: errorMessage(error) })
  }

  function getNativeUpdater() {
    if (nativeUpdater) return nativeUpdater
    nativeUpdater = getAutoUpdater()
    nativeUpdater.autoDownload = false
    nativeUpdater.autoInstallOnAppQuit = false
    nativeUpdater.allowPrerelease = false
    nativeUpdater.allowDowngrade = false
    // Full downloads also work when upgrading from releases without blockmaps.
    nativeUpdater.disableDifferentialDownload = true
    nativeUpdater.disableWebInstaller = true
    const progress = ({ percent }) => {
      if (snapshot.status === "downloading" && Number.isFinite(percent)) publish({ progress: Math.max(0, Math.min(100, percent)) })
    }
    // check/download also reject their promises; only quitAndInstall reports
    // failures solely via the error event.
    const error = value => { if (snapshot.status === "installing") fail(value) }
    for (const pair of [["download-progress", progress], ["error", error]]) {
      nativeUpdater.on(...pair)
      nativeListeners.push(pair)
    }
    return nativeUpdater
  }

  async function request(url, signal, accept = "application/octet-stream") {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const parsed = new URL(url)
      if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
        throw new Error("The update server redirected outside GitHub.")
      }
      const response = await fetchImpl(url, {
        signal, redirect: "manual", headers: { Accept: accept, "User-Agent": `MemoSync/${snapshot.currentVersion}` },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location")
        await response.body?.cancel().catch(() => {})
        if (!location) throw new Error("The update server returned an invalid redirect.")
        url = new URL(location, url).href
        continue
      }
      if (!response.ok) {
        // Cleanup must not turn a definitive HTTP status into a socket error.
        await response.body?.cancel().catch(() => {})
        throw Object.assign(new Error(`Update request failed (HTTP ${response.status})`), {
          statusCode: response.status,
          // GitHub can return 403 (rather than 429) for exhausted API quotas.
          rateLimited: response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")),
        })
      }
      return response
    }
    throw new Error("The update server returned too many redirects.")
  }

  async function withSignal(timeout, callback) {
    controller = new AbortController()
    const active = controller
    const timer = setTimeout(() => active.abort(Object.assign(new Error("The update request timed out. Please try again."), { code: "ETIMEDOUT" })), timeout)
    timer.unref?.()
    try { return await callback(active.signal) }
    finally {
      clearTimeout(timer)
      if (controller === active) controller = null
    }
  }

  // Only one state-changing operation may run at a time. Repeated clicks share
  // its result, so checking cannot replace the version being downloaded.
  function run(callback) {
    if (disposed || mode === "unsupported") return Promise.resolve(snapshot)
    if (operation) return operation
    operation = Promise.resolve().then(callback).catch(fail).finally(() => { operation = null })
    return operation
  }

  function checkForUpdates() {
    if (snapshot.status === "installing") return Promise.resolve(snapshot)
    return run(async () => {
      publish({ status: "checking", error: null, progress: null })
      let body
      try {
        body = await withSignal(20_000, async signal => {
          // The public /latest endpoint serves the native tag without spending
          // a shared REST quota. Manual installers also need the API asset list.
          const response = usesManifest
            ? await request(`${RELEASES_URL}/latest`, signal, "application/json")
            : await request(LATEST_RELEASE_URL, signal, "application/vnd.github+json")
          return JSON.parse(await readText(response, 2 * 1024 * 1024))
        })
      } catch (error) {
        // A scheduled check while offline shouldn't strand a verified download.
        if (downloaded && isTemporaryLookupFailure(error)) return keepVerifiedDownload(error)
        release = null
        downloaded = null
        throw error
      }
      const previous = release
      const cached = downloaded
      release = null
      downloaded = null
      const version = stableVersion(body?.tag_name)
      if (!version || body.draft || body.prerelease) throw new Error("No stable desktop release is available.")
      const releaseUrl = `${RELEASES_URL}/tag/${body.tag_name}`
      const newer = isNewerVersion(snapshot.currentVersion, version)
      // Releases published before in-app updates have no updater manifests.
      // Current/older versions must not report a spurious missing-manifest error.
      if (newer && usesManifest) {
        // Bind the native provider to the one public tag we actually checked.
        // GitHubProvider repeats /latest and wraps both a reset and a 404 as
        // INVALID_RELEASE_FEED. GenericProvider reads the tagged manifest
        // directly and preserves the distinction. No caller supplies the URL.
        const native = getNativeUpdater()
        native.setFeedURL({ provider: "generic", url: `${RELEASES_URL}/download/${body.tag_name}/`, useMultipleRangeRequest: false })
        let result
        try { result = await native.checkForUpdates() }
        catch (error) {
          if (cached && previous.releaseUrl === releaseUrl && isTemporaryLookupFailure(error)) {
            release = previous
            downloaded = cached
            return keepVerifiedDownload(error)
          }
          throw error
        }
        const checked = parseNativeRelease(result?.updateInfo, platform, arch, mode, body.tag_name)
        if (result.isUpdateAvailable !== true) throw new Error("This update is not available for this system yet.")
        release = checked
        nativeCancellation = result.cancellationToken
      } else if (newer) {
        release = parseRelease(body, { platform, arch, mode })
      }
      if (cached && release && previous.version === release.version && previous.asset.url === release.asset.url
        && previous.asset.size === release.asset.size && previous.sha512 === release.sha512) downloaded = cached
      return publish({
        status: downloaded ? "downloaded" : release ? "available" : "up_to_date",
        progress: downloaded ? 100 : null, latestVersion: version,
        releaseUrl, lastCheckedAt: Date.now(), error: null,
      })
    })
  }

  function downloadUpdate() {
    if (snapshot.status === "installing") return Promise.resolve(snapshot)
    return run(async () => {
      if (downloaded) return publish({ status: "downloaded", error: null })
      if (!release) throw new Error("Check for a newer version before downloading an update.")
      publish({ status: "downloading", progress: 0, error: null })
      if (mode === "automatic") {
        await getNativeUpdater().downloadUpdate(nativeCancellation)
        downloaded = { native: true }
      } else {
        downloaded = await withSignal(30 * 60_000, async signal => {
          const { asset, checksums } = release
          const appImage = mode === "appimage"
          const algorithm = appImage ? "sha512" : "sha256"
          const encoding = appImage ? "base64" : "hex"
          let checksum = release.sha512
          let folder = directory
          if (appImage) {
            // 6.8.11's AppImageUpdater unlinks APPIMAGE before moving the
            // replacement and launches it before the old instance quits. Never
            // modify that path or run from a disposable updater cache.
            const downloads = app.getPath("downloads")
            await mkdir(downloads, { recursive: true })
            folder = await mkdtemp(path.join(downloads, `MemoSync-${release.version}-`))
          } else {
            const checksumResponse = await request(checksums.url, signal)
            checksum = parseChecksum(await readText(checksumResponse, 64 * 1024), asset.name)
            await rm(directory, { recursive: true, force: true })
            await mkdir(directory, { recursive: true, mode: 0o700 })
          }
          const filename = path.join(folder, asset.name)
          const partial = `${filename}.partial`
          let file
          try {
            const response = await request(asset.url, signal)
            if (!response.body) throw new Error("The update server returned an empty installer.")
            file = await open(partial, "wx", 0o600)
            const hash = createHash(algorithm)
            let received = 0
            let lastProgress = -1
            for await (const chunk of response.body) {
              signal.throwIfAborted()
              received += chunk.byteLength
              if (received > asset.size) throw new Error("The downloaded installer has an unexpected size.")
              hash.update(chunk)
              await file.writeFile(chunk)
              const progress = Math.floor(received * 100 / asset.size)
              if (progress !== lastProgress) { lastProgress = progress; publish({ progress }) }
            }
            if (received !== asset.size || hash.digest(encoding) !== checksum) throw new Error("The installer checksum did not match. Please download the update again.")
            if (appImage) await file.chmod(0o755)
            await file.close()
            file = null
            await rename(partial, filename)
            return { filename, checksum, algorithm, encoding }
          } catch (error) {
            await file?.close().catch(() => {})
            await rm(partial, { force: true }).catch(() => {})
            if (appImage) await rmdir(folder).catch(() => {}) // only if still empty
            throw error
          }
        })
      }
      return publish({ status: "downloaded", progress: 100, error: null })
    })
  }

  function installUpdate() {
    if (snapshot.status === "installing") return Promise.resolve(snapshot)
    return run(async () => {
      if (!downloaded) throw new Error("Download the update before installing it.")
      publish({ status: "installing", error: null })
      if (downloaded.native) {
        // The host must stop the Bun backend before the installer replaces files.
        await prepareInstall()
        if (!disposed) getNativeUpdater().quitAndInstall(false, true)
        return snapshot
      }
      let checksum
      try { checksum = await hashFile(downloaded.filename, downloaded.algorithm, downloaded.encoding) }
      catch { checksum = null }
      if (checksum !== downloaded.checksum) {
        downloaded = null
        publish({ progress: null })
        throw new Error("The installer checksum did not match. Please download the update again.")
      }
      // Opening only the folder avoids launching a second AppImage while the
      // current instance owns the lock. The old launcher remains usable.
      const error = await shell.openPath(mode === "appimage" ? path.dirname(downloaded.filename) : downloaded.filename)
      if (error) throw new Error(`Could not open the ${mode === "appimage" ? "download folder" : "installer"}: ${error}`)
      // The user owns the next step; keep the verified download available to reopen.
      return publish({ status: "downloaded", error: null })
    })
  }

  return {
    getSnapshot: () => snapshot,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    checkForUpdates, downloadUpdate, installUpdate,
    dispose() {
      disposed = true
      controller?.abort()
      nativeCancellation?.cancel()
      for (const pair of nativeListeners) nativeUpdater.removeListener(...pair)
      listeners.clear()
    },
  }
}

module.exports = { createDesktopUpdater, getInstallMode, installerName, isNewerVersion, parseChecksum, parseRelease }
