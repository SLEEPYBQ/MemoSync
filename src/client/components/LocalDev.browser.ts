import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import react from "@vitejs/plugin-react"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import type { ChatAttachment } from "../../shared/types"
import { DELETED_UPLOAD_NOTIFICATION } from "../stores/chatInputStore"
import type {} from "../test-fixtures/landing-draft/fixture"

let cacheDir: string, vite: ViteDevServer, browser: Browser, page: Page, origin: string
const uploads: string[] = []
const pageErrors: string[] = []
const files = new Map<string, string>()

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "memosync-landing-vite-"))
  vite = await createServer({
    configFile: false, root: join(import.meta.dir, "../test-fixtures/landing-draft"), cacheDir, plugins: [react()],
    server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error",
  })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  await vite?.close()
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
})
beforeEach(async () => {
  uploads.length = pageErrors.length = 0
  files.clear()
  page = await browser.newPage()
  page.setDefaultTimeout(5_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  await page.route("**/*", async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith("/api/")) return route.continue()
    const upload = /^\/api\/projects\/([^/]+)\/uploads(?:\/([^/]+)(?:\/content)?)?$/.exec(url.pathname)
    if (upload) {
      const folder = await page.evaluate(id => window.landingFixture.pathFor(id), upload[1]!)
      if (!folder) return route.fulfill({ status: 404, json: { error: "Unknown fixture project" } })
      if (route.request().method() === "POST") {
        uploads.push(url.pathname)
        const form = await new Response(route.request().postDataBuffer(), { headers: route.request().headers() }).formData()
        const file = form.get("files") as File
        const storedName = file.name.replaceAll(" ", "-")
        const absolutePath = `${folder}/.memosync/uploads/${storedName}`
        files.set(absolutePath, await file.text())
        return route.fulfill({ json: { attachments: [{
          id: `fixture-file-${uploads.length}`, displayName: file.name, kind: "file", absolutePath,
          relativePath: `./.memosync/uploads/${storedName}`, contentUrl: `${url.pathname}/${encodeURIComponent(storedName)}/content`,
          mimeType: "text/plain", size: file.size,
        }] } })
      }
      const filePath = `${folder}/.memosync/uploads/${decodeURIComponent(upload[2]!)}`
      if (route.request().method() === "DELETE") return route.fulfill({ json: { ok: files.delete(filePath) } })
      const body = files.get(filePath)
      return route.fulfill({ status: body === undefined ? 404 : 200, body: body ?? "", contentType: "text/plain" })
    }
    return route.fulfill({ json: { data: url.pathname.endsWith("/needs-attention") ? { items: [] } : [] } })
  })
  await page.goto(origin)
  await page.waitForFunction(() => window.landingFixture?.paths()[0] === "/fixture/alpha")
})
afterEach(async () => {
  await page?.close()
  expect(pageErrors).toEqual([])
})

async function pick(from: string, to: string, waitForEnsure = true) {
  await page.getByRole("button", { name: from, exact: true }).click()
  await page.getByRole("button", { name: `${to} /fixture/${to}`, exact: true }).click()
  if (waitForEnsure) await page.waitForFunction(path => window.landingFixture.paths().at(-1) === path, `/fixture/${to}`)
}

async function resolveActive(index: number, id: string) {
  await page.evaluate(([index, id]) => window.landingFixture.resolve(index, id), [index, id] as const)
  await page.waitForFunction(chatId => window.landingFixture.commands.some(({ command }) =>
    command.type === "chat.readHarness" && command.chatId === chatId), `chat-${id}`)
}

async function attach(name = "upload.txt") {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`synthetic contents of ${name}`) })
  // Wait for either result to report the actual failure (not a timeout waiting for a missing POST).
  await page.locator('button[aria-label="Send"]:enabled').or(page.getByText("Open a project before uploading files.")).first().waitFor()
}

async function sendAndWaitForDispatch() {
  const previous = await page.evaluate(() => window.landingFixture.sends.length)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  // Acquiring the shared upload locks is asynchronous. The click isn't proof
  // that onSend has run, and dispatch isn't the ACK in the delayed-send cases.
  await page.waitForFunction(count => window.landingFixture.sends.length === count + 1, previous)
}

test("first attachment in a discovered folder uploads and sends with its hidden draft, without a sidebar entry", async () => {
  await resolveActive(0, "alpha")
  await attach()
  expect(uploads).toEqual(["/api/projects/project-alpha/uploads"])
  await sendAndWaitForDispatch()
  expect(await page.evaluate(() => window.landingFixture.sends[0]?.[1])).toMatchObject({
    projectLocalPath: "/fixture/alpha", draft: { chatId: "chat-alpha", projectId: "project-alpha" },
    attachments: [{ id: "fixture-file-1" }],
  })
})

