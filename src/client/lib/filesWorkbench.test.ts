import { describe, expect, it } from "bun:test"
import {
  ancestorDirs, baseName, dirName, filterIndexPaths, isSameOrUnder, nextActiveTab, remapPathAfterRename,
} from "./filesWorkbench"

describe("baseName / dirName", () => {
  it("splits path components", () => {
    expect(baseName("src/app/main.tsx")).toBe("main.tsx")
    expect(dirName("src/app/main.tsx")).toBe("src/app")
    expect(baseName("README.md")).toBe("README.md")
    expect(dirName("README.md")).toBe("")
  })
})

describe("ancestorDirs", () => {
  it("lists ancestors shallowest first", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"])
    expect(ancestorDirs("top.ts")).toEqual([])
  })
})

describe("filterIndexPaths", () => {
  const index = [
    "README.md",
    "docs/plan.md",
    "src/client/app/App.tsx",
    "src/client/components/chat-ui/FilesPanel.tsx",
    "src/server/server.ts",
    "package.json",
  ]

  it("returns nothing for an empty query", () => {
    expect(filterIndexPaths(index, "")).toEqual([])
    expect(filterIndexPaths(index, "   ")).toEqual([])
  })

  it("matches case-insensitive substrings and ranks basename hits first", () => {
    expect(filterIndexPaths(index, "APP")).toEqual(["src/client/app/App.tsx"])
    // "panel" hits FilesPanel.tsx via its basename.
    expect(filterIndexPaths(index, "panel")[0]).toBe("src/client/components/chat-ui/FilesPanel.tsx")
    // path-only match still returned, ranked after basename matches.
    const bySegment = filterIndexPaths(index, "client")
    expect(bySegment).toContain("src/client/app/App.tsx")
    expect(bySegment).toContain("src/client/components/chat-ui/FilesPanel.tsx")
  })

  it("requires every token to match", () => {
    expect(filterIndexPaths(index, "server ts")).toEqual(["src/server/server.ts"])
    expect(filterIndexPaths(index, "server md")).toEqual([])
  })

  it("honours the limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => `file-${i}.txt`)
    expect(filterIndexPaths(many, "file", 10)).toHaveLength(10)
  })
})

describe("nextActiveTab", () => {
  const tabs = ["a.ts", "b.ts", "c.ts"]

  it("keeps the active tab when another closes", () => {
    expect(nextActiveTab(tabs, "a.ts", "c.ts")).toBe("c.ts")
  })

  it("prefers the right neighbour, then the left", () => {
    expect(nextActiveTab(tabs, "b.ts", "b.ts")).toBe("c.ts")
    expect(nextActiveTab(tabs, "c.ts", "c.ts")).toBe("b.ts")
  })

  it("returns null when the last tab closes", () => {
    expect(nextActiveTab(["a.ts"], "a.ts", "a.ts")).toBeNull()
  })
})

describe("remapPathAfterRename", () => {
  it("remaps the renamed path and children of a renamed directory", () => {
    expect(remapPathAfterRename("a/b.ts", "a/b.ts", "a/c.ts")).toBe("a/c.ts")
    expect(remapPathAfterRename("src/app/x.ts", "src", "lib")).toBe("lib/app/x.ts")
  })

  it("leaves unrelated and prefix-similar paths alone", () => {
    expect(remapPathAfterRename("other.ts", "a/b.ts", "a/c.ts")).toBe("other.ts")
    // "srcs" merely shares the "src" prefix — not under the renamed dir.
    expect(remapPathAfterRename("srcs/x.ts", "src", "lib")).toBe("srcs/x.ts")
  })
})

describe("isSameOrUnder", () => {
  it("matches the path itself and descendants only", () => {
    expect(isSameOrUnder("docs", "docs")).toBe(true)
    expect(isSameOrUnder("docs/a/b.md", "docs")).toBe(true)
    expect(isSameOrUnder("docs2/a.md", "docs")).toBe(false)
  })
})
