import { expect, test } from "bun:test"
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Keep Chromium's process lifecycle inside one Bun test file, including teardown.
export function runMountedRaceSuite(name: string, suiteUrl: URL) {
  test(name, async () => {
    const suitePath = fileURLToPath(suiteUrl)
    const child = Bun.spawn([
      process.execPath,
      "test",
      `./${basename(suitePath)}`,
      "--timeout",
      "30000",
    ], {
      cwd: dirname(suitePath),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(90_000),
    })
    expect(await child.exited).toBe(0)
  }, 100_000)
}
