import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page, Route } from "playwright"
import { AgentCoordinator } from "../../../server/agent"
import { EventStore } from "../../../server/event-store"
import { KeybindingsManager } from "../../../server/keybindings"
import { getProjectUploadDir } from "../../../server/paths"
import { handleProjectUpload, handleProjectUploadDelete } from "../../../server/server"
import { TerminalManager } from "../../../server/terminal-manager"
import { DraftUploadReceipts } from "../../../server/uploads"
import { createWsRouter, type ClientState } from "../../../server/ws-router"
import { startMountedRaceHarness } from "../../test-utils/mountedRaceHarness"

interface ChatInputFixtureApi {
  setChatId: (chatId: string | null) => void
  setProjectId: (projectId: string) => void
  setMounted: (mounted: boolean) => void
  submissions: () => Array<{ value: string; options: { attachments?: Array<{ id: string }> } }>
  resolveSubmit: (index: number) => void
  rejectSubmit: (index: number, reason: string) => void
  draft: (chatId: string) => string
  attachments: (chatId: string) => Array<{ id: string; displayName: string }>
  connectDraft: (url: string, draftChatId: string) => void
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

async function openFixture() {
  page = await harness.openPage("chat-input")
  await page.getByPlaceholder("Build something...").waitFor({ state: "visible" })
  return page
}

async function readDraft(target: Page, chatId: string) {
  return target.evaluate(
    (id) => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.draft(id),
    chatId
  )
}

async function readAttachments(target: Page, chatId: string) {
  return target.evaluate(
    (id) => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.attachments(id),
    chatId
  )
}

async function submissions(target: Page) {
  return target.evaluate(() => (
    window as unknown as { __chatInputFixture: ChatInputFixtureApi }
  ).__chatInputFixture.submissions())
}

async function settle(target: Page, index: number, success: boolean, reason = "send rejected") {
  await target.evaluate(
    ({ index, success, reason }) => {
      const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
      if (success) fixture.resolveSubmit(index)
      else fixture.rejectSubmit(index, reason)
    },
    { index, success, reason }
  )
}

async function navigate(target: Page, chatId: string) {
  await target.evaluate((id) => (
    window as unknown as { __chatInputFixture: ChatInputFixtureApi }
  ).__chatInputFixture.setChatId(id), chatId)
  await target.getByTestId("current-chat").getByText(chatId).waitFor()
}

async function attach(target: Page, fileName: string, chatId = "chat-one") {
  const currentCount = (await readAttachments(target, chatId)).length
  await target.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(fileName),
  })
  await target.waitForFunction(({ count, chatId }) => {
    const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
    return fixture.attachments(chatId).length >= count
  }, { count: currentCount + 1, chatId })
}

