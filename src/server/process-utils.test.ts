import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { hasCommand, inheritShellPath, mergePathLists, parseShellPathOutput, spawnDetached } from "./process-utils"

describe("spawnDetached", () => {
  test("rejects when the command does not exist", async () => {
    await expect(spawnDetached("definitely-not-a-real-command-kanna", [])).rejects.toThrow("Command not found")
  })

  test("resolves when the process starts successfully", async () => {
    await expect(spawnDetached("sh", ["-c", "exit 0"])).resolves.toBeUndefined()
  })
})

// Login-shell PATH inheritance (Kanna 9eb757a).
const originalPath = process.env.PATH
let shellTestDirs: string[] = []
afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(shellTestDirs.map(dir => rm(dir, { recursive: true, force: true })))
  shellTestDirs = []
})

describe("login-shell PATH", () => {
  test("keeps current command precedence, appends missing paths, and removes empty entries", () => {
    expect(mergePathLists("/a:/usr/bin:/b", "/home/.local/bin:/usr/bin:/a::/c")).toBe("/a:/usr/bin:/b:/home/.local/bin:/c")
    expect(mergePathLists("", "/x:/y")).toBe("/x:/y")
  })
  test("parses marked PATH while ignoring shell startup noise and incomplete output", () => {
    expect(parseShellPathOutput("Welcome!\n__MEMOSYNC_SHELL_PATH__\n/one:/two\n__MEMOSYNC_SHELL_PATH__\nbye")).toBe("/one:/two")
    expect(parseShellPathOutput("")).toBeNull()
    expect(parseShellPathOutput("__MEMOSYNC_SHELL_PATH__\n\n__MEMOSYNC_SHELL_PATH__")).toBeNull()
    expect(parseShellPathOutput("__MEMOSYNC_SHELL_PATH__\n/incomplete")).toBeNull()
  })
  test("inherits a login environment and command lookup sees the updated PATH", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "memosync-shell-path-"))
    shellTestDirs.push(dir)
    const shell = path.join(dir, "shell")
    const cli = path.join(dir, "memosync-path-test-cli")
    await writeFile(shell, `#!/bin/sh\necho noisy-startup\necho __MEMOSYNC_SHELL_PATH__\necho '${dir}:/usr/bin'\necho __MEMOSYNC_SHELL_PATH__\n`)
    await writeFile(cli, "#!/bin/sh\nexit 0\n")
    await chmod(shell, 0o755)
    await chmod(cli, 0o755)
    process.env.PATH = "/usr/bin"
    await inheritShellPath({ shell })
    expect(process.env.PATH).toBe(`/usr/bin:${dir}`)
    expect(hasCommand("memosync-path-test-cli")).toBe(true)
  })
  test("a missing or hung shell cannot stall startup or replace PATH", async () => {
    const before = process.env.PATH
    await inheritShellPath({ shell: "/does/not/exist" })
    expect(process.env.PATH).toBe(before)
    const dir = await mkdtemp(path.join(tmpdir(), "memosync-shell-timeout-"))
    shellTestDirs.push(dir)
    const shell = path.join(dir, "shell")
    // A shell builtin loop avoids leaving descendant processes behind.
    await writeFile(shell, "#!/bin/sh\nwhile :; do :; done\n")
    await chmod(shell, 0o755)
    const started = performance.now()
    await inheritShellPath({ shell, timeoutMs: 30 })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(process.env.PATH).toBe(before)
  })
})
