import { expect, test } from "bun:test"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Keep Chromium's extra stdio pipes and their finalizers out of the shared test process.
// On Linux, Bun 1.3.10 can close a reused descriptor when collecting an already
// closed extra pipe (oven-sh/bun#47561). Run every original assertion in the child;
// its nonzero exit still fails the parent. Per-case timeouts remain in the suite.
export function runMountedRaceSuite(name: string, suiteUrl: URL, options: { timeoutMs?: number; cwd?: string } = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000
  test(name, async () => {
    const suitePath = fileURLToPath(suiteUrl)
    const child = Bun.spawn([
      process.execPath,
      "test",
      suitePath,
      "--timeout",
      "30000",
    ], {
      cwd: options.cwd ?? dirname(suitePath),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(timeoutMs),
    })
    expect(await child.exited).toBe(0)
  }, timeoutMs + 10_000)
}