test("switching while ensureDraft is pending never enables uploads using the abandoned folder", async () => {
  await pick("alpha", "beta")
  await page.evaluate(() => window.landingFixture.resolve(0, "alpha"))
  await page.waitForFunction(() => window.landingFixture.commands.some(({ command }) =>
    command.type === "chat.discardDraft" && command.chatId === "chat-alpha"))
  expect(await page.locator('input[type="file"]').isDisabled()).toBe(true)
  expect(await page.getByRole("status").filter({ hasText: "Loading…" }).isVisible()).toBe(true)
  const navigatesOnDrop = await page.getByRole("textbox").evaluate(textbox => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(["x"], "blocked.txt"))
    return textbox.parentElement!.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }))
  })
  expect(navigatesOnDrop).toBe(false)
  expect(await page.evaluate(() => [...window.landingFixture.subscriptions])).toEqual([])
  await resolveActive(1, "beta")
  await attach()
  expect(uploads).toEqual(["/api/projects/project-beta/uploads"])
})

test("re-entering a folder before its first ensure resolves reacquires after the stale hold is released", async () => {
  await pick("alpha", "beta")
  await pick("beta", "alpha", false)
  await page.evaluate(() => window.landingFixture.resolve(0, "abandoned"))
  await page.waitForFunction(() => window.landingFixture.paths().length === 3)
  const order = await page.evaluate(() => window.landingFixture.commands.flatMap(({ command }) =>
    command.type === "chat.ensureDraft" && "localPath" in command ? [command.localPath]
      : command.type === "chat.discardDraft" ? [command.chatId] : []))
  expect(order).toEqual(["/fixture/alpha", "/fixture/beta", "chat-abandoned", "/fixture/alpha"])
  await resolveActive(2, "reacquired")
  await attach()
  expect(uploads).toEqual(["/api/projects/project-reacquired/uploads"])
})

test("the first render for a different folder or connection does not bind the old native chat", async () => {
  await resolveActive(0, "alpha")
  await pick("alpha", "beta")
  const oldNativeReads = () => page.evaluate(() => window.landingFixture.commands.filter(({ command, connection, heading }) =>
    command.type === "chat.readHarness" && (connection === 2 || heading?.includes("beta") && command.chatId === "chat-alpha")))
  expect(await oldNativeReads()).toEqual([])
  await resolveActive(1, "beta")
  await page.getByRole("button", { name: "Replace fixture connection" }).click()
  await page.waitForFunction(() => window.landingFixture.paths().length === 3)
  expect(await oldNativeReads()).toEqual([])
  await resolveActive(2, "reconnected")
  await page.evaluate(() => window.landingFixture.publish("chat-reconnected", "acceptEdits"))
  const policy = page.getByRole("button", { name: "Permissions" })
  await policy.getByText("Accept edits").waitFor()
  await page.evaluate(() => window.landingFixture.publish("chat-beta", "default"))
  expect(await policy.textContent()).toBe("Accept edits")
  await attach()
  expect(uploads).toEqual(["/api/projects/project-reconnected/uploads"])
})

test("the known sidebar ID works without waiting, and a failed ensure does not block text-only send", async () => {
  await pick("alpha", "saved")
  await attach()
  expect(uploads).toEqual(["/api/projects/project-saved/uploads"])
  await pick("saved", "beta")
  await page.evaluate(() => window.landingFixture.reject(2))
  const input = page.getByRole("textbox")
  await input.fill("synthetic text")
  await sendAndWaitForDispatch()
  const [, options] = await page.evaluate(() => window.landingFixture.sends[0]!)
  expect(options?.projectLocalPath).toBe("/fixture/beta")
  expect(options?.draft).toBeUndefined()
  expect(options?.attachments).toEqual([])
})

