import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Page } from "playwright"
import type { ChatSnapshot, ProviderCatalogEntry, TranscriptEntry } from "../../shared/types"
import { PROVIDERS } from "../../shared/types"
import { startMountedRaceHarness } from "../test-utils/mountedRaceHarness"

interface AppStateFixtureApi {
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
