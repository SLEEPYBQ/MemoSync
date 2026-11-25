import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Page } from "playwright"
import type { ChatAttachment, ChatSnapshot, ProviderCatalogEntry, TranscriptEntry } from "../../shared/types"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deleteProjectUpload, persistProjectUpload, resolveExistingProjectUpload } from "../../server/uploads"
import { PROVIDERS } from "../../shared/types"
import { startMountedRaceHarness } from "../test-utils/mountedRaceHarness"

interface AppStateFixtureApi {
  createdBranchBases: () => string[]
  transcriptRevision: () => number
  streamingText: () => string | null
  promptContents: () => string[]
  chatSubscriptionCount: (chatId: string) => number
  emitChat: (chatId: string, subscriptionIndex: number, snapshot: unknown) => void
  historyRequestCount: () => number
  historyRequest: (index: number) => { type: string; chatId?: string; beforeCursor?: string } | undefined
  resolveHistory: (index: number, page: unknown) => void
  rejectHistory: (index: number, reason: string) => void
  setChatId: (chatId: string | null) => void
  send: (content: string, draft?: { chatId: string; projectId: string }) => void
  sendFromPath: (content: string) => void
  sendCount: () => number
  sentAttachments: (index: number) => ChatAttachment[]
  acceptedSends: () => number
  resolveSend: (index: number, chatId: string) => void
  rejectSend: (index: number) => void
  location: () => string
  runtimeStatus: () => string | null
  activeProjectId: () => string | null
  projectCount: () => number
  resolveProject: (index: number, projectId: string) => void
  ask: () => Promise<string>
  ackQueuedSend: () => void
}

interface RenderedAppState {
  activeChatId: string | null
  snapshotChatId: string | null
  transcriptIds: string[]
  queuedIds: string[]
  isProcessing: boolean
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  commandError: string | null
}

let harness: Awaited<ReturnType<typeof startMountedRaceHarness>>
let page: Page | undefined

beforeAll(async () => {
  harness = await startMountedRaceHarness()
})

afterEach(async () => {
  await page?.close()
  page = undefined
})

afterAll(async () => {
  await harness?.close()
})

async function openFixture(withClock = false) {
  page = await harness.openPage("app-state")
  if (withClock) {
    // Start the tested document with controlled timers, before its React code runs.
    await page.clock.install({ time: "2026-01-01T00:00:00Z" })
    await page.reload()
  }
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="app-state"]')?.textContent
    return Boolean(text && JSON.parse(text).activeChatId === "chat-a")
  })
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture
    return fixture.chatSubscriptionCount("chat-a") === 1
  })
  return page
}

function prompt(id: string): TranscriptEntry {
  return {
    _id: id,
    createdAt: 1,
    kind: "user_prompt",
    content: `content-${id}`,
    attachments: [],
  } as TranscriptEntry
}

function snapshot(
  chatId: string,
  olderCursor: string | null,
  hasOlder: boolean,
  ids: string[],
): ChatSnapshot {
  return {
    runtime: {
      chatId,
      projectId: `project-${chatId}`,
      localPath: `/fixture/${chatId}`,
      title: chatId,
      status: "idle",
      isDraining: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      streamingText: null,
    },
    queuedMessages: [],
    messages: ids.map(prompt),
    memoryRecordMessages: ids.map(prompt),
    history: { hasOlder, olderCursor, recentLimit: 25 },
    availableProviders: PROVIDERS as ProviderCatalogEntry[],
  } as unknown as ChatSnapshot
}

function historyPage(ids: string[], olderCursor: string | null, hasOlder: boolean) {
  return { messages: ids.map(prompt), olderCursor, hasOlder }
}

function numberedIds(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => `message-${start + index}`)
}

async function expectTranscript(target: Page, ids: string[]) {
  await target.waitForFunction((expected) => {
    const text = document.querySelector('[data-testid="app-state"]')?.textContent
    return Boolean(text && JSON.stringify(JSON.parse(text).transcriptIds) === JSON.stringify(expected))
  }, ids)
  expect((await readState(target)).transcriptIds).toEqual(ids)
}

async function expectHistoryCount(target: Page, count: number) {
  await target.waitForFunction((expected) => (
    window as unknown as { __appStateFixture: AppStateFixtureApi }
  ).__appStateFixture.historyRequestCount() === expected, count)
}

