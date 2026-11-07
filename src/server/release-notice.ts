import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ReleaseNoticeSnapshot } from "../shared/types"
import { compareVersions } from "./cli-runtime"

// Notice only: MemoSync ships ad-hoc-signed DMGs, so it points people at the
// release page and never downloads or installs anything itself.
export const RELEASE_REPO = "SLEEPYBQ/MemoSync"
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`
const RELEASE_PAGE_PREFIX = `https://github.com/${RELEASE_REPO}/releases/`
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
// Tick often and let the cache decide, so a restart just before the cache
// expires still checks within about an hour of expiry, not a full interval later.
const TICK_MS = 60 * 60 * 1000
const CACHE_FILE_NAME = "release-check.json"
const FETCH_TIMEOUT_MS = 10_000
const VERSION_TAG = /^v?\d+(\.\d+){1,3}$/

export interface LatestRelease {
  version: string
  url: string
}

interface CacheFile {
  checkedAt: number
  latest: LatestRelease | null
}

export interface ReleaseNoticeDeps {
  currentVersion: string
  dataDir: string
  fetchLatestRelease?: () => Promise<LatestRelease | null>
  now?: () => number
}

export const EMPTY_RELEASE_NOTICE: ReleaseNoticeSnapshot = { latestVersion: null, releaseUrl: null }

export function parseLatestRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object") return null
  const release = body as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
  if (release.draft === true || release.prerelease === true) return null
  if (typeof release.tag_name !== "string" || !VERSION_TAG.test(release.tag_name.trim())) return null
  const tag = release.tag_name.trim()
  const htmlUrl = typeof release.html_url === "string" ? release.html_url : ""
  // Only ever link to this repository's release pages.
  const url = htmlUrl.startsWith(RELEASE_PAGE_PREFIX) ? htmlUrl : `${RELEASE_PAGE_PREFIX}tag/${encodeURIComponent(tag)}`
  return { version: tag.replace(/^v/i, ""), url }
}

export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "MemoSync" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`)
  return parseLatestRelease(await response.json())
}

export function toReleaseNotice(currentVersion: string, latest: LatestRelease | null): ReleaseNoticeSnapshot {
  if (!latest || compareVersions(currentVersion, latest.version) >= 0) return EMPTY_RELEASE_NOTICE
  return { latestVersion: latest.version, releaseUrl: latest.url }
}

export class ReleaseNotice {
  private readonly deps: Required<ReleaseNoticeDeps>
  private readonly listeners = new Set<(snapshot: ReleaseNoticeSnapshot) => void>()
  private snapshot: ReleaseNoticeSnapshot = EMPTY_RELEASE_NOTICE
  private timer: ReturnType<typeof setInterval> | null = null
  private checking: Promise<void> | null = null

  constructor(deps: ReleaseNoticeDeps) {
    this.deps = { fetchLatestRelease, now: Date.now, ...deps }
  }

  getSnapshot() {
    return this.snapshot
  }

  onChange(listener: (snapshot: ReleaseNoticeSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start() {
    void this.check()
    this.timer ??= setInterval(() => { void this.check() }, TICK_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Uses the on-disk result while it is fresh; any failure leaves the notice as it was. */
  check() {
    this.checking ??= this.runCheck().finally(() => { this.checking = null })
    return this.checking
  }

  private async runCheck() {
    const cached = await this.readCache()
    if (cached) this.publish(cached.latest)
    if (cached && this.deps.now() - cached.checkedAt < CHECK_INTERVAL_MS) return
    try {
      const latest = await this.deps.fetchLatestRelease()
      this.publish(latest)
      await this.writeCache({ checkedAt: this.deps.now(), latest })
    } catch {
      // Offline, rate-limited or GitHub down: stay quiet and try again later.
    }
  }

  private publish(latest: LatestRelease | null) {
    const next = toReleaseNotice(this.deps.currentVersion, latest)
    if (next.latestVersion === this.snapshot.latestVersion && next.releaseUrl === this.snapshot.releaseUrl) return
    this.snapshot = next
    for (const listener of this.listeners) listener(next)
  }

  private get cachePath() {
    return path.join(this.deps.dataDir, CACHE_FILE_NAME)
  }

  private async readCache(): Promise<CacheFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as Partial<CacheFile>
      if (typeof parsed.checkedAt !== "number") return null
      const latest = parsed.latest && typeof parsed.latest.version === "string" && typeof parsed.latest.url === "string"
        && parsed.latest.url.startsWith(RELEASE_PAGE_PREFIX)
        ? { version: parsed.latest.version, url: parsed.latest.url }
        : null
      return { checkedAt: parsed.checkedAt, latest }
    } catch {
      return null
    }
  }

  private async writeCache(cache: CacheFile) {
    try {
      await mkdir(this.deps.dataDir, { recursive: true })
      await writeFile(this.cachePath, `${JSON.stringify(cache)}\n`)
    } catch {
      // A cache we cannot write only means we check again next launch.
    }
  }
}
