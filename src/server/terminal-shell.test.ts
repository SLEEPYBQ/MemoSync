import { describe, expect, test } from "bun:test"
import { pickUsableShell } from "./terminal-manager"

describe("pickUsableShell (Docker 'unknown' shell fix)", () => {
  const exists = (p: string) => p === "/bin/bash" || p === "/bin/sh" || p === "/usr/bin/bash"
  test("skips the 'unknown' sentinel and lands on a real shell", () => {
    expect(pickUsableShell(["unknown", "/bin/bash", "/bin/sh"], exists)).toBe("/bin/bash")
  })
  test("skips empty/whitespace/nullish candidates", () => {
    expect(pickUsableShell([null, "", "  ", undefined, "/bin/sh"], exists)).toBe("/bin/sh")
  })
  test("skips absolute paths that don't exist", () => {
    expect(pickUsableShell(["/opt/fish", "/bin/bash"], exists)).toBe("/bin/bash")
  })
  test("trusts a bare command name (PATH resolution) without an exists check", () => {
    expect(pickUsableShell(["bash"], () => false)).toBe("bash")
  })
  test("returns null when nothing is usable", () => {
    expect(pickUsableShell(["unknown", "/nope"], () => false)).toBeNull()
  })
})