describe("mounted ChatInput submission races", () => {
  test("retains text and attachment edits made while a successful send is pending", async () => {
    const target = await openFixture()
    const input = target.getByPlaceholder("Build something...")
    await attach(target, "first.txt")
    await input.fill("submitted text")
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
    ))
    expect((await submissions(target))[0]).toMatchObject({ value: "submitted text" })

    await input.fill("edited text")
    await attach(target, "second.txt")
    await settle(target, 0, true)

    await expectInputValue(target, "edited text")
    expect(await readDraft(target, "chat-one")).toBe("edited text")
    expect((await readAttachments(target, "chat-one")).map((attachment) => attachment.displayName)).toEqual([
      "uploaded-1.txt",
      "uploaded-2.txt",
    ])
  })

  test("retains text and attachment edits when a pending send rejects", async () => {
    const target = await openFixture()
    const input = target.getByPlaceholder("Build something...")
    await attach(target, "first.txt")
    await input.fill("submitted text")
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
    ))

    await input.fill("edited text")
    await attach(target, "second.txt")
    await settle(target, 0, false)

    await expectInputValue(target, "edited text")
    expect(await readDraft(target, "chat-one")).toBe("edited text")
    expect((await readAttachments(target, "chat-one")).map((attachment) => attachment.displayName)).toEqual([
      "uploaded-1.txt",
      "uploaded-2.txt",
    ])
  })

  test("removing a chip before its send ACK detaches it without deleting the in-flight upload", async () => {
    const target = await openFixture()
    const deletes: string[] = []
    target.on("request", request => { if (request.method() === "DELETE") deletes.push(request.url()) })
    await attach(target, "sent.txt")
    await target.getByRole("button", { name: "Send", exact: true }).click()
    await target.getByRole("button", { name: "Remove uploaded-1.txt" }).click()
    expect(await readAttachments(target, "chat-one")).toEqual([])
    await attach(target, "unsent.txt")
    await Promise.all([
      target.waitForResponse(response => response.request().method() === "DELETE"),
      target.getByRole("button", { name: "Remove uploaded-2.txt" }).click(),
    ])
    await settle(target, 0, true)
    expect(deletes.map(url => new URL(url).pathname)).toEqual(["/api/projects/fixture/uploads/2"])
  })

  test.each([false, true])("removing a rejected landing slash upload deletes it only if no earlier reply was lost (lost reply=%s)", async loseFirstReply => {
    const target = await openFixture()
    const dir = await mkdtemp(join(tmpdir(), "memosync-upload-refusal-"))
    const store = new EventStore(join(dir, "data"))
    const receipts = new DraftUploadReceipts()
    const agent = new AgentCoordinator({ store, onStateChange() {} })
    const router = createWsRouter({
      store, agent, terminals: new TerminalManager(), keybindings: new KeybindingsManager(join(dir, "keybindings.json")),
      refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "Fixture", updateManager: null,
    })
    try {
      const workspace = join(dir, "workspace")
      await mkdir(workspace)
      await store.initialize()
      const { projectId, chatId } = await store.ensureDraft({ localPath: workspace })
      // Use the production handlers without starting discovery, reading user
      // settings or exposing a command socket outside this browser fixture.
      const deletes: string[] = []
      await target.route("**/auth/status", route => route.fulfill({ json: { enabled: false } }))
      await target.route("**/uploads**", async route => {
        const req = route.request()
        const url = new URL(req.url())
        const request = new Request(url, { method: req.method(), headers: req.headers(), body: req.postDataBuffer() })
        if (req.method() === "DELETE") deletes.push(url.pathname)
        const result = await handleProjectUpload(request, url, store, receipts) ?? await handleProjectUploadDelete(request, url, store, receipts)
        await route.fulfill({ status: result?.status ?? 404, json: await result?.json() })
      })
      let dropReply = loseFirstReply
      await target.routeWebSocket("**/refusal-ws", peer => {
        const socket = {
          data: { subscriptions: new Map(), snapshotSignatures: new Map() },
          send(raw: string) {
            if (dropReply && JSON.parse(raw).type === "error") {
              dropReply = false
              void peer.close({ code: 1001 })
            } else peer.send(raw)
            return raw.length
          },
        } as unknown as ServerWebSocket<ClientState>
        router.handleOpen(socket)
        peer.onMessage(raw => { void router.handleMessage(socket, raw.toString()) })
        peer.onClose(() => router.handleClose(socket))
      })
      await target.reload()
      await target.getByTestId("fixture-ready").waitFor({ state: "attached" })
      await target.evaluate(({ projectId, chatId }) => {
        const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
        fixture.setChatId(null)
        fixture.setProjectId(projectId)
        fixture.connectDraft(`ws://${location.host}/refusal-ws`, chatId)
      }, { projectId, chatId })
      await attach(target, "notes.txt", `landing:${projectId}`)
      const path = join(getProjectUploadDir(workspace), "notes.txt")
      expect(await Bun.file(path).text()).toBe("notes.txt")
      const input = target.locator("textarea")
      const send = target.getByRole("button", { name: "Send", exact: true })
      await input.fill("/not-a-command")
      await send.click()
      if (loseFirstReply) {
        await target.getByText("Disconnected", { exact: true }).waitFor()
        await send.click()
      }
      await target.getByText("Native commands do not accept attachments", { exact: true }).waitFor()
      expect(store.getMessages(chatId)).toEqual([])
      expect(store.getQueuedMessages(chatId)).toEqual([])
      const remove = target.getByRole("button", { name: "Remove notes.txt" })
      if (loseFirstReply) {
        await remove.click()
        await remove.waitFor({ state: "detached" })
        expect(deletes).toEqual([])
        expect(await Bun.file(path).text()).toBe("notes.txt")
      } else {
        const [deleted] = await Promise.all([target.waitForResponse(r => r.request().method() === "DELETE"), remove.click()])
        expect(await deleted.json()).toEqual({ ok: true })
        expect(deletes).toEqual([`/api/projects/${projectId}/uploads/notes.txt`])
        expect(await Bun.file(path).exists()).toBe(false)
      }
    } finally {
      await target.close()
      page = undefined
      router.dispose()
      await agent.shutdownRuntime()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("treats editing away and back as a newer draft revision", async () => {
    const target = await openFixture()
    const input = target.getByPlaceholder("Build something...")
    await input.fill("same text")
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
    ))

    await input.fill("temporary edit")
    await input.fill("same text")
    await settle(target, 0, true)

    await expectInputValue(target, "same text")
    expect(await readDraft(target, "chat-one")).toBe("same text")
  })

  test("does not let a settled send clear or restore another chat's draft", async () => {
    const target = await openFixture()
    const input = target.getByPlaceholder("Build something...")
    await attach(target, "first.txt")
    await input.fill("chat one pending")
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
    ))

    await target.evaluate(() => (
      window as unknown as { __chatInputFixture: ChatInputFixtureApi }
    ).__chatInputFixture.setChatId("chat-two"))
    await target.getByTestId("current-chat").getByText("chat-two").waitFor()
    await input.fill("chat two draft")
    await attach(target, "second.txt", "chat-two")
    await settle(target, 0, true)
    await expectInputValue(target, "chat two draft")
    expect(await readDraft(target, "chat-two")).toBe("chat two draft")
    expect(await readDraft(target, "chat-one")).toBe("")
    expect(await readAttachments(target, "chat-one")).toEqual([])
    expect(await readAttachments(target, "chat-two")).toHaveLength(1)

    await navigate(target, "chat-one")
    await expectInputValue(target, "")
    expect(await target.getByText("uploaded-1.txt", { exact: true }).count()).toBe(0)
    await navigate(target, "chat-two")
    await expectInputValue(target, "chat two draft")

    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 2
    ))
    await target.evaluate(() => (
      window as unknown as { __chatInputFixture: ChatInputFixtureApi }
    ).__chatInputFixture.setChatId("chat-one"))
    await target.getByTestId("current-chat").getByText("chat-one").waitFor()
    await input.fill("chat one new draft")
    await settle(target, 1, false)

    await expectInputValue(target, "chat one new draft")
    expect(await readDraft(target, "chat-one")).toBe("chat one new draft")
  })

  for (const edited of [false, true]) {
    test(`a remounted draft ${edited ? "keeps later edit-away-and-back" : "clears unchanged text and attachments"} on the original ACK`, async () => {
      const target = await openFixture()
      const input = target.getByPlaceholder("Build something...")
      await attach(target, "first.txt")
      await input.fill("original draft")
      await target.locator("button:has(svg.lucide-arrow-up)").click()
      await target.waitForFunction(() => (
        (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
      ))
      await navigate(target, "chat-two")
      await input.fill("other draft")
      await navigate(target, "chat-one")
      await expectInputValue(target, "original draft")
      await target.getByText("uploaded-1.txt", { exact: true }).first().waitFor()
      if (edited) {
        await input.fill("temporary edit")
        await input.fill("original draft")
        await attach(target, "second.txt")
      }
      await settle(target, 0, true)
      await expectInputValue(target, edited ? "original draft" : "")
      expect(await readDraft(target, "chat-one")).toBe(edited ? "original draft" : "")
      expect(await readAttachments(target, "chat-one")).toHaveLength(edited ? 2 : 0)
      if (!edited) expect(await target.getByText("uploaded-1.txt", { exact: true }).count()).toBe(0)
      expect(await readDraft(target, "chat-two")).toBe("other draft")
      await navigate(target, "chat-two")
      await navigate(target, "chat-one")
      await expectInputValue(target, edited ? "original draft" : "")
    })
  }

  for (const edits of [["new draft"], ["temporary edit", "original draft"]]) {
    test(`preserves remounted same-task native text edits before ACK: ${edits.join(" -> ")}`, async () => {
      const target = await openFixture()
      await target.getByPlaceholder("Build something...").fill("original draft")
      await target.locator("button:has(svg.lucide-arrow-up)").click()
      await target.waitForFunction(() => (
        (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
      ))
      await navigate(target, "chat-two")
      await navigate(target, "chat-one")
      await expectInputValue(target, "original draft")
      const persistedDuringEvents = await target.evaluate((edits) => {
        const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
        const input = document.querySelector("textarea")!
        const setNativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
        const persisted: string[] = []
        for (const text of edits) {
          setNativeValue.call(input, text)
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
          persisted.push(fixture.draft("chat-one"))
        }
        fixture.resolveSubmit(0)
        return persisted
      }, edits)
      expect(persistedDuringEvents).toEqual(edits)
      await expectInputValue(target, edits.at(-1)!)
      expect(await readDraft(target, "chat-one")).toBe(edits.at(-1)!)
    })
  }

  test("discards an old upload after keyed unmount without overwriting remounted attachments", async () => {
    const target = await openFixture()
    let holdFirst = true
    let receiveUpload!: (route: Route) => void
    const pendingUpload = new Promise<Route>((resolve) => { receiveUpload = resolve })
    await target.route("**/api/projects/fixture-project/uploads", async (route) => {
      if (holdFirst && route.request().method() === "POST") {
        holdFirst = false
        receiveUpload(route)
        return
      }
      await route.fallback()
    })
    await target.locator('input[type="file"]').setInputFiles({
      name: "old.txt", mimeType: "text/plain", buffer: Buffer.from("old"),
    })
    const oldUpload = await pendingUpload
    await navigate(target, "chat-two")
    await navigate(target, "chat-one")
    await attach(target, "new.txt")
    const newerAttachments = await readAttachments(target, "chat-one")
    expect(newerAttachments).toHaveLength(1)
    const settlement = Promise.race([
      target.waitForRequest((request) => request.method() === "DELETE" && request.url().includes("stale-upload"))
        .then(() => "deleted"),
      target.waitForFunction(() => (
        window as unknown as { __chatInputFixture: ChatInputFixtureApi }
      ).__chatInputFixture.attachments("chat-one").some(({ id }) => id === "stale-upload"))
        .then(() => "overwritten"),
    ])
    await oldUpload.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ attachments: [{
        id: "stale-upload", kind: "file", displayName: "old.txt", absolutePath: "/fixture/old.txt",
        relativePath: "old.txt", contentUrl: "/api/projects/fixture-project/uploads/stale-upload/content",
        mimeType: "text/plain", size: 3,
      }] }),
    })
    expect(await settlement).toBe("deleted")
    expect(await readAttachments(target, "chat-one")).toEqual(newerAttachments)
    await navigate(target, "chat-two")
    await navigate(target, "chat-one")
    await target.getByText(newerAttachments[0].displayName, { exact: true }).first().waitFor()
    expect(await readAttachments(target, "chat-one")).toEqual(newerAttachments)
  })

  test("allows only one same-tick submit and accepts another after settlement", async () => {
    const target = await openFixture()
    const input = target.getByPlaceholder("Build something...")
    await input.fill("first message")
    await target.locator("button:has(svg.lucide-arrow-up)").evaluate((button) => {
      const event = () => new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 })
      button.dispatchEvent(event())
      button.dispatchEvent(event())
    })
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length > 0
    ))
    expect((await submissions(target)).map(({ value }) => value)).toEqual(["first message"])

    await settle(target, 0, true)
    await expectInputValue(target, "")
    await input.fill("second message")
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 2
    ))
    expect((await submissions(target)).map(({ value }) => value)).toEqual(["first message", "second message"])
    await settle(target, 1, true)
  })

  test("clears an unchanged accepted draft", async () => {
    const target = await openFixture()
    const input = target.getByPlaceholder("Build something...")
    await input.fill("accepted unchanged")
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (
      (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1
    ))
    await settle(target, 0, true)

    await expectInputValue(target, "")
    expect(await readDraft(target, "chat-one")).toBe("")
  })

  test("keeps landing attachments by project across remounts and clears only the accepted project", async () => {
    const target = await openFixture()
    await target.evaluate(() => {
      const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
      fixture.setChatId(null)
      fixture.setProjectId("project-a")
    })
    await attach(target, "a.txt", "landing:project-a")
    await target.evaluate(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.setProjectId("project-b"))
    await attach(target, "b.txt", "landing:project-b")
    await target.evaluate(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.setProjectId("project-a"))
    await target.getByText("uploaded-1.txt", { exact: true }).first().waitFor()
    expect(await target.getByText("uploaded-2.txt", { exact: true }).count()).toBe(0)
    await target.evaluate(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.setMounted(false))
    await target.evaluate(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.setMounted(true))
    await target.getByText("uploaded-1.txt", { exact: true }).first().waitFor()
    await target.reload()
    await target.getByTestId("fixture-ready").waitFor({ state: "attached" })
    await target.evaluate(() => {
      const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
      fixture.setChatId(null)
      fixture.setProjectId("project-a")
    })
    await target.getByText("uploaded-1.txt", { exact: true }).first().waitFor()
    await target.locator("button:has(svg.lucide-arrow-up)").click()
    await target.waitForFunction(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.submissions().length === 1)
    await settle(target, 0, true)
    await target.waitForFunction(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.attachments("landing:project-a").length === 0)
    expect(await readAttachments(target, "landing:project-b")).toHaveLength(1)
  })

  test("an obsolete upload cannot free a slot or post new project files to the old project", async () => {
    const target = await openFixture()
    const held: Route[] = []
    await target.route("**/uploads", async route => { held.push(route) })
    const waitForRoutes = async (count: number) => {
      const deadline = Date.now() + 5_000
      while (held.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(held).toHaveLength(count)
    }
    await target.evaluate(() => {
      const fixture = (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture
      fixture.setChatId(null)
      fixture.setProjectId("project-a")
    })
    const file = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(name) })
    await target.locator('input[type="file"]').setInputFiles(file("a.txt"))
    await waitForRoutes(1)
    await target.evaluate(() => (window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture.setProjectId("project-b"))
    await target.locator('input[type="file"]').setInputFiles(["b1.txt", "b2.txt", "b3.txt", "b4.txt"].map(file))
    await waitForRoutes(4)
    const fulfill = (route: Route, id: string) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ attachments: [{
        id, kind: "file", displayName: `${id}.txt`, absolutePath: `/fixture/${id}`,
        relativePath: id, contentUrl: `/api/projects/fixture/uploads/${id}/content`, mimeType: "text/plain", size: 1,
      }] }),
    })
    expect(held[0].request().url()).toContain("/project-a/uploads")
    expect(held[0].request().postData()).not.toContain("b1.txt")
    expect(held.slice(1).every(route => route.request().url().includes("/project-b/uploads"))).toBe(true)
    await fulfill(held[0], "stale-a")
    await target.waitForTimeout(100)
    expect(held).toHaveLength(4)
    await fulfill(held[1], "b1")
    await waitForRoutes(5)
    expect(held[4].request().url()).toContain("/project-b/uploads")
    await Promise.all(held.slice(2).map((route, index) => fulfill(route, `b${index + 2}`)))
  })
})

async function expectInputValue(target: Page, value: string) {
  await target.waitForFunction(
    (expected) => (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value === expected,
    value
  )
}
