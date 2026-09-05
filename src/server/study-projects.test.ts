import { describe, expect, test } from "bun:test"
import { parseStudyProjects, registerStudyProjects, resolveRegisteredStudyProjects } from "./study-projects"

describe("parseStudyProjects", () => {
  test("returns [] for undefined/empty", () => {
    expect(parseStudyProjects(undefined)).toEqual([])
    expect(parseStudyProjects("")).toEqual([])
    expect(parseStudyProjects("   ")).toEqual([])
  })

  test("parses a valid JSON array of {localPath,title}", () => {
    const specs = parseStudyProjects(
      JSON.stringify([
        { localPath: "/workspace/C", title: "Warm-up" },
        { localPath: "/workspace/A", title: "Aurora CLI" },
      ]),
    )
    expect(specs).toEqual([
      { localPath: "/workspace/C", title: "Warm-up" },
      { localPath: "/workspace/A", title: "Aurora CLI" },
    ])
  })

  test("title defaults to the path basename when omitted", () => {
    const specs = parseStudyProjects(JSON.stringify([{ localPath: "/workspace/proj-A" }]))
    expect(specs[0]).toEqual({ localPath: "/workspace/proj-A", title: "proj-A" })
  })

  test("skips entries with no usable localPath, keeps the rest", () => {
    const specs = parseStudyProjects(
      JSON.stringify([{ title: "no path" }, { localPath: "  " }, { localPath: "/workspace/A", title: "A" }]),
    )
    expect(specs).toEqual([{ localPath: "/workspace/A", title: "A" }])
  })

  test("throws on non-array / malformed JSON so a misconfig fails loudly at boot", () => {
    expect(() => parseStudyProjects("not json")).toThrow()
    expect(() => parseStudyProjects(JSON.stringify({ localPath: "/x" }))).toThrow(/array/i)
  })

  test("throws on duplicate localPaths so two study projects can't merge into one (bug #2)", () => {
    const raw = JSON.stringify([
      { localPath: "/workspace/A", title: "A" },
      { localPath: "/workspace/A", title: "A-dup" },
    ])
    expect(() => parseStudyProjects(raw)).toThrow(/duplicate/i)
  })
})

describe("registerStudyProjects", () => {
  test("calls openProject once per spec, in order, and returns the projects", async () => {
    const calls: Array<{ localPath: string; title?: string }> = []
    const store = {
      openProject: async (localPath: string, title?: string) => {
        calls.push({ localPath, title })
        return { id: `id-${localPath}`, localPath, title: title ?? "" }
      },
    }
    const specs = [
      { localPath: "/workspace/C", title: "Warm-up" },
      { localPath: "/workspace/A", title: "Aurora CLI" },
    ]
    const projects = await registerStudyProjects(store, specs)
    expect(calls).toEqual([
      { localPath: "/workspace/C", title: "Warm-up" },
      { localPath: "/workspace/A", title: "Aurora CLI" },
    ])
    expect(projects.map((p) => p.id)).toEqual(["id-/workspace/C", "id-/workspace/A"])
  })

  test("is a no-op for an empty spec list", async () => {
    let called = false
    const store = {
      openProject: async () => {
        called = true
        return { id: "x", localPath: "x", title: "" }
      },
    }
    expect(await registerStudyProjects(store, [])).toEqual([])
    expect(called).toBe(false)
  })
})

describe("resolveRegisteredStudyProjects", () => {
  test("pins task slugs to the exact trusted registration identity and path", () => {
    const specs = [
      { localPath: "/workspace/apartment", title: "Apartment rentals" },
      { localPath: "/workspace/car", title: "Car rentals" },
    ]
    const registered = [
      { id: "project-apartment", localPath: "/workspace/apartment", title: "Apartment rentals" },
      { id: "project-car", localPath: "/workspace/car", title: "Car rentals" },
    ]

    expect(resolveRegisteredStudyProjects(specs, registered, (slug) => slug === "apartment")).toEqual(new Map([
      ["apartment", {
        projectId: "project-apartment",
        localPath: "/workspace/apartment",
        title: "Apartment rentals",
        starterReady: true,
      }],
      ["car", {
        projectId: "project-car",
        localPath: "/workspace/car",
        title: "Car rentals",
        starterReady: false,
      }],
    ]))
  })

  test("fails closed when registration returns a different path or duplicate slug", () => {
    expect(() => resolveRegisteredStudyProjects(
      [{ localPath: "/workspace/apartment", title: "Apartment rentals" }],
      [{ id: "spoof", localPath: "/tmp/apartment", title: "Apartment rentals" }],
      () => true,
    )).toThrow(/registered path/i)

    expect(() => resolveRegisteredStudyProjects(
      [
        { localPath: "/one/apartment", title: "One" },
        { localPath: "/two/apartment", title: "Two" },
      ],
      [
        { id: "one", localPath: "/one/apartment", title: "One" },
        { id: "two", localPath: "/two/apartment", title: "Two" },
      ],
      () => true,
    )).toThrow(/exactly one/i)
  })
})
