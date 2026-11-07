import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseLatestRelease, ReleaseNotice, toReleaseNotice, type LatestRelease } from "./release-notice"

const RELEASE_URL = "https://github.com/SLEEPYBQ/MemoSync/releases/tag/v0.44.0"
const LATEST: LatestRelease = { version: "0.44.0", url: RELEASE_URL }
const HOUR = 60 * 60 * 1000

describe("parseLatestRelease", () => {
  test("reads the version without its v prefix", () => {
    expect(parseLatestRelease({ tag_name: "v0.44.0", html_url: RELEASE_URL })).toEqual(LATEST)
  })

  test("ignores drafts, prereleases and tags that are not versions", () => {
    expect(parseLatestRelease({ tag_name: "v0.44.0", html_url: RELEASE_URL, draft: true })).toBeNull()
    expect(parseLatestRelease({ tag_name: "v0.44.0", html_url: RELEASE_URL, prerelease: true })).toBeNull()
    expect(parseLatestRelease({ tag_name: "nightly", html_url: RELEASE_URL })).toBeNull()
    expect(parseLatestRelease({ message: "Not Found" })).toBeNull()
    expect(parseLatestRelease(null)).toBeNull()
  })

  test("links only to this repository's release pages", () => {
    expect(parseLatestRelease({ tag_name: "v0.44.0", html_url: "https://example.com/download" })?.url).toBe(RELEASE_URL)
  })
})

describe("toReleaseNotice", () => {
  test("shows a strictly newer release", () => {
    expect(toReleaseNotice("0.43.1", LATEST)).toEqual({ latestVersion: "0.44.0", releaseUrl: RELEASE_URL })
    expect(toReleaseNotice("0.43.9", { version: "0.43.10", url: RELEASE_URL }).latestVersion).toBe("0.43.10")
  })

  test("stays empty when the app is current, ahead, or nothing is known", () => {
    expect(toReleaseNotice("0.44.0", LATEST).latestVersion).toBeNull()
    expect(toReleaseNotice("0.45.0", LATEST).latestVersion).toBeNull()
    expect(toReleaseNotice("0.43.1", null).latestVersion).toBeNull()
  })
})

describe("ReleaseNotice", () => {
  let dataDir: string | undefined

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  async function setup(options: { now: number | (() => number); fetch: () => Promise<LatestRelease | null>; cache?: unknown }) {
    dataDir = await mkdtemp(path.join(tmpdir(), "memosync-release-"))
    if (options.cache) await writeFile(path.join(dataDir, "release-check.json"), JSON.stringify(options.cache))
    let fetches = 0
    const notice = new ReleaseNotice({
      currentVersion: "0.43.1",
      dataDir,
      now: typeof options.now === "function" ? options.now : () => options.now as number,
      fetchLatestRelease: () => {
        fetches += 1
        return options.fetch()
      },
    })
    return { notice, fetches: () => fetches, dataDir }
  }

  test("checks GitHub, publishes the newer release and caches it", async () => {
    const { notice, fetches, dataDir } = await setup({ now: 10 * HOUR, fetch: async () => LATEST })
    const seen: Array<string | null> = []
    notice.onChange((snapshot) => seen.push(snapshot.latestVersion))
    await notice.check()
    expect(fetches()).toBe(1)
    expect(notice.getSnapshot()).toEqual({ latestVersion: "0.44.0", releaseUrl: RELEASE_URL })
    expect(seen).toEqual(["0.44.0"])
    expect(JSON.parse(await readFile(path.join(dataDir, "release-check.json"), "utf8"))).toEqual({ checkedAt: 10 * HOUR, latest: LATEST })
  })

  test("a fresh cache answers without touching the network", async () => {
    const { notice, fetches } = await setup({
      now: 10 * HOUR,
      fetch: async () => { throw new Error("should not fetch") },
      cache: { checkedAt: 9 * HOUR, latest: LATEST },
    })
    await notice.check()
    expect(fetches()).toBe(0)
    expect(notice.getSnapshot().latestVersion).toBe("0.44.0")
  })

  test("a restart just before the cache expires checks GitHub once it does", async () => {
    let now = 12 * HOUR - 60_000
    const { notice, fetches } = await setup({
      now: () => now,
      fetch: async () => ({ version: "0.45.0", url: RELEASE_URL }),
      cache: { checkedAt: 0, latest: LATEST },
    })
    await notice.check()
    expect(fetches()).toBe(0)
    expect(notice.getSnapshot().latestVersion).toBe("0.44.0")

    // The next hourly tick lands after expiry and picks up the newer release.
    now += HOUR
    await notice.check()
    expect(fetches()).toBe(1)
    expect(notice.getSnapshot().latestVersion).toBe("0.45.0")

    // Further ticks inside the fresh window stay off the network.
    now += HOUR
    await notice.check()
    expect(fetches()).toBe(1)
  })

  test("a failed check is silent and keeps the last known release", async () => {
    const { notice, fetches } = await setup({
      now: 30 * HOUR,
      fetch: async () => { throw new Error("rate limited") },
      cache: { checkedAt: 1 * HOUR, latest: LATEST },
    })
    await expect(notice.check()).resolves.toBeUndefined()
    expect(fetches()).toBe(1)
    expect(notice.getSnapshot().latestVersion).toBe("0.44.0")
  })

  test("ignores a cached link that points outside the release page", async () => {
    const { notice } = await setup({
      now: 10 * HOUR,
      fetch: async () => null,
      cache: { checkedAt: 9 * HOUR, latest: { version: "0.44.0", url: "https://example.com" } },
    })
    await notice.check()
    expect(notice.getSnapshot().latestVersion).toBeNull()
  })
})
