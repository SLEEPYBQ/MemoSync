import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Page } from "playwright"
import type { ChatSnapshot, ProviderCatalogEntry, TranscriptEntry } from "../../shared/types"
import { PROVIDERS } from "../../shared/types"
import { startMountedRaceHarness } from "../test-utils/mountedRaceHarness"

interface AppStateFixtureApi {
  transcriptRevision: () => number
  streamingText: () => string | null
  promptContents: () => string[]
  chatSubscriptionCount: (chatId: string) => number
  emitChat: (chatId: string, subscriptionIndex: number, snapshot: unknown) => void
  historyRequestCount: () => number
  historyRequest: (index: number) => { type: string; chatId?: string; beforeCursor?: string } | undefined
  resolveHistory: (index: number, page: unknown) => void
  rejectHistory: (index: number, reason: string) => void
}

interface RenderedAppState {
  activeChatId: string | null
  snapshotChatId: string | null
  transcriptIds: string[]
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

async function openFixture() {
  page = await harness.openPage("app-state")
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

describe("mounted useAppState history races", () => {
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
