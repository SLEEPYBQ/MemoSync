import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Page } from "playwright"
import { startMountedRaceHarness } from "../test-utils/mountedRaceHarness"

interface Fixture {
  answers(): Array<Record<string, string[]>>
  reject(index: number): void
  resolve(index: number): void
  commands(): Array<{ type: string; chatId?: string }>
  resolveGenerate(): void
}

let harness: Awaited<ReturnType<typeof startMountedRaceHarness>>
let page: Page | undefined
beforeAll(async () => { harness = await startMountedRaceHarness() })
afterEach(async () => { await page?.close(); page = undefined })
afterAll(async () => { await harness?.close() })

describe("question ACK and git origin", () => {
  test("keeps answers on rejection, guards duplicate submission, and completes after retry", async () => {
    page = await harness.openPage("question-git")
    const target = page
    await target.getByText("Option A", { exact: true }).click()
    const input = target.getByPlaceholder("Other")
    await input.fill("Extra")
    await target.getByRole("button", { name: "Submit" }).evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await target.waitForFunction(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.answers().length === 1)
    expect(await input.isDisabled()).toBe(true)
    await target.evaluate(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.reject(0))
    await target.waitForFunction(() => {
      const fieldset = document.querySelector("fieldset")
      return fieldset && !fieldset.disabled
    })
    expect(await input.inputValue()).toBe("Extra")
    await input.press("Enter")
    await target.waitForFunction(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.answers().length === 2)
    expect(await target.evaluate(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.answers())).toEqual([
      { q: ["Option A", "Extra"] }, { q: ["Option A", "Extra"] },
    ])
    await target.evaluate(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.resolve(1))
    await target.getByText("Option A, Extra", { exact: true }).waitFor()
  })

  test("a generated commit keeps its origin chat after navigation", async () => {
    page = await harness.openPage("question-git")
    const target = page
    await target.getByTestId("generate-and-commit").click()
    await target.waitForFunction(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.commands().some(c => c.type === "chat.generateCommitMessage"))
    await target.getByTestId("switch-chat").click()
    await target.evaluate(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.resolveGenerate())
    await target.waitForFunction(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.commands().some(c => c.type === "chat.commitDiffs"))
    const commands = await target.evaluate(() => (window as unknown as { __questionGitFixture: Fixture }).__questionGitFixture.commands())
    expect(commands.filter(c => c.type === "chat.commitDiffs")).toEqual([expect.objectContaining({ chatId: "chat-a" })])
    expect(commands.filter(c => c.chatId === "chat-b")).toEqual([])
  })
})
