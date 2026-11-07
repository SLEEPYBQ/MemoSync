import { describe, expect, test } from "bun:test"
import { getReleaseNotice } from "./releaseNotice"

const URL = "https://github.com/SLEEPYBQ/MemoSync/releases/tag/v0.44.0"

describe("getReleaseNotice", () => {
  test("hidden until the server reports a newer release", () => {
    expect(getReleaseNotice(null)).toBeNull()
    expect(getReleaseNotice({ latestVersion: null, releaseUrl: null })).toBeNull()
  })

  test("points at the release page of a newer version", () => {
    expect(getReleaseNotice({ latestVersion: "0.44.0", releaseUrl: URL })).toEqual({ version: "0.44.0", url: URL })
  })

  test("a dismissed version stays hidden", () => {
    expect(getReleaseNotice({ latestVersion: "0.44.0", releaseUrl: URL }, "0.44.0")).toBeNull()
  })

  test("dismissing one version does not hide the next", () => {
    expect(getReleaseNotice({ latestVersion: "0.45.0", releaseUrl: URL }, "0.44.0")?.version).toBe("0.45.0")
  })
})
