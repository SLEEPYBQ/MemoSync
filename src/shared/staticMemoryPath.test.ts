import { expect, test } from "bun:test"
import { isStaticMemoryMarkdownPath } from "./staticMemoryPath"

test("accepts only canonical case-sensitive Static memory Markdown paths", () => {
  for (const accepted of [
    "MEMORY.md",
    "memory/preferences.md",
    "memory/team/preferences.md",
  ]) {
    expect(isStaticMemoryMarkdownPath(accepted)).toBe(true)
  }

  for (const rejected of [
    "memory.md",
    "Memory.md",
    "MEMORY.MD",
    "src/app.ts",
    "notes/readme.md",
    "/memory/preferences.md",
    "memory\\preferences.md",
    "memory/../MEMORY.md",
    "memory/team/../../MEMORY.md",
    "memory//preferences.md",
    "./MEMORY.md",
    "memory/preferences.MD",
  ]) {
    expect(isStaticMemoryMarkdownPath(rejected)).toBe(false)
  }
})
