import { afterAll, expect, test } from "bun:test"
import { startMountedRaceHarness } from "../../test-utils/mountedRaceHarness"

let harness: Awaited<ReturnType<typeof startMountedRaceHarness>> | undefined
afterAll(async () => { await harness?.close() })

test("defers saved terminals until first shown, restores output, and stays subscribed while hidden", async () => {
  harness = await startMountedRaceHarness()
  const page = await harness.openPage("terminal-workspace")
  try {
    await page.getByTestId("rerender").click()
    await page.waitForFunction(() => document.querySelector('[data-testid="revision"]')?.textContent === "1")
    await page.waitForLoadState("networkidle")
    const terminalRequests = () => page.evaluate(() => performance.getEntriesByType("resource")
      .filter(entry => /\/components\/chat-ui\/TerminalWorkspace\.tsx/.test(entry.name)).length)
    expect(await terminalRequests()).toBe(0)
    expect(await page.locator(".xterm").count()).toBe(0)

    await page.getByTestId("toggle").click()
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("OUTPUT_BEFORE_OPEN"))
    expect(await terminalRequests()).toBe(1)
    const terminal = await page.locator(".xterm").elementHandle()
    const stats = () => page.evaluate(() => (window as unknown as {
      __terminalFixture: { stats: () => { subscriptions: number; unsubscriptions: number } }
    }).__terminalFixture.stats())
    expect(await stats()).toEqual({ subscriptions: 1, unsubscriptions: 0 })

    await page.getByTestId("toggle").click()
    await page.evaluate(() => (window as unknown as {
      __terminalFixture: { emitOutput: (data: string) => void }
    }).__terminalFixture.emitOutput("OUTPUT_WHILE_HIDDEN\r\n"))
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("OUTPUT_WHILE_HIDDEN"))
    await page.getByTestId("toggle").click()
    expect(await terminal?.evaluate(node => node === document.querySelector(".xterm"))).toBe(true)
    expect(await stats()).toEqual({ subscriptions: 1, unsubscriptions: 0 })
    expect(await page.locator(".xterm-rows").textContent()).toContain("OUTPUT_BEFORE_OPEN")
    expect(await page.locator(".xterm-rows").textContent()).toContain("OUTPUT_WHILE_HIDDEN")
  } finally {
    await page.close()
  }
}, 30_000)
