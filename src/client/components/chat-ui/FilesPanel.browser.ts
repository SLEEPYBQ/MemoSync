import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Page, Route } from "playwright"
import { startMountedRaceHarness } from "../../test-utils/mountedRaceHarness"

interface Fixture {
  setProject(project: string): void
  setMounted(mounted: boolean): void
  buffer(project: string, path?: string): { original: string; current: string; revision: string | null; saving: boolean } | null
}

let harness: Awaited<ReturnType<typeof startMountedRaceHarness>>
let page: Page | undefined
beforeAll(async () => { harness = await startMountedRaceHarness() })
afterEach(async () => { await page?.close(); page = undefined })
afterAll(async () => { await harness?.close() })

async function buffer(target: Page, project: string) {
  return target.evaluate(projectId => (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.buffer(projectId), project)
}

async function waitForCurrent(target: Page, project: string, expected: string) {
  await target.waitForFunction(({ project, expected }) =>
    (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.buffer(project)?.current === expected,
  { project, expected })
}

describe("FilesPanel draft ownership", () => {
  test("preserves project drafts and newer typing while a save resolves after remount", async () => {
    page = await harness.openPage("file-editor")
    const target = page
    await target.getByRole("button", { name: "note.txt" }).first().click()
    const editor = target.locator(".cm-content")
    await editor.waitFor()
    await editor.fill("first edit")
    await waitForCurrent(target, "project-a", "first edit")
    let save: Route | undefined
    await target.route("**/files/**/content?editor=1", async route => {
      if (route.request().method() === "PUT") save = route
      else await route.fallback()
    })
    await target.getByTitle("Save (⌘S)").click()
    const deadline = Date.now() + 5_000
    while (!save && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(save).toBeDefined()
    expect(save!.request().headers()["if-match"]).toBe('"a-base"')
    await target.evaluate(() => (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.setMounted(false))
    await target.evaluate(() => (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.setProject("project-b"))
    await target.evaluate(() => (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.setMounted(true))
    await target.getByRole("button", { name: "note.txt" }).first().click()
    await target.locator(".cm-content").fill("b edit")
    await waitForCurrent(target, "project-b", "b edit")
    await target.evaluate(() => (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.setProject("project-a"))
    await target.locator(".cm-content").waitFor()
    expect(await target.locator(".cm-content").innerText()).toContain("first edit")
    await target.locator(".cm-content").fill("newer edit")
    await waitForCurrent(target, "project-a", "newer edit")
    await save!.fulfill({ json: { data: { saved: true } }, headers: { etag: '"a-saved"' } })
    await target.waitForFunction(() => {
      const b = (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.buffer("project-a")
      return b && !b.saving && b.original === "first edit"
    })
    expect(await buffer(target, "project-a")).toMatchObject({ original: "first edit", current: "newer edit", revision: '"a-saved"', saving: false })
    expect(await buffer(target, "project-b")).toMatchObject({ original: "base b", current: "b edit" })
    target.once("dialog", dialog => void dialog.accept())
    await target.getByTitle("Unsaved changes — close").click()
    await target.waitForFunction(() => !(window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.buffer("project-a"))
    expect(await buffer(target, "project-b")).toMatchObject({ current: "b edit" })
  })

  test("a revision conflict keeps the text and original revision for recovery", async () => {
    page = await harness.openPage("file-editor")
    const target = page
    await target.getByRole("button", { name: "note.txt" }).first().click()
    await target.locator(".cm-content").fill("unsaved edit")
    await waitForCurrent(target, "project-a", "unsaved edit")
    await target.route("**/files/**/content?editor=1", async route => {
      if (route.request().method() === "PUT") await route.fulfill({ status: 412, json: { error: "File changed" } })
      else await route.fallback()
    })
    await target.getByTitle("Save (⌘S)").click()
    await target.getByText("This file changed or was removed on disk. Copy your edits before reloading.").waitFor()
    expect(await buffer(target, "project-a")).toMatchObject({
      original: "base a", current: "unsaved edit", revision: '"a-base"', saving: false,
    })
  })
})

async function showFiles(target: Page, mounted: boolean) {
  await target.evaluate(show => (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.setMounted(show), mounted)
  await target.getByPlaceholder("Filter files…").waitFor({ state: mounted ? "attached" : "detached" })
}

async function renameEntry(target: Page, from: string, to: string) {
  await target.getByRole("button", { name: from, exact: true }).last().click({ button: "right" })
  await target.getByRole("menuitem", { name: "Rename" }).click()
  const input = target.locator("input:not([placeholder])")
  await input.fill(to)
  await input.press("Enter")
}

describe("FilesPanel tree edits", () => {
  test("a rename acknowledged after Files closes restores the active dirty tab under its new name", async () => {
    page = await harness.openPage("file-editor")
    const target = page
    await target.getByRole("button", { name: "note.txt" }).first().click()
    await target.locator(".cm-content").fill("keep this edit")
    await waitForCurrent(target, "project-a", "keep this edit")

    const pending = Promise.withResolvers<Route>()
    await target.route("**/files/op", route => pending.resolve(route))
    await renameEntry(target, "note.txt", "renamed.txt")
    const request = await pending.promise
    expect(request.request().postDataJSON()).toEqual({ op: "rename", path: "note.txt", toPath: "renamed.txt" })
    await showFiles(target, false)
    await request.fulfill({ json: { data: { done: true } } })
    await target.waitForFunction(() =>
      (window as unknown as { __filesEditorFixture: Fixture }).__filesEditorFixture.buffer("project-a", "renamed.txt")?.current === "keep this edit")
    await showFiles(target, true)
    await target.getByTitle("renamed.txt", { exact: true }).waitFor()
    expect(await target.locator(".cm-content").innerText()).toBe("keep this edit")
  })

  test("a missing file's restored draft blocks renaming into it until explicitly discarded", async () => {
    page = await harness.openPage("file-editor")
    const target = page
    await target.getByRole("button", { name: "note.txt" }).first().click()
    await target.locator(".cm-content").fill("keep missing file's draft")
    await waitForCurrent(target, "project-a", "keep missing file's draft")
    await showFiles(target, false)
    // Another workspace edit removed note.txt while Files was closed.
    await target.route("**/files?dir=*", route => route.fulfill({
      json: { data: { dir: "", entries: [{ name: "scratch.txt", kind: "file", size: 6 }] } },
    }))
    let moves = 0
    await target.route("**/files/op", route => {
      moves++
      return route.fulfill({ json: { data: { done: true } } })
    })
    await showFiles(target, true)
    await target.getByRole("button", { name: "scratch.txt" }).click()
    await target.locator(".cm-content").fill("keep source draft too")
    await renameEntry(target, "scratch.txt", "note.txt")
    await target.getByText(/Close “note\.txt” in Files before renaming/).waitFor()
    expect(moves).toBe(0)
    expect(await target.locator(".cm-content").innerText()).toBe("keep source draft too")
    const dest = target.getByTitle("note.txt", { exact: true })
    await dest.click()
    expect(await target.locator(".cm-content").innerText()).toBe("keep missing file's draft")
    target.once("dialog", dialog => void dialog.accept())
    await dest.getByTitle("Unsaved changes — close").click()
    await renameEntry(target, "scratch.txt", "note.txt")
    await dest.waitFor()
    expect(moves).toBe(1)
    expect(await target.locator(".cm-content").innerText()).toBe("keep source draft too")
  })
})
