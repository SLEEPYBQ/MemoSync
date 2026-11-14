import { expect, test } from "bun:test"
import { fileChangedAgo, fileDriftSummary } from "./memoryFileDrift"

test("working-memory drift summaries name the status and count distinct paths", () => {
  expect(fileDriftSummary([{ path: "src/auth.ts", drift: "changed" }])).toBe("auth.ts changed")
  expect(fileDriftSummary([{ path: "src/auth.ts", drift: "missing" }])).toBe("auth.ts missing")
  expect(fileDriftSummary([{ path: "AGENTS.md", drift: "line_removed" }])).toBe("removed from AGENTS.md")
  expect(fileDriftSummary([{ path: "src/auth.ts", drift: "changed" }, { path: "AGENTS.md", drift: "line_removed" }])).toBe("2 files changed")
  expect(fileDriftSummary([{ path: "AGENTS.md", drift: "changed" }, { path: "AGENTS.md", drift: "line_removed" }])).toBe("removed from AGENTS.md")
})

test("file change times use relative minutes, hours and days and reject future or invalid dates", () => {
  const now = Date.parse("2030-06-20T12:00:00.000Z")
  const ago = (milliseconds: number) => new Date(now - milliseconds).toISOString()
  expect(fileChangedAgo(ago(12 * 60_000), now)).toBe("12 minutes ago")
  expect(fileChangedAgo(ago(5 * 60 * 60_000), now)).toBe("5 hours ago")
  expect(fileChangedAgo(ago(3 * 24 * 60 * 60_000), now)).toBe("3 days ago")
  expect(fileChangedAgo(ago(1), now)).toBe("1 minute ago")
  expect(fileChangedAgo(undefined, now)).toBeNull()
  expect(fileChangedAgo("not a date", now)).toBeNull()
  expect(fileChangedAgo(new Date(now + 1).toISOString(), now)).toBeNull()
  expect(fileChangedAgo(new Date(now + 60_000).toISOString(), now)).toBeNull()
})