test("a discarded discovered project keeps its workspace upload for the next draft's preview and send", async () => {
  const fileName = "Résumé note.txt"
  const chip = page.getByText(fileName, { exact: true })
  await resolveActive(0, "alpha-1")
  await attach(fileName)
  await pick("alpha", "beta")
  await resolveActive(1, "beta")
  expect(await chip.count()).toBe(0)
  await attach("beta.txt")
  const suffix = `/uploads/${encodeURIComponent("Résumé-note.txt")}/content`
  expect(await page.evaluate(async path => (await fetch(path)).status, `/api/projects/project-alpha-1${suffix}`)).toBe(404)

  await pick("beta", "alpha")
  expect(await chip.count()).toBe(0) // no requests against a retired ID while ensure is pending
  await resolveActive(2, "alpha-2")
  expect(await chip.count()).toBe(1)
  expect(await page.getByText("beta.txt", { exact: true }).count()).toBe(0)
  const contentUrl = `/api/projects/project-alpha-2${suffix}`
  const preview = page.waitForResponse(response => new URL(response.url()).pathname === contentUrl)
  await chip.click()
  expect((await preview).status()).toBe(200)
  await page.getByRole("dialog").getByText(`synthetic contents of ${fileName}`, { exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await sendAndWaitForDispatch()
  expect(await page.evaluate(() => window.landingFixture.sends[0]?.[1])).toMatchObject({
    draft: { chatId: "chat-alpha-2", projectId: "project-alpha-2" },
    attachments: [{ id: "fixture-file-1", displayName: fileName, contentUrl }],
  })
  expect(uploads).toEqual(["/api/projects/project-alpha-1/uploads", "/api/projects/project-beta/uploads"])
  await pick("alpha", "beta")
  await resolveActive(3, "beta-2")
  expect(await page.getByText("beta.txt", { exact: true }).count()).toBe(1)
})

test("saved projects import their legacy ID-keyed drafts once, without duplicating an existing upload", async () => {
  await pick("alpha", "saved")
  await attach("saved.txt")
  await pick("saved", "beta")
  const legacy = (name: string, id: string): ChatAttachment => ({
    id, displayName: name, kind: "file", absolutePath: `/fixture/saved/.memosync/uploads/${name}`,
    relativePath: `./.memosync/uploads/${name}`, contentUrl: `/api/projects/project-saved/uploads/${name}/content`,
    mimeType: "text/plain", size: 1,
  })
  await page.evaluate(items => window.landingFixture.seed("landing:project-saved", items), [
    legacy("saved.txt", "fixture-file-1"), legacy("saved.txt", "same-stored-file"), legacy("legacy.txt", "legacy-only"),
  ])
  await page.reload() // both the old and current draft survive in actual browser storage
  await page.waitForFunction(() => window.landingFixture?.paths().length === 1)
  await resolveActive(0, "alpha")
  await pick("alpha", "saved")
  expect(await page.getByText("saved.txt", { exact: true }).count()).toBe(1)
  expect(await page.getByText("legacy.txt", { exact: true }).count()).toBe(1)
  await resolveActive(1, "saved")
  await sendAndWaitForDispatch()
  expect(await page.evaluate(() => window.landingFixture.sends[0]?.[1]?.attachments?.map(item => item.id).sort()))
    .toEqual(["fixture-file-1", "legacy-only"])
  await pick("saved", "alpha")
  await pick("alpha", "saved")
  expect(await page.getByText("legacy.txt", { exact: true }).count()).toBe(0)
})

test.each([false, true])("an older send ACK clears only unchanged workspace uploads after the ID changes (edited=%s)", async edited => {
  await resolveActive(0, "alpha-1")
  await attach("submitted.txt")
  await page.evaluate(() => window.landingFixture.holdSend())
  await sendAndWaitForDispatch()
  await pick("alpha", "beta")
  await pick("beta", "alpha")
  await resolveActive(2, "alpha-2")
  const submitted = page.getByText("submitted.txt", { exact: true })
  expect(await submitted.count()).toBe(1)
  if (edited) await attach("later.txt")
  await page.evaluate(() => window.landingFixture.acceptSend())
  if (!edited) await submitted.waitFor({ state: "detached" })
  expect(await submitted.count()).toBe(edited ? 1 : 0)
  expect(await page.getByText("later.txt", { exact: true }).count()).toBe(edited ? 1 : 0)
})

test("an upload resolving after discard cannot write into the reacquired folder's draft", async () => {
  await resolveActive(0, "alpha-1")
  let hold!: (route: Route) => void
  const oldRequest = new Promise<Route>(resolve => { hold = resolve })
  await page.route("**/projects/project-alpha-1/uploads", hold)
  await page.locator('input[type="file"]').setInputFiles({ name: "abandoned.txt", mimeType: "text/plain", buffer: Buffer.from("x") })
  const obsolete = await oldRequest
  await pick("alpha", "beta")
  await pick("beta", "alpha")
  await resolveActive(2, "alpha-2")
  await attach("current.txt")
  const staleUrl = "/api/projects/project-alpha-1/uploads/abandoned.txt"
  // The receipt endpoint can return HTTP 200 without unlinking anything
  // (for example, the workspace file was edited while the POST was in flight).
  await page.route(`**${staleUrl}`, route => route.fulfill({ json: { ok: false } }))
  const cleanup = page.waitForResponse(response => response.request().method() === "DELETE")
  await obsolete.fulfill({ json: { attachments: [{
    id: "late", displayName: "abandoned.txt", kind: "file", absolutePath: "/fixture/alpha/.memosync/uploads/abandoned.txt",
    relativePath: "./.memosync/uploads/abandoned.txt", contentUrl: `${staleUrl}/content`, mimeType: "text/plain", size: 1,
  }], cleanupReceipts: { late: "fixture-receipt" } } })
  const response = await cleanup
  const request = response.request()
  expect(new URL(request.url()).pathname).toBe(staleUrl)
  expect(await request.headerValue("X-MemoSync-Upload-Receipt")).toBe("fixture-receipt")
  expect(await response.json()).toEqual({ ok: false })
  await pick("alpha", "saved")
  await pick("saved", "alpha")
  await resolveActive(4, "alpha-3")
  expect(await page.getByText("current.txt", { exact: true }).count()).toBe(1)
  expect(await page.getByText("abandoned.txt", { exact: true }).count()).toBe(0)
  expect(await page.evaluate(key => localStorage.getItem(key), DELETED_UPLOAD_NOTIFICATION)).toBeNull()
})
