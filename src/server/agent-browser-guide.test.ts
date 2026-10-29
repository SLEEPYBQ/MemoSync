import { expect, test } from "bun:test"
import { buildClaudeSystemAppend } from "./agent"

test("Browser guidance explains local development and the proxy boundary", () => {
  const guide = buildClaudeSystemAppend("")
  expect(guide).toContain("Start the project's development server")
  expect(guide).toContain("0.0.0.0")
  expect(guide).toContain("proxy")
  expect(guide).toContain("relative URLs")
  expect(guide).toContain("Refresh")
  expect(guide).not.toContain("3000")
  expect(guide).not.toContain("preview_restart")
})

test("Browser instructions compose with the product memory append", () => {
  const memory = "<memory-system>MemoSync versioned pool</memory-system>"
  expect(buildClaudeSystemAppend(memory)).toBe(`${buildClaudeSystemAppend("")}\n\n${memory}`)
})