test("a retained Files draft is confirmed before logout; cancel and a failed request preserve it", async () => {
  const target = await openFixture()
  await target.route("**/files?dir=*", route => route.fulfill({
    json: { data: { dir: "", entries: [{ name: "note.txt", kind: "file", size: 4 }] } },
  }))
  await target.route("**/files/note.txt/content?editor=1", route => route.fulfill({
    body: "base", headers: { etag: '"base"' },
  }))
  let requests = 0
  let holdFirstRequest = false
  const release = Promise.withResolvers<void>()
  await target.route("**/auth/logout", async route => {
    requests++
    if (requests === 1 && holdFirstRequest) await release.promise
    return route.fulfill({ status: requests === 1 ? 503 : 200, json: {} })
  })
  const toggle = target.getByRole("button", { name: "Toggle Files" })
  const signOut = target.getByRole("button", { name: "Sign out", exact: true })
  await toggle.click()
  await target.getByRole("button", { name: "note.txt" }).click()
  await target.locator(".cm-content").fill("edit before sign-out")
  await target.getByTitle("Unsaved changes — close").waitFor()
  await toggle.click()
  await signOut.click()
  const dialog = target.getByRole("dialog")
  await dialog.waitFor()
  expect(requests).toBe(0)
  const cancel = dialog.getByRole("button", { name: "Cancel" })
  await target.waitForFunction(() => document.activeElement?.closest('[role="dialog"]') && document.activeElement.textContent === "Cancel")
  await cancel.press("Enter")
  await toggle.click()
  expect(await target.locator(".cm-content").innerText()).toBe("edit before sign-out")
  await toggle.click()
  expect(requests).toBe(0)
  holdFirstRequest = true
  await signOut.click()
  await dialog.getByRole("button", { name: "Discard edits and sign out" }).press("Enter")
  await target.waitForFunction(() => document.body.inert)
  expect(await target.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true)
  release.resolve()
  await target.waitForFunction(() => document.querySelector('[data-testid="app-state"]')?.textContent?.includes("503"))
  expect(requests).toBe(1)
  expect(await target.evaluate(() => document.body.inert)).toBe(false)
  expect(await target.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true)
  await toggle.click()
  expect(await target.locator(".cm-content").innerText()).toBe("edit before sign-out")
  await toggle.click()
  let unloadPrompts = 0
  target.on("dialog", native => { unloadPrompts++; void native.accept() })
  await signOut.click()
  await Promise.all([
    target.waitForEvent("framenavigated", frame => frame === target.mainFrame()),
    dialog.getByRole("button", { name: "Discard edits and sign out" }).click(),
  ])
  expect(requests).toBe(2)
  expect(unloadPrompts).toBe(0)
})

test("Enter chooses the current branch by default and respects an explicitly focused alternative", async () => {
  const target = await openFixture()
  for (const [index, selectAlternative] of [false, true].entries()) {
    await target.getByRole("button", { name: "Create branch" }).click()
    const input = target.getByPlaceholder("feature/my-branch")
    await input.fill(`feature/synthetic-${index}`)
    await input.press("Enter")
    const dialog = target.getByRole("dialog", { name: "Branch Base" })
    await dialog.waitFor()
    await target.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement))
    if (selectAlternative) await dialog.getByRole("button", { name: "From main" }).focus()
    await target.keyboard.press("Enter")
    await target.waitForFunction(n => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.createdBranchBases().length === n, index + 1)
  }
  expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.createdBranchBases()))
    .toEqual(["feature/current", "main"])
})

