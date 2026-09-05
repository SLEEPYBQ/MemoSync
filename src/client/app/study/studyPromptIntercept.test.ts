import { afterEach, describe, expect, test } from "bun:test"
import {
  createHeldStudyPrompt,
  hashStudyPromptDraft,
  markStudyPromptServerOwned,
  settleServerOwnedStudyPromptDraft,
  setStudyPromptInterceptor,
  subscribeStudyPromptServerOwnership,
  submitStudyPrompt,
  studyGateCapturesPrompt,
} from "./studyPromptIntercept"
import { hashMemoryBoardOpeningPrompt } from "../../../server/memory/board-backlog"

afterEach(() => {
  setStudyPromptInterceptor(null)
})

describe("study prompt interception seam (2026-08-19 evening revision)", () => {
  test("without a mounted gate, the caller awaits the real dispatch", async () => {
    let dispatched = 0
    await submitStudyPrompt({
      content: "Build the booking flow",
      dispatch: async () => { dispatched += 1 },
    })
    expect(dispatched).toBe(1)
  })

  test("the opening Board keeps submit pending until the held prompt really dispatches", async () => {
    const holds: ReturnType<typeof createHeldStudyPrompt>[] = []
    setStudyPromptInterceptor((submission) => {
      const hold = createHeldStudyPrompt(submission)
      holds.push(hold)
      return hold.promise
    })
    let dispatched = 0
    let settled = false
    const submitted = submitStudyPrompt({
      content: "Build the booking flow",
      dispatch: async () => { dispatched += 1 },
    }).finally(() => { settled = true })

    await Promise.resolve()
    expect(dispatched).toBe(0)
    expect(settled).toBe(false)
    expect(holds[0]?.submission.content).toBe("Build the booking flow")

    await holds[0]!.release()
    await submitted
    expect(dispatched).toBe(1)
    expect(settled).toBe(true)
  })

  test("stages the exact first prompt once but keeps submit pending until final Board Continue", async () => {
    const dispatchedReviewIds: Array<string | undefined> = []
    const hold = createHeldStudyPrompt({
      content: "Build the booking flow",
      dispatch: async (openingReviewId?: string) => {
        dispatchedReviewIds.push(openingReviewId)
      },
    } as any) as any
    let settled = false
    void hold.promise.finally(() => { settled = true })

    await hold.prepare("opening-review-1")
    await Promise.resolve()
    expect(dispatchedReviewIds).toEqual(["opening-review-1"])
    expect(settled).toBe(false)

    await hold.release()
    expect(dispatchedReviewIds).toEqual(["opening-review-1"])
    expect(settled).toBe(true)
  })

  test("an eager server preparation settles the composer without dispatching the first prompt a second time", async () => {
    const dispatchedReviewIds: Array<string | undefined> = []
    let providerPromptCount = 1 // the eager `/prepare` server owner
    const hold = createHeldStudyPrompt({
      content: "Build the booking flow",
      dispatch: async (openingReviewId?: string) => {
        providerPromptCount += 1
        dispatchedReviewIds.push(openingReviewId)
      },
    })
    let settled = false
    void hold.promise.finally(() => { settled = true })

    // `/prepare` already claimed and dispatched this exact review on the
    // server, and its response came back as `preparing` rather than
    // `dispatch_pending`. Continue must only settle ChatInput's promise.
    hold.markExternallyPrepared("opening-review-eager")
    expect(settled).toBe(false)
    await hold.release()

    expect(dispatchedReviewIds).toEqual([])
    expect(providerPromptCount).toBe(1)
    expect(settled).toBe(true)
  })

  test("a delayed dispatch failure reaches the composer so it can restore the prompt", async () => {
    let hold: ReturnType<typeof createHeldStudyPrompt> | null = null
    setStudyPromptInterceptor((submission) => {
      hold = createHeldStudyPrompt(submission)
      return hold.promise
    })
    const submitted = submitStudyPrompt({
      content: "Build the booking flow",
      dispatch: async () => { throw new Error("send failed") },
    })

    await Promise.resolve()
    await expect(hold!.release()).rejects.toThrow("send failed")
    await expect(submitted).rejects.toThrow("send failed")
  })

  test("abandoning a held prompt rejects so the owning chat retains its draft", async () => {
    let dispatched = 0
    const hold = createHeldStudyPrompt({
      content: "This belongs to chat A",
      dispatch: async () => { dispatched += 1 },
    })

    hold.abandon()
    await expect(hold.promise).rejects.toThrow("stayed in its original chat draft")
    await expect(hold.release()).rejects.toThrow("stayed in its original chat draft")
    expect(dispatched).toBe(0)
  })

  test("unmount after server preparation accepts the held submit instead of restoring its draft", async () => {
    let dispatched = 0
    const hold = createHeldStudyPrompt({
      content: "The server already owns this",
      dispatch: async () => { dispatched += 1 },
    })
    hold.markExternallyPrepared("opening-review-owned")

    hold.abandon()
    await expect(hold.promise).resolves.toBeUndefined()
    expect(dispatched).toBe(0)
  })

  test("reload hands one server-owned opening receipt to the composer exactly once", () => {
    const received: string[] = []
    markStudyPromptServerOwned("chat-owned-after-reload", "opening-review-reload", "prompt-hash")

    const unsubscribe = subscribeStudyPromptServerOwnership("chat-owned-after-reload", (receipt) => {
      received.push(`${receipt.openingReviewId}:${receipt.promptHash}`)
    })
    unsubscribe()
    const unsubscribeAgain = subscribeStudyPromptServerOwnership("chat-owned-after-reload", (receipt) => {
      received.push(`duplicate:${receipt.openingReviewId}`)
    })
    unsubscribeAgain()

    expect(received).toEqual(["opening-review-reload:prompt-hash"])
  })

  test("clears an exact restored draft after delayed server ownership", async () => {
    let current = {
      content: "Build the booking flow",
      attachments: [{ id: "upload-1", relativePath: "brief.md" }],
    }
    let cleared = 0
    const promptHash = await hashStudyPromptDraft(current)
    expect(promptHash).toBe(hashMemoryBoardOpeningPrompt(current))

    await expect(settleServerOwnedStudyPromptDraft({
      promptHash,
      getCurrent: () => current,
      clear: () => { cleared += 1 },
    })).resolves.toBe(true)
    expect(cleared).toBe(1)
  })

  test("never erases a draft changed while delayed ownership status is arriving", async () => {
    const owned = {
      content: "Build the booking flow",
      attachments: [{ id: "upload-1", relativePath: "brief.md" }],
    }
    let current = structuredClone(owned)
    let cleared = 0
    const promptHash = await hashStudyPromptDraft(owned)
    const settling = settleServerOwnedStudyPromptDraft({
      promptHash,
      getCurrent: () => current,
      clear: () => { cleared += 1 },
    })
    current = { content: "A genuinely new draft", attachments: [] }

    await expect(settling).resolves.toBe(false)
    expect(cleared).toBe(0)
    expect(current.content).toBe("A genuinely new draft")
  })

  test("unregistering restores pass-through", () => {
    setStudyPromptInterceptor((submission) => createHeldStudyPrompt(submission).promise)
    setStudyPromptInterceptor(null)
    let dispatched = 0
    return submitStudyPrompt({ content: "hello", dispatch: async () => { dispatched += 1 } })
      .then(() => expect(dispatched).toBe(1))
  })

  test("the gate is fail-closed: only an explicitly admitted state passes", () => {
    // checking and error must CAPTURE (the modal shows progress/retry), never
    // let the prompt race the review receipt.
    expect(studyGateCapturesPrompt("checking")).toBe(true)
    expect(studyGateCapturesPrompt("error")).toBe(true)
    expect(studyGateCapturesPrompt("review_required")).toBe(true)
    expect(studyGateCapturesPrompt("admitted")).toBe(false)
    expect(studyGateCapturesPrompt("closed")).toBe(false)
  })
})
