import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeProjectFolderName, claudeSessionFileExists } from "./claude-session-files"

describe("claudeProjectFolderName", () => {
  test("encodes every non-alphanumeric char as '-' (matches the CLI's on-disk folders)", () => {
    expect(claudeProjectFolderName("/root/Kanna/test")).toBe("-root-Kanna-test")
    expect(claudeProjectFolderName("/Users/z/Developer/my_project")).toBe("-Users-z-Developer-my-project")
    expect(claudeProjectFolderName("/tmp/my.app dir")).toBe("-tmp-my-app-dir")
  })
})

describe("claudeSessionFileExists", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claude-home-"))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test("true when the session jsonl exists, false when missing (recreated container)", () => {
    const dir = join(home, ".claude", "projects", "-root-Kanna-test")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "abc-123.jsonl"), "{}")
    expect(claudeSessionFileExists("/root/Kanna/test", "abc-123", home)).toBe(true)
    expect(claudeSessionFileExists("/root/Kanna/test", "gone-456", home)).toBe(false)
    expect(claudeSessionFileExists("/other/project", "abc-123", home)).toBe(false)
  })

  test("rejects traversal-shaped tokens outright", () => {
    expect(claudeSessionFileExists("/root/Kanna/test", "../../etc/passwd", home)).toBe(false)
    expect(claudeSessionFileExists("/root/Kanna/test", "a/b", home)).toBe(false)
  })
})
