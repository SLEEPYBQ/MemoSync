import { expect, test } from "bun:test"
import { fileDriftSummary } from "./memoryFileDrift"

test("working-memory drift summaries name the status and count distinct paths", () => {
  expect(fileDriftSummary([{ path: "src/auth.ts", drift: "changed" }])).toBe("auth.ts changed")
  expect(fileDriftSummary([{ path: "src/auth.ts", drift: "missing" }])).toBe("auth.ts missing")
  expect(fileDriftSummary([{ path: "AGENTS.md", drift: "line_removed" }])).toBe("removed from AGENTS.md")
  expect(fileDriftSummary([{ path: "src/auth.ts", drift: "changed" }, { path: "AGENTS.md", drift: "line_removed" }])).toBe("2 files changed")
  expect(fileDriftSummary([{ path: "AGENTS.md", drift: "changed" }, { path: "AGENTS.md", drift: "line_removed" }])).toBe("removed from AGENTS.md")
})
