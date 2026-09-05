import { afterEach, describe, expect, test } from "bun:test"
import { DEMO_MEMORY_ITEMS } from "./guideScenes"
import { GUIDE_PROJECT_ID, installGuideFetchShim } from "./guideDemoWorkspace"

const ORIGINAL_WINDOW = globalThis.window
let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  if (ORIGINAL_WINDOW === undefined) {
    // Bun has no browser global unless a test installs one.
    delete (globalThis as { window?: Window }).window
  } else {
    globalThis.window = ORIGINAL_WINDOW
  }
})

describe("installGuideFetchShim", () => {
  test("serves declared Board, workspace, and Markdown reads from demo data only", async () => {
    const forwarded: string[] = []
    const realFetch = (async (input: RequestInfo | URL) => {
      forwarded.push(String(input))
      return new Response("real backend")
    }) as typeof fetch
    globalThis.window = {
      location: { origin: "http://guide.test" },
      fetch: realFetch,
    } as unknown as Window & typeof globalThis

    uninstall = installGuideFetchShim()

    const memories = await window.fetch("/api/memories").then((response) => response.json())
    const attention = await window.fetch("/api/memories/needs-attention").then((response) => response.json())
    const projects = await window.fetch("/api/projects").then((response) => response.json())
    const chats = await window.fetch("/api/chats").then((response) => response.json())
    const markdown = await window.fetch("/api/memories/md-file?project=guide-demo-shop").then((response) => response.json())

    expect(memories.data).toEqual(DEMO_MEMORY_ITEMS)
    expect(attention.data).toEqual({ items: [] })
    expect(projects.data).toEqual([{ id: GUIDE_PROJECT_ID, title: "Guide demo shop" }])
    expect(chats.data[0]).toMatchObject({ projectId: GUIDE_PROJECT_ID })
    expect(markdown.data.content).toContain("Cart state lives")
    expect(forwarded).toEqual([])
  })

  test("fails closed for every undeclared memory or workspace route", async () => {
    let forwarded = 0
    const realFetch = (async () => {
      forwarded += 1
      return new Response("real backend")
    }) as unknown as typeof fetch
    globalThis.window = {
      location: { origin: "http://guide.test" },
      fetch: realFetch,
    } as unknown as Window & typeof globalThis

    uninstall = installGuideFetchShim()

    const responses = await Promise.all([
      window.fetch("/api/memories/private-participant-route"),
      window.fetch("/api/memories", { method: "POST", body: "{}" }),
      window.fetch("/api/memories/md-import", { method: "POST", body: "{}" }),
      window.fetch("/api/projects/participant-project/files"),
      window.fetch("/api/chats/participant-chat"),
    ])

    expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503, 503])
    expect(forwarded).toBe(0)
  })

  test("runs declared Board actions entirely inside the local demo controller", async () => {
    let forwarded = 0
    const realFetch = (async () => {
      forwarded += 1
      return new Response("real backend")
    }) as unknown as typeof fetch
    globalThis.window = {
      location: { origin: "http://guide.test" },
      fetch: realFetch,
    } as unknown as Window & typeof globalThis

    uninstall = installGuideFetchShim()

    await window.fetch("/api/memories/M-04", {
      method: "PATCH",
      body: JSON.stringify({ status: "active", surface: "board" }),
    })
    await window.fetch("/api/memories/M-05?surface=board", { method: "DELETE" })
    await window.fetch("/api/memories/M-11/transfer-decline", {
      method: "POST",
      body: JSON.stringify({
        boardResolution: {
          taskId: "038-S2",
          chatId: "guide-prior-chat",
          gateId: "guide-board-transfer",
        },
      }),
    })
    await window.fetch("/api/memories/attention-resolve", {
      method: "POST",
      body: JSON.stringify({
        kind: "stale",
        id: "M-06",
        action: "keep",
        boardResolution: {
          taskId: "038-S2",
          chatId: "guide-prior-chat",
          gateId: "guide-board-checkup",
          suggestionKind: "staleness",
          memoryId: "M-06",
        },
      }),
    })

    const review = await window.fetch("/api/memories/board-review?taskId=038-S2").then((response) => response.json())
    const memories = await window.fetch("/api/memories").then((response) => response.json())
    expect(review.data.pending.total).toBe(0)
    expect(memories.data.some((item: { status: string }) => item.status === "candidate")).toBe(false)
    expect(forwarded).toBe(0)
  })

  test("keeps Candidate accept, undo, dismiss, and restore inside the Guide", async () => {
    let forwarded = 0
    const realFetch = (async () => {
      forwarded += 1
      return new Response("real backend")
    }) as unknown as typeof fetch
    globalThis.window = {
      location: { origin: "http://guide.test" },
      fetch: realFetch,
    } as unknown as Window & typeof globalThis

    uninstall = installGuideFetchShim()

    await window.fetch("/api/memories/M-04", {
      method: "PATCH",
      body: JSON.stringify({ status: "active", surface: "chat_gate" }),
    })
    const reverted = await window.fetch("/api/memories/M-04/revert-auto", {
      method: "POST",
      body: JSON.stringify({ sessionId: "guide-chat" }),
    }).then((response) => response.json())
    expect(reverted.data).toMatchObject({ reverted: { id: "M-04", status: "candidate" }, restored: null })

    await window.fetch("/api/memories/M-05?surface=chat_gate", { method: "DELETE" })
    const restored = await window.fetch("/api/memories/M-05/restore-candidate", {
      method: "POST",
      body: JSON.stringify({ surface: "chat_gate" }),
    }).then((response) => response.json())
    expect(restored.data).toMatchObject({ id: "M-05", status: "candidate" })
    expect(forwarded).toBe(0)
  })

  test("keeps the audit Enforce practice inside the Guide sandbox", async () => {
    let forwarded = 0
    const realFetch = (async () => {
      forwarded += 1
      return new Response("real backend")
    }) as unknown as typeof fetch
    globalThis.window = {
      location: { origin: "http://guide.test" },
      fetch: realFetch,
    } as unknown as Window & typeof globalThis

    uninstall = installGuideFetchShim()
    const response = await window.fetch("/api/memories/pay-attention", {
      method: "POST",
      body: JSON.stringify({
        id: "M-02",
        sessionId: "guide-chat",
        quote: "sets the cart items to an empty array",
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { queued: "M-02" } })
    expect(forwarded).toBe(0)
  })

  test("still forwards unrelated same-origin and external requests", async () => {
    const forwarded: string[] = []
    const realFetch = (async (input: RequestInfo | URL) => {
      forwarded.push(String(input))
      return new Response("ok")
    }) as typeof fetch
    globalThis.window = {
      location: { origin: "http://guide.test" },
      fetch: realFetch,
    } as unknown as Window & typeof globalThis

    uninstall = installGuideFetchShim()
    await window.fetch("/api/health")
    await window.fetch("https://example.test/demo")

    expect(forwarded).toEqual(["/api/health", "https://example.test/demo"])
  })
})