async function emitChat(target: Page, chatId: string, subscriptionIndex: number, value: ChatSnapshot) {
  await target.evaluate(
    ({ chatId, subscriptionIndex, value }) => {
      const fixture = (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture
      fixture.emitChat(chatId, subscriptionIndex, value)
    },
    { chatId, subscriptionIndex, value }
  )
  await target.waitForFunction(
    ({ chatId }) => {
      const text = document.querySelector('[data-testid="app-state"]')?.textContent
      return Boolean(text && JSON.parse(text).snapshotChatId === chatId)
    },
    { chatId }
  )
}

async function readState(target: Page): Promise<RenderedAppState> {
  return target.locator('[data-testid="app-state"]').evaluate((element) => JSON.parse(element.textContent ?? "{}"))
}

async function activateChat(target: Page, chatId: "chat-a" | "chat-b", subscriptionIndex: number) {
  await target.getByTestId(chatId === "chat-a" ? "activate-chat-a" : "activate-chat-b").click()
  await target.waitForFunction(
    ({ chatId, subscriptionIndex }) => {
      const fixture = (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture
      return fixture.chatSubscriptionCount(chatId) > subscriptionIndex
    },
    { chatId, subscriptionIndex }
  )
}

async function loadHistory(target: Page) {
  await target.getByTestId("load-history").click()
  await target.waitForFunction(() => {
    const text = document.querySelector('[data-testid="app-state"]')?.textContent
    return Boolean(text && JSON.parse(text).isHistoryLoading)
  })
}

async function historyCount(target: Page) {
  return target.evaluate(() => (
    window as unknown as { __appStateFixture: AppStateFixtureApi }
  ).__appStateFixture.historyRequestCount())
}

async function settleHistory(target: Page, index: number, result: unknown) {
  await target.evaluate(
    ({ index, result }) => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.resolveHistory(index, result),
    { index, result }
  )
}

async function rejectHistory(target: Page, index: number, reason: string) {
  await target.evaluate(
    ({ index, reason }) => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.rejectHistory(index, reason),
    { index, reason }
  )
}

async function openLanding() {
  page = await harness.openPage("landing")
  await page.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.chatSubscriptionCount("draft-alpha") > 0)
  return page
}

async function pickProject(target: Page, from: string, to: string) {
  await target.getByRole("button", { name: from, exact: true }).click()
  await target.getByRole("button", { name: `${to} /fixture/${to}`, exact: true }).click()
  await target.getByRole("button", { name: to, exact: true }).waitFor()
}

test.each([false, true])("an old landing send cannot redirect after picking another folder (return to A=%s)", async returnToA => {
  const target = await openLanding()
  const input = target.locator("textarea")
  await input.fill("Alpha fixture send")
  await target.getByRole("button", { name: "Send", exact: true }).click()
  await pickProject(target, "alpha", "beta")
  if (returnToA) await pickProject(target, "beta", "alpha")
  const selected = returnToA ? "alpha" : "beta"
  await input.fill("New selection's draft")
  await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(0, "draft-alpha"))
  await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.acceptedSends() === 1)
  expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location())).toBe("/")
  expect(await input.inputValue()).toBe("New selection's draft")
  await target.getByRole("button", { name: selected, exact: true }).waitFor()
  await target.getByRole("button", { name: "Send", exact: true }).click()
  await target.evaluate(id => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(1, id), `new-${selected}`)
  await target.getByRole("link", { name: "Back to landing" }).waitFor()
  expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location())).toBe(`/chat/new-${selected}`)
})

async function withLandingUploads(
  target: Page,
  projectId: string,
  run: (uploads: { attach: (name: string) => Promise<void>; deleted: string[]; folder: string }) => Promise<void>,
) {
  const folder = await mkdtemp(join(tmpdir(), "memosync-landing-upload-"))
  const deleted: string[] = []
  try {
    await target.route(`**/api/projects/${projectId}/uploads**`, async route => {
      const request = route.request()
      if (request.method() === "POST") {
        const form = await new Response(request.postDataBuffer(), { headers: request.headers() }).formData()
        const file = form.get("files") as File
        const attachment = await persistProjectUpload({
          localPath: folder, projectId, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
        })
        // The browser sees the synthetic workspace; its bytes live only in this test's temp directory.
        return route.fulfill({ json: { attachments: [{ ...attachment, absolutePath: `/fixture/${projectId}/${attachment.relativePath.slice(2)}` }] } })
      }
      const storedName = decodeURIComponent(new URL(request.url()).pathname.split("/uploads/")[1].split("/")[0])
      if (request.method() === "DELETE") {
        deleted.push(storedName)
        return route.fulfill({ json: { ok: await deleteProjectUpload({ localPath: folder, storedName }) } })
      }
      const file = await resolveExistingProjectUpload(folder, storedName)
      return route.fulfill({ status: file.ok ? 200 : 404, body: file.ok ? await Bun.file(file.path).text() : "" })
    })
    const attach = async (name: string) => {
      await target.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`fixture bytes: ${name}`) })
      await target.getByRole("button", { name: `Remove ${name}`, exact: true }).waitFor()
      await target.locator('button[aria-label="Send"]:enabled').waitFor()
    }
    await run({ attach, deleted, folder })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

