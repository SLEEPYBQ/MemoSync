import { describe, expect, test } from "bun:test"
import { parseLocalFileLink, shouldOpenLocalFileLinkInEditor, stripOutputsPath, stripWorkspacePath } from "./pathUtils"

test("Windows file links retain drive and UNC roots and workspace-relative labels", () => {
  expect(parseLocalFileLink("C:\\Projects\\中文\\app.ts:12:3")).toEqual({ path: "C:\\Projects\\中文\\app.ts", line: 12, column: 3 })
  expect(parseLocalFileLink("\\\\server\\share\\app.ts#L5")).toEqual({ path: "\\\\server\\share\\app.ts", line: 5, column: undefined })
  expect(parseLocalFileLink("C:relative.ts:5")).toBeNull()
  expect(parseLocalFileLink("C:/Projects/with%20spaces/app%23one.ts#L4")).toEqual({ path: "C:/Projects/with spaces/app#one.ts", line: 4, column: undefined })
  expect(stripWorkspacePath("c:\\PROJECTS\\Demo\\src\\app.ts", "C:/Projects/Demo/")).toBe("src/app.ts")
  expect(stripWorkspacePath("C:\\Projects\\Demo-other\\app.ts", "C:\\Projects\\Demo")).toBe("C:/Projects/Demo-other/app.ts")
  expect(stripOutputsPath("C:\\Projects\\Demo\\outputs\\chart.csv", "C:\\Projects\\Demo")).toBe("/chart.csv")
})

describe("parseLocalFileLink", () => {
  test("parses an absolute file path with a line fragment", () => {
    expect(parseLocalFileLink("/Users/jake/Projects/kanna/src/app.ts#L12")).toEqual({
      path: "/Users/jake/Projects/kanna/src/app.ts",
      line: 12,
      column: undefined,
    })
  })

  test("parses an absolute file path without a fragment", () => {
    expect(parseLocalFileLink("/Users/jake/Projects/kanna/src/app.ts")).toEqual({
      path: "/Users/jake/Projects/kanna/src/app.ts",
    })
  })

  test("parses an absolute file path with a line suffix", () => {
    expect(parseLocalFileLink("/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1")).toEqual({
      path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: undefined,
    })
  })

  test("parses an absolute file path with line and column suffixes", () => {
    expect(parseLocalFileLink("/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1:2")).toEqual({
      path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: 2,
    })
  })

  test("parses same-origin absolute file urls with a line suffix", () => {
    const originalWindow = globalThis.window
    // writable matters: defineProperty without it leaves `window` READONLY
    // after this test, and any later test file doing `globalThis.window = …`
    // (socket.test, useTheme.test) throws. Test-file order is platform-
    // dependent, so this only ever bit on CI.
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          origin: "http://localhost:9000",
        },
      },
      configurable: true,
      writable: true,
    })

    try {
      expect(parseLocalFileLink("http://localhost:9000/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1")).toEqual({
        path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
        line: 1,
        column: undefined,
      })
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      })
    }
  })

  test("does not treat web links as local file links", () => {
    expect(parseLocalFileLink("https://example.com")).toBeNull()
  })
})

describe("shouldOpenLocalFileLinkInEditor", () => {
  test("opens source, markdown, and text files in the editor", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/src/app.ts")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/README.md")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/notes.txt")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/.gitignore")).toBe(true)
  })

  test("opens media and document files in the default app", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/shot.png")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/movie.mp4")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/report.docx")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/archive.zip")).toBe(false)
  })
})
