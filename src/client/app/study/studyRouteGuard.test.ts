import { describe, expect, test } from "bun:test"
import { resolveStudyRouteAccess } from "./studyRouteGuard"

describe("study questionnaire route access", () => {
  test("redirects a frozen session away from its chat and back to the current questionnaire", () => {
    expect(resolveStudyRouteAccess({
      pathname: "/chat/chat-before-freeze",
      checkedPathname: "/chat/chat-before-freeze",
      progress: {
        activeTaskId: "038-S1",
        postSessionPending: true,
        freezeState: "frozen",
      },
    })).toEqual({
      kind: "redirect",
      to: "/study/038-S1/quiz",
    })
  })

  test("blocks the chat while the freeze request is still settling", () => {
    expect(resolveStudyRouteAccess({
      pathname: "/chat/chat-being-frozen",
      checkedPathname: "/chat/chat-being-frozen",
      progress: {
        activeTaskId: "038-S1",
        postSessionPending: false,
        freezeState: "freezing",
      },
    })).toEqual({
      kind: "redirect",
      to: "/study/038-S1/quiz",
    })
  })

  test("does not reveal a newly navigated chat while progress is being rechecked", () => {
    expect(resolveStudyRouteAccess({
      pathname: "/chat/previous-session",
      checkedPathname: "/study/038-S1/quiz",
      progress: {
        activeTaskId: "038-S1",
        postSessionPending: false,
        freezeState: "open",
      },
    })).toEqual({ kind: "wait" })
  })

  test("keeps the full-screen questionnaire usable while its progress check is unavailable", () => {
    expect(resolveStudyRouteAccess({
      pathname: "/study/038-S1/quiz",
      checkedPathname: null,
      progress: null,
    })).toEqual({ kind: "allow" })
  })

  test("corrects a stale questionnaire route without exposing the workspace", () => {
    expect(resolveStudyRouteAccess({
      pathname: "/study/098-S1/quiz",
      checkedPathname: "/study/098-S1/quiz",
      progress: {
        activeTaskId: "038-S1",
        postSessionPending: true,
        freezeState: "frozen",
      },
    })).toEqual({
      kind: "redirect",
      to: "/study/038-S1/quiz",
    })
  })
})