test("a landing upload remains removable when project.open fails before chat.send", async () => {
  const target = await openLanding()
  await pickProject(target, "alpha", "unavailable")
  await withLandingUploads(target, "unavailable", async ({ attach, deleted, folder }) => {
    await attach("unsent.txt")
    await target.getByRole("button", { name: "Send", exact: true }).click()
    await target.getByText("Fixture project open failed", { exact: true }).waitFor()
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount())).toBe(0)
    const stored = await resolveExistingProjectUpload(folder, "unsent.txt")
    expect(stored.ok && await Bun.file(stored.path).text()).toBe("fixture bytes: unsent.txt")

    const remove = target.getByRole("button", { name: "Remove unsent.txt", exact: true })
    const [response] = await Promise.all([
      target.waitForResponse(r => r.request().method() === "DELETE" && new URL(r.url()).pathname === "/api/projects/unavailable/uploads/unsent.txt"),
      remove.click(),
    ])
    await remove.waitFor({ state: "detached" })
    expect(await response.json()).toEqual({ ok: true })
    expect(deleted).toEqual(["unsent.txt"])
    expect((await resolveExistingProjectUpload(folder, "unsent.txt")).ok).toBe(false)
  })
})

test.each([false, true])("an edited landing draft retires the sent upload without losing its bytes (later file=%s)", async laterFile => {
  const target = await openLanding()
  await withLandingUploads(target, "alpha", async ({ attach, deleted }) => {
    const input = target.locator("textarea")
    await input.fill("First synthetic send")
    await attach("notes.txt")
    const staleDraft = await target.evaluate(() => localStorage.getItem("chat-input-drafts")!)
    await target.getByRole("button", { name: "Send", exact: true }).click()
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 1)
    const contentUrl = await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sentAttachments(0)[0].contentUrl)
    await input.fill("Next synthetic draft")
    if (laterFile) await attach("later.txt")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(0, "draft-alpha"))
    await target.getByRole("link", { name: "Back to landing" }).click()
    await target.getByRole("button", { name: "alpha", exact: true }).waitFor()
    expect(await input.inputValue()).toBe("Next synthetic draft")
    const sentChip = target.getByRole("button", { name: "Remove notes.txt" })
    const restoredAfterAck = await sentChip.count()
    if (restoredAfterAck) await sentChip.click()
    if (laterFile) {
      await Promise.all([
        target.waitForResponse(r => r.request().method() === "DELETE" && new URL(r.url()).pathname.endsWith("/later.txt")),
        target.getByRole("button", { name: "Remove later.txt" }).click(),
      ])
    }
    // A stale window or an earlier client can still have the old draft. Removing
    // its chip must not unlink the very URL captured from the accepted chat.send.
    await target.evaluate(stale => localStorage.setItem("chat-input-drafts", stale), staleDraft)
    await target.reload()
    await sentChip.click()
    await sentChip.waitFor({ state: "detached" })
    const response = await target.evaluate(async url => {
      const r = await fetch(url)
      return [r.status, await r.text()]
    }, contentUrl)
    expect(response).toEqual([200, "fixture bytes: notes.txt"])
    expect(restoredAfterAck).toBe(0)
    expect(deleted).toEqual(laterFile ? ["later.txt"] : [])
  })
})

