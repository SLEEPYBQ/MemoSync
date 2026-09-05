import { describe, expect, test } from "bun:test"
import { landingHeadline, resolveLandingProjectPath, summarizeMemoriesForLanding } from "./landing"

describe("resolveLandingProjectPath", () => {
  test("keeps the picked project while it is still listed", () => {
    expect(resolveLandingProjectPath(["/a", "/b"], "/b")).toBe("/b")
  })

  test("falls back to the first project when the picked one disappears", () => {
    expect(resolveLandingProjectPath(["/a", "/b"], "/gone")).toBe("/a")
  })

  test("defaults to the first project when nothing is picked", () => {
    expect(resolveLandingProjectPath(["/a", "/b"], null)).toBe("/a")
  })

  test("returns null when there are no projects", () => {
    expect(resolveLandingProjectPath([], null)).toBeNull()
  })
})

describe("landingHeadline", () => {
  test("asks about the selected project by name", () => {
    expect(landingHeadline("my-project")).toBe("What should we build in my-project?")
  })

  test("invites adding a project when none exists", () => {
    expect(landingHeadline(null)).toBe("Add a project to get started")
  })
})

describe("summarizeMemoriesForLanding", () => {
  test("counts active memories by scope and candidates separately", () => {
    expect(
      summarizeMemoriesForLanding([
        { status: "active", scope: "personal" },
        { status: "active", scope: "personal" },
        { status: "active", scope: "project" },
        { status: "active", scope: "session" },
        { status: "candidate", scope: "personal" },
        { status: "candidate", scope: "project" },
        { status: "archived", scope: "personal" },
      ])
    ).toEqual({
      active: 4,
      candidates: 2,
      byScope: { personal: 2, project: 1, session: 1 },
    })
  })

  test("buckets unknown scopes as session, mirroring the panels", () => {
    expect(summarizeMemoriesForLanding([{ status: "active", scope: "weird" }])).toEqual({
      active: 1,
      candidates: 0,
      byScope: { personal: 0, project: 0, session: 1 },
    })
  })
})
