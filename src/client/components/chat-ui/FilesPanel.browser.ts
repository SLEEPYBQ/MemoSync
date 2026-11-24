import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page, Route } from "playwright"
import type { EventStore } from "../../../server/event-store"
import { handleProjectFileContent } from "../../../server/server"
import { startMountedRaceHarness } from "../../test-utils/mountedRaceHarness"

interface Fixture {
  setProject(project: string): void
  setMounted(mounted: boolean): void
  buffer(project: string): { original: string; current: string; revision: string | null; saving: boolean } | null
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

// Route just this fixture file through the real content handler, including its raw GET bytes and ETags.
async function routeDiskFile(target: Page, dir: string) {
  const store = { getProject: () => ({ id: "project-a", localPath: dir }) } as unknown as EventStore
  await target.route("**/projects/project-a/files/note.txt/content?editor=1", async route => {
    const r = route.request()
    const req = new Request(r.url(), { method: r.method(), headers: r.headers(), body: r.postDataBuffer() })
    const res = (await handleProjectFileContent(req, new URL(req.url), store))!
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
  })
}

describe("FilesPanel text format", () => {
  test("a CodeMirror edit keeps the BOM out of the PUT and preserves old and new CRLFs", async () => {
    page = await harness.openPage("file-editor")
    await page.route("**/files/**/content?editor=1", route => route.fulfill(route.request().method() === "PUT"
      ? { json: { data: { saved: true } }, headers: { etag: '"saved"' } }
      : { body: Buffer.from("\uFEFFone\r\ntwo\r\n"), headers: { etag: '"base"' } }))
    await page.getByRole("button", { name: "note.txt" }).first().click()
    const editor = page.locator(".cm-content")
    await editor.press("x")
    await editor.press("Enter")
    const [save] = await Promise.all([
      page.waitForRequest(req => req.method() === "PUT"),
      page.getByTitle("Save (⌘S)").click(),
    ])
    expect(save.postDataBuffer()).toEqual(Buffer.from("x\r\none\r\ntwo\r\n"))
  })

  test.each([
    ["CRLF", "", "\r\n"],
    ["CR", "", "\r"],
    ["BOM + CRLF", "\uFEFF", "\r\n"],
  ])("preserves %s on disk after switching away from a dirty single-line draft", async (_, bom, eol) => {
    page = await harness.openPage("file-editor")
    const dir = mkdtempSync(join(tmpdir(), "memosync-files-format-"))
    const file = join(dir, "note.txt")
    try {
      const text = `one${eol}two${eol}`
      writeFileSync(file, bom + text)
      await routeDiskFile(page, dir)
      await page.getByRole("button", { name: "note.txt" }).click()
      const editor = page.locator(".cm-content")
      await waitForCurrent(page, "project-a", text)
      await editor.fill("draft")
      await waitForCurrent(page, "project-a", "draft")
      await page.getByRole("button", { name: "other.txt" }).click()
      await editor.getByText("base a", { exact: true }).waitFor()
      await page.getByTitle("note.txt", { exact: true }).click()
      await editor.getByText("draft", { exact: true }).waitFor()
      await editor.press("x")
      await editor.press("Enter")

      const [saved] = await Promise.all([
        page.waitForResponse(res => res.request().method() === "PUT"),
        page.getByTitle("Save (⌘S)").click(),
      ])
      expect(saved.status()).toBe(200)
      const expected = `x${eol}draft`
      expect(readFileSync(file)).toEqual(Buffer.from(bom + expected))
      await page.getByTitle("Unsaved changes — close").waitFor({ state: "hidden" })
      expect(await buffer(page, "project-a")).toMatchObject({
        original: expected, current: expected, revision: saved.headers().etag,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ["en", "This editor only supports UTF-8 text without NUL bytes. Use another editor for this file."],
    ["zh-CN", "此编辑器仅支持不含空字节（NUL）的 UTF-8 文本。请使用其他编辑器打开此文件。"],
  ] as const)("explains a refused read in %s without opening an editor", async (language, message) => {
    page = await harness.openPage("file-editor")
    await page.evaluate(lang => localStorage.setItem("memosync:resolved-language", lang), language)
    await page.reload()
    await page.route("**/files/**/content?editor=1", route => route.fulfill({ status: 415, json: { error: "Unsupported file encoding" } }))
    await page.getByRole("button", { name: "note.txt" }).first().click()
    await page.getByRole("button", { name: /retry|重试/i }).waitFor()
    expect(await page.getByText(message, { exact: true }).count()).toBe(1)
    expect(await page.locator(".cm-content").count()).toBe(0)
  })
})

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