test("migrating legacy landing attachments in one tab keeps another tab's newer draft", async () => {
  const first = await openLanding()
  await pickProject(first, "alpha", "beta")
  // Both tabs sit on project beta before either edits anything.
  let second: Page | undefined
  try {
    ;[second] = await Promise.all([
      first.waitForEvent("popup"),
      first.evaluate(() => { window.open("about:blank", "_blank") }),
    ])
    second.setDefaultTimeout(5_000)
    // Popups share the opener's storage but not its network routes.
    await second.route("**/api/providers", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: PROVIDERS }),
    }))
    await second.goto(first.url())
    await second.getByTestId("fixture-ready").waitFor({ state: "attached" })
    await second.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi })?.__appStateFixture?.chatSubscriptionCount("draft-alpha") > 0)
    await pickProject(second, "alpha", "beta")

    // The first tab now writes a newer draft the second tab's memory never sees.
    await first.locator("textarea").fill("fresh text only the first tab has")
    await first.waitForFunction(() => localStorage.getItem("chat-input-drafts")?.includes("fresh text only the first tab has"))

    // A pre-upgrade snapshot kept its landing attachments under the project id.
    await first.evaluate(() => {
      const key = "chat-input-drafts"
      const persisted = JSON.parse(localStorage.getItem(key) ?? '{"state":{},"version":0}')
      persisted.state.attachmentDrafts = {
        ...(persisted.state.attachmentDrafts ?? {}),
        "landing:alpha": [{
          id: "legacy-chip", kind: "file", displayName: "legacy.txt",
          absolutePath: "/fixture/alpha/.memosync/uploads/legacy.txt",
          relativePath: "./.memosync/uploads/legacy.txt",
          contentUrl: "/api/projects/alpha/uploads/legacy.txt/content",
          mimeType: "text/plain", size: 1,
        }],
      }
      localStorage.setItem(key, JSON.stringify(persisted))
    })

    // Navigating the second tab to the legacy project migrates that bucket.
    await pickProject(second, "beta", "alpha")
    await second.waitForFunction(() => {
      const persisted = JSON.parse(localStorage.getItem("chat-input-drafts") ?? "{}")
      return persisted.state?.attachmentDrafts?.["landing:path:/fixture/alpha"]?.some((item: { id: string }) => item.id === "legacy-chip")
    })

    const persisted = await second.evaluate(() => JSON.parse(localStorage.getItem("chat-input-drafts")!) as {
      state: { drafts: Record<string, string>; attachmentDrafts: Record<string, Array<{ id: string }>> }
    })
    // The migration merged only its own keys; the first tab's newer text survived.
    expect(Object.values(persisted.state.drafts)).toContain("fresh text only the first tab has")
    expect(persisted.state.attachmentDrafts["landing:alpha"] ?? []).toEqual([])

    // Reloading the first tab restores its own edit, not an empty composer.
    await first.reload()
    await first.getByTestId("fixture-ready").waitFor({ state: "attached" })
    await first.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi })?.__appStateFixture?.chatSubscriptionCount("draft-alpha") > 0)
    await pickProject(first, "alpha", "beta")
    expect(await first.locator("textarea").inputValue()).toBe("fresh text only the first tab has")
  } finally {
    await second?.close()
  }
})

