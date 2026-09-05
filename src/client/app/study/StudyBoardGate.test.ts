import { describe, expect, test } from "bun:test"
import {
  completeOpeningBoardReviewWithReconciliation,
  consumeOpeningPromptOwnership,
  createOpeningPreparationClaims,
  getOpeningPromptOwnership,
  getOpeningPromptReturnRoute,
  getStudyBoardChatId,
  createStudyBoardRequestSequence,
  isOpenStudyBoardProgress,
  loadStudyBoardGate,
  memoryBoardDialogPolicy,
  type StudyBoardProgress,
} from "./StudyBoardGate"
import { createHeldStudyPrompt } from "./studyPromptIntercept"

describe("study Memory Board route admission", () => {
  test("one held opening identity retries only on an explicit request and keeps the same review id", () => {
    const claims = createOpeningPreparationClaims()
    const held = {}
    let generated = 0
    const nextReviewId = () => `opening-review-${++generated}`

    expect(claims.claim(held, undefined, nextReviewId)).toEqual({
      claimed: true,
      reviewId: "opening-review-1",
    })
    // boardReview() returns a freshly allocated status object, but React must
    // not turn that render into another immediate prepare/GET cycle.
    expect(claims.claim(held, undefined, nextReviewId)).toEqual({
      claimed: false,
      reviewId: "opening-review-1",
    })
    expect(claims.claim(held, undefined, nextReviewId)).toEqual({
      claimed: false,
      reviewId: "opening-review-1",
    })

    claims.retry(held)
    expect(claims.claim(held, undefined, nextReviewId)).toEqual({
      claimed: true,
      reviewId: "opening-review-1",
    })
    expect(generated).toBe(1)
  })

  test("a lost final Continue response reconciles a durable completed receipt as admitted", async () => {
    let completeCalls = 0
    let readCalls = 0
    const completed = {
      reviewed: true,
      pending: { candidates: 0, transfers: 0, checkups: 0, total: 0 },
      backlog: { transfers: [], checkups: [] },
      openingPrompt: {
        taskId: "038-S1",
        chatId: "chat-1",
        reviewId: "opening-review-completed",
        phase: "completed" as const,
        promptHash: "durable-prompt-hash",
      },
    }

    const result = await completeOpeningBoardReviewWithReconciliation({
      complete: async () => {
        completeCalls += 1
        throw new Error("response connection closed")
      },
      read: async () => {
        readCalls += 1
        return completed
      },
    })

    expect(result).toEqual({ admitted: true, status: completed, error: null })
    expect(completeCalls).toBe(1)
    expect(readCalls).toBe(1)
  })

  test("completed reconciliation consumes the held draft without dispatching it again", async () => {
    let dispatchCalls = 0
    const held = createHeldStudyPrompt({
      content: "my exact first prompt",
      dispatch: async () => { dispatchCalls += 1 },
    })
    const completed = {
      reviewed: true,
      pending: { candidates: 0, transfers: 0, checkups: 0, total: 0 },
      backlog: { transfers: [], checkups: [] },
      openingPrompt: {
        taskId: "038-S1",
        chatId: "chat-1",
        reviewId: "opening-review-completed",
        phase: "completed" as const,
        promptHash: "durable-prompt-hash",
      },
    }

    consumeOpeningPromptOwnership(completed, held)
    await held.release()

    expect(dispatchCalls).toBe(0)
  })

  test("a completed opening receipt still settles exact composer ownership after reload", () => {
    expect(getOpeningPromptOwnership({
      reviewed: true,
      pending: { candidates: 0, transfers: 0, checkups: 0, total: 0 },
      backlog: { transfers: [], checkups: [] },
      openingPrompt: {
        taskId: "038-S1",
        chatId: "chat-1",
        reviewId: "opening-review-completed",
        phase: "completed",
        promptHash: "durable-prompt-hash",
      },
    })).toEqual({
      chatId: "chat-1",
      reviewId: "opening-review-completed",
      promptHash: "durable-prompt-hash",
    })
  })

  test("returns a non-owner chat to the exact chat that owns an unfinished opening review", () => {
    const status = {
      reviewed: true,
      pending: { candidates: 0, transfers: 0, checkups: 1, total: 1 },
      backlog: { transfers: [], checkups: [] },
      openingPrompt: {
        taskId: "038-S1",
        chatId: "original/chat",
        reviewId: "opening-review-pending",
        phase: "preparing" as const,
        promptHash: "durable-prompt-hash",
      },
    }

    expect(getOpeningPromptReturnRoute(status, "new-chat")).toBe("/chat/original%2Fchat")
    expect(getOpeningPromptReturnRoute(status, "original/chat")).toBeNull()
    expect(getOpeningPromptReturnRoute({
      ...status,
      openingPrompt: { ...status.openingPrompt, phase: "completed" as const },
    }, "new-chat")).toBeNull()
  })

  test("the opening Board is a non-dismissible modal while the manual Board remains closable", () => {
    expect(memoryBoardDialogPolicy(true)).toEqual({
      ariaLabel: "Long-term Memory Management",
      dismissOnEscape: false,
      dismissOnOutside: false,
    })
    expect(memoryBoardDialogPolicy(false)).toEqual({
      ariaLabel: "Memory Board",
      dismissOnEscape: true,
      dismissOnOutside: true,
    })
  })

  test("only an active chat route is eligible to request live Board state", () => {
    expect(getStudyBoardChatId("/chat/chat-038-s1")).toBe("chat-038-s1")
    expect(getStudyBoardChatId("/chat/chat-038-s1/")).toBe("chat-038-s1")
    expect(getStudyBoardChatId("/guide")).toBeNull()
    expect(getStudyBoardChatId("/memory")).toBeNull()
    expect(getStudyBoardChatId("/study/038-S1")).toBeNull()
    expect(getStudyBoardChatId("/study/038-S1/quiz")).toBeNull()
  })

  test("freezing, frozen, and post-session progress never admits live Board memory", () => {
    expect(isOpenStudyBoardProgress({
      activeTaskId: "038-S1",
      freezeState: "open",
      postSessionPending: false,
    })).toBe(true)
    expect(isOpenStudyBoardProgress({
      activeTaskId: "038-S1",
      freezeState: "freezing",
      postSessionPending: false,
    })).toBe(false)
    expect(isOpenStudyBoardProgress({
      activeTaskId: "038-S1",
      freezeState: "frozen",
      postSessionPending: true,
    })).toBe(false)
    expect(isOpenStudyBoardProgress({
      activeTaskId: "038-S1",
      freezeState: "open",
      postSessionPending: true,
    })).toBe(false)
    expect(isOpenStudyBoardProgress({
      activeTaskId: null,
      freezeState: null,
      postSessionPending: false,
    })).toBe(false)
  })

  test("the mounted gate path makes zero Board requests on Guide and questionnaire routes", async () => {
    let progressCalls = 0
    let boardReviewCalls = 0
    const progress = async (): Promise<StudyBoardProgress> => {
      progressCalls += 1
      return { activeTaskId: "038-S1", freezeState: "open", postSessionPending: false }
    }
    const boardReview = async () => {
      boardReviewCalls += 1
      throw new Error("must not be called")
    }

    expect(await loadStudyBoardGate({
      pathname: "/guide",
      condition: "memosync",
      studyMode: true,
    }, { progress, boardReview })).toBeNull()
    expect(await loadStudyBoardGate({
      pathname: "/study/038-S1/quiz",
      condition: "memosync",
      studyMode: true,
    }, { progress, boardReview })).toBeNull()

    expect(progressCalls).toBe(0)
    expect(boardReviewCalls).toBe(0)
  })

  test("the mounted gate path makes zero Board requests after freeze or during post-session", async () => {
    let boardReviewCalls = 0
    const boardReview = async () => {
      boardReviewCalls += 1
      throw new Error("must not be called")
    }
    for (const progress of [
      { activeTaskId: "038-S1", freezeState: "freezing", postSessionPending: false },
      { activeTaskId: "038-S1", freezeState: "frozen", postSessionPending: true },
      { activeTaskId: "038-S1", freezeState: "open", postSessionPending: true },
    ] satisfies StudyBoardProgress[]) {
      expect(await loadStudyBoardGate({
        pathname: "/chat/chat-038-s1",
        condition: "memosync",
        studyMode: true,
      }, { progress: async () => progress, boardReview })).toBeNull()
    }
    expect(boardReviewCalls).toBe(0)
  })

  test("returns the same reviewed status for a closable mid-session Board", async () => {
    const status = {
      reviewed: true,
      pending: { candidates: 0, transfers: 0, checkups: 0, total: 0 },
      backlog: { transfers: [], checkups: [] },
    }
    const loaded = await loadStudyBoardGate({
      pathname: "/chat/chat-038-s1",
      condition: "memosync",
      studyMode: true,
    }, {
      progress: async () => ({ activeTaskId: "038-S1", freezeState: "open", postSessionPending: false }),
      boardReview: async () => status,
    })
    expect(loaded).toEqual({ taskId: "038-S1", chatId: "chat-038-s1", status })
  })

  test("ignores a late chat A result after chat B starts checking", async () => {
    const sequence = createStudyBoardRequestSequence()
    const chatA = sequence.begin()
    const chatB = sequence.begin()
    expect(sequence.isCurrent(chatB)).toBe(true)
    expect(sequence.isCurrent(chatA)).toBe(false)
    sequence.cancel()
    expect(sequence.isCurrent(chatB)).toBe(false)
  })
})