describe("mounted useAppState history races", () => {
  test("a late landing ACK cannot redirect or replace a newer send", async () => {
    const target = await openFixture()
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.send("first", { chatId: "draft-a", projectId: "project-a" }))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 1)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId("chat-b"))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === "chat-b")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.send("second"))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 2)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(0, "draft-a"))
    await target.waitForTimeout(100)
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location())).toBe("/")
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.runtimeStatus())).toBe("starting")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(1, "chat-b"))
  })

  test("a landing ACK redirects when the same view is still current", async () => {
    const target = await openFixture()
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.send("first", { chatId: "draft-a", projectId: "project-a" }))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 1)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(0, "draft-a"))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location() === "/chat/draft-a")
  })

  test("a previous landing visit cannot redirect a later visit or settle its processing", async () => {
    const target = await openFixture()
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.send("first", { chatId: "draft-a", projectId: "project-a" }))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 1)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId("chat-b"))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === "chat-b")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.send("second", { chatId: "draft-b", projectId: "project-b" }))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 2)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(0, "draft-a"))
    await target.waitForTimeout(100)
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location())).toBe("/")
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.runtimeStatus())).toBe("starting")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(1, "draft-b"))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location() === "/chat/draft-b")
  })

  test("an unresolved chat never displays Git from the previously selected project", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", null, false, []))
    const branch = target.getByTestId("diff-branch")
    await branch.filter({ hasText: "branch-project-chat-a" }).waitFor()

    await activateChat(target, "chat-b", 0)
    expect(await branch.textContent()).toBe("")
    await emitChat(target, "chat-b", 0, snapshot("chat-b", null, false, []))
    await branch.filter({ hasText: "branch-project-chat-b" }).waitFor()
  })

  test("late project.open cannot replace the new chat's selected project", async () => {
    const target = await openFixture()
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendFromPath("first"))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.projectCount() === 1)
    await activateChat(target, "chat-b", 0)
    await emitChat(target, "chat-b", 0, snapshot("chat-b", null, false, []))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.activeProjectId() === "project-chat-b")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveProject(0, "project-a"))
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.sendCount() === 1)
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.activeProjectId())).toBe("project-chat-b")
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.resolveSend(0, "draft-a"))
    await target.waitForTimeout(50)
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.location())).toBe("/")
  })

  test("an answer with no active chat rejects rather than appearing submitted", async () => {
    const target = await openFixture()
    await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.setChatId(null))
    await target.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).activeChatId === null)
    expect(await target.evaluate(() => (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.ask())).toBe("No active chat")
  })

  test.each(["ack first", "removed before ack", "dispatched before ack"])("queued send: %s", async timing => {
    const target = await openFixture(true)
    const baseline = snapshot("chat-a", null, false, ["existing"])
    await emitChat(target, "chat-a", 0, baseline)
    // React may commit asynchronously; application timers must not advance.
    // In particular the ordinary send ACK's 300 ms idle fallback cannot help.
    await target.clock.pauseAt("2026-01-01T01:00:00Z")
    await target.getByTestId("send-prompt").click()
    await target.waitForFunction(() => (window as unknown as { __appStateFixture: AppStateFixtureApi })
      .__appStateFixture.promptContents().length === 2)
    const ack = async () => {
      expect((await readState(target)).isProcessing).toBe(true)
      const atAck = await target.evaluate(() => {
        (window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture.ackQueuedSend()
        return performance.now()
      })
      await target.waitForFunction(() => !JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!).isProcessing)
      expect(await target.evaluate(() => performance.now())).toBe(atAck)
    }
    const waitForQueue = (ids: string[]) => target.waitForFunction(expected => {
      const state: RenderedAppState = JSON.parse(document.querySelector('[data-testid="app-state"]')!.textContent!)
      return JSON.stringify(state.queuedIds) === JSON.stringify(expected)
    }, ids)
    if (timing === "ack first") { await ack(); await expectTranscript(target, ["existing"]) }
    const row = { id: "queued-row", content: "content-existing", attachments: [], createdAt: 2 }
    await emitChat(target, "chat-a", 0, { ...baseline, queuedMessages: [row] })
    await waitForQueue([row.id])
    // This snapshot could be a deletion or FIFO dispatch from another window.
    const dispatched = timing === "dispatched before ack"
    const messages = dispatched
      ? [...baseline.messages, { ...baseline.messages[0]!, _id: row.id }]
      : baseline.messages
    await emitChat(target, "chat-a", 0, { ...baseline, messages })
    await waitForQueue([])
    if (timing !== "ack first") await ack()
    await expectTranscript(target, dispatched ? ["existing", row.id] : ["existing"])
    expect((await readState(target)).queuedIds).toEqual([])
  })

  test("keeps paged transcript identity during streaming while retaining same-ID content changes", async () => {
    const target = await openFixture()
    const recent = snapshot("chat-a", "idx:100", true, numberedIds(100, 125))
    await emitChat(target, "chat-a", 0, recent)
    await loadHistory(target)
    await settleHistory(target, 0, historyPage(numberedIds(0, 100), null, false))
    await expectTranscript(target, numberedIds(0, 125))
    const baseline = await target.evaluate(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.transcriptRevision())

    for (const streamingText of ["stream one", "stream two", "stream three"]) {
      await emitChat(target, "chat-a", 0, {
        ...recent,
        runtime: { ...recent.runtime, streamingText },
      })
      await target.waitForFunction((expected) => (
        window as unknown as { __appStateFixture: AppStateFixtureApi }
      ).__appStateFixture.streamingText() === expected, streamingText)
      expect(await target.evaluate(() => (
        window as unknown as { __appStateFixture: AppStateFixtureApi }
      ).__appStateFixture.transcriptRevision())).toBe(baseline)
    }
    expect(await historyCount(target)).toBe(1)

    const edited = snapshot("chat-a", "idx:100", true, numberedIds(100, 125))
    edited.runtime.streamingText = "stream three"
    edited.messages[0] = { ...prompt("message-100"), content: "Updated existing prompt" } as TranscriptEntry
    await emitChat(target, "chat-a", 0, edited)
    await target.waitForFunction(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.promptContents().includes("Updated existing prompt"))
    expect(await target.evaluate(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.transcriptRevision())).toBeGreaterThan(baseline)
    await expectTranscript(target, numberedIds(0, 125))
  })

  test.each(["during", "after"] as const)("preserves evicted recent entries when the window moves %s pagination", async (timing) => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:5", true, numberedIds(5, 30)))
    await loadHistory(target)
    if (timing === "after") {
      await settleHistory(target, 0, historyPage(numberedIds(0, 5), null, false))
      await expectTranscript(target, numberedIds(0, 30))
    }
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:6", true, numberedIds(6, 31)))
    if (timing === "during") {
      await settleHistory(target, 0, historyPage(numberedIds(0, 5), null, false))
    }
    await expectTranscript(target, numberedIds(0, 31))
    expect((await readState(target)).hasOlderHistory).toBe(false)
    expect(await historyCount(target)).toBe(1)
  })

  test("backfills disjoint live windows in order without resetting exhausted older history", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:5", true, numberedIds(5, 30)))
    await loadHistory(target)
    await settleHistory(target, 0, historyPage(numberedIds(0, 5), null, false))
    await expectTranscript(target, numberedIds(0, 30))

    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:225", true, numberedIds(225, 250)))
    await expectHistoryCount(target, 2)
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:226", true, numberedIds(226, 251)))
    await settleHistory(target, 1, historyPage(numberedIds(125, 225), "idx:125", true))
    await expectHistoryCount(target, 3)
    await settleHistory(target, 2, historyPage(numberedIds(25, 125), "idx:25", true))

    await expectTranscript(target, numberedIds(0, 251))
    expect((await readState(target)).hasOlderHistory).toBe(false)
    expect(await historyCount(target)).toBe(3)
    expect(await target.getByTestId("load-history").isDisabled()).toBe(true)
  })

  test.each(["switch", "reset"] as const)("discards a live-window backfill after a chat %s", async (action) => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:5", true, numberedIds(5, 30)))
    await loadHistory(target)
    await settleHistory(target, 0, historyPage(numberedIds(0, 5), null, false))
    await expectTranscript(target, numberedIds(0, 30))
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:40", true, numberedIds(40, 65)))
    await expectHistoryCount(target, 2)

    if (action === "switch") {
      await activateChat(target, "chat-b", 0)
      await emitChat(target, "chat-b", 0, snapshot("chat-b", null, false, ["b-only"]))
    } else {
      await target.evaluate(() => (
        window as unknown as { __appStateFixture: AppStateFixtureApi }
      ).__appStateFixture.emitChat("chat-a", 0, null))
      await emitChat(target, "chat-a", 0, snapshot("chat-a", null, false, ["a-reset"]))
    }
    await settleHistory(target, 1, historyPage(numberedIds(0, 40), null, false))
    await expectTranscript(target, [action === "switch" ? "b-only" : "a-reset"])
    expect((await readState(target)).commandError).toBeNull()
  })

  test("uses the current snapshot boundary when pagination starts before React rerenders", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "idx:5", true, numberedIds(5, 30)))
    await target.evaluate((value) => {
      (window as unknown as { __appStateFixture: AppStateFixtureApi })
        .__appStateFixture.emitChat("chat-a", 0, value)
      document.querySelector<HTMLButtonElement>('[data-testid="load-history"]')!.click()
    }, snapshot("chat-a", "idx:6", true, numberedIds(6, 31)))
    await expectHistoryCount(target, 1)
    const request = await target.evaluate(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.historyRequest(0))
    expect(request?.beforeCursor).toBe("idx:6")
    await settleHistory(target, 0, historyPage(numberedIds(0, 6), null, false))
    await expectTranscript(target, numberedIds(0, 31))
  })

  test("discards a late successful A page while B owns a pending page", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "a-c90", true, ["a-recent"]))
    await loadHistory(target)

    await activateChat(target, "chat-b", 0)
    await emitChat(target, "chat-b", 0, snapshot("chat-b", "b-c90", true, ["b-recent"]))
    await loadHistory(target)
    expect(await historyCount(target)).toBe(2)

    await settleHistory(target, 0, historyPage(["a-old"], "a-c80", true))
    const duringB = await readState(target)
    expect(duringB).toEqual({
      activeChatId: "chat-b",
      snapshotChatId: "chat-b",
      transcriptIds: ["b-recent"],
      queuedIds: [],
      isProcessing: false,
      isHistoryLoading: true,
      hasOlderHistory: true,
      commandError: null,
    })

    await settleHistory(target, 1, historyPage(["b-old"], "b-c80", true))
    await target.waitForFunction(() => {
      const text = document.querySelector('[data-testid="app-state"]')?.textContent
      return Boolean(text && !JSON.parse(text).isHistoryLoading)
    })
    expect((await readState(target)).transcriptIds).toEqual(["b-old", "b-recent"])

    await loadHistory(target)
    const nextRequest = await target.evaluate(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.historyRequest(2))
    expect(nextRequest).toEqual({ type: "chat.loadHistory", chatId: "chat-b", beforeCursor: "b-c80" })
  })

  test("discards a late failed A page without publishing its error to B", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "a-c90", true, ["a-recent"]))
    await loadHistory(target)

    await activateChat(target, "chat-b", 0)
    await emitChat(target, "chat-b", 0, snapshot("chat-b", "b-c90", true, ["b-recent"]))
    await loadHistory(target)

    await rejectHistory(target, 0, "stale A failure")
    expect(await readState(target)).toEqual({
      activeChatId: "chat-b",
      snapshotChatId: "chat-b",
      transcriptIds: ["b-recent"],
      queuedIds: [],
      isProcessing: false,
      isHistoryLoading: true,
      hasOlderHistory: true,
      commandError: null,
    })

    await settleHistory(target, 1, historyPage(["b-old"], "b-c80", true))
    await target.waitForFunction(() => {
      const text = document.querySelector('[data-testid="app-state"]')?.textContent
      return Boolean(text && !JSON.parse(text).isHistoryLoading)
    })
    await loadHistory(target)
    const nextRequest = await target.evaluate(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.historyRequest(2))
    expect(nextRequest).toEqual({ type: "chat.loadHistory", chatId: "chat-b", beforeCursor: "b-c80" })
  })

  test("does not let an old A request settle a newer A request after A-to-B-to-A", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "a-first", true, ["a-recent"]))
    await loadHistory(target)

    await activateChat(target, "chat-b", 0)
    await emitChat(target, "chat-b", 0, snapshot("chat-b", "b-first", true, ["b-recent"]))
    await activateChat(target, "chat-a", 1)
    await emitChat(target, "chat-a", 1, snapshot("chat-a", "a-second", true, ["a-current"]))
    await loadHistory(target)

    await settleHistory(target, 0, historyPage(["a-stale-page"], "a-stale-cursor", false))
    expect(await readState(target)).toEqual({
      activeChatId: "chat-a",
      snapshotChatId: "chat-a",
      transcriptIds: ["a-current"],
      queuedIds: [],
      isProcessing: false,
      isHistoryLoading: true,
      hasOlderHistory: true,
      commandError: null,
    })

    await settleHistory(target, 1, historyPage(["a-fresh-page"], "a-fresh-cursor", true))
    await target.waitForFunction(() => {
      const text = document.querySelector('[data-testid="app-state"]')?.textContent
      return Boolean(text && !JSON.parse(text).isHistoryLoading)
    })
    expect((await readState(target)).transcriptIds).toEqual(["a-fresh-page", "a-current"])
  })

  test("keeps the advanced page cursor when a live snapshot repeats the older cursor", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "c90", true, ["recent"]))
    await loadHistory(target)
    await settleHistory(target, 0, historyPage(["older"], "c80", true))
    await target.waitForFunction(() => {
      const text = document.querySelector('[data-testid="app-state"]')?.textContent
      return Boolean(text && !JSON.parse(text).isHistoryLoading)
    })
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "c90", true, ["recent", "live"]))

    await loadHistory(target)
    const nextRequest = await target.evaluate(() => (
      window as unknown as { __appStateFixture: AppStateFixtureApi }
    ).__appStateFixture.historyRequest(1))
    expect(nextRequest).toEqual({ type: "chat.loadHistory", chatId: "chat-a", beforeCursor: "c80" })
  })

  test("does not revive an exhausted history boundary from a later live snapshot", async () => {
    const target = await openFixture()
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "c90", true, ["recent"]))
    await loadHistory(target)
    await settleHistory(target, 0, historyPage(["oldest"], null, false))
    await target.waitForFunction(() => {
      const text = document.querySelector('[data-testid="app-state"]')?.textContent
      return Boolean(text && !JSON.parse(text).isHistoryLoading && !JSON.parse(text).hasOlderHistory)
    })
    await emitChat(target, "chat-a", 0, snapshot("chat-a", "c90", true, ["recent", "live"]))

    expect(await readState(target)).toMatchObject({ hasOlderHistory: false, isHistoryLoading: false })
    expect(await target.getByTestId("load-history").isDisabled()).toBe(true)
    expect(await historyCount(target)).toBe(1)
  })
})
