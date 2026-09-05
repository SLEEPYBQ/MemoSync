import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { StudyDockLoadingStatus, studyBriefDialogAction } from "./StudyDock"

describe("study instructions dialog", () => {
  test("returns an active participant to the current session instead of opening setup again", () => {
    expect(studyBriefDialogAction(true)).toEqual({
      label: "Return to session",
      navigateToSetup: false,
    })
  })

  test("opens setup after the participant reviews a new assignment", () => {
    expect(studyBriefDialogAction(false)).toEqual({
      label: "Review assignment and open project",
      navigateToSetup: true,
    })
  })

  test("keeps a visible retry control when the initial progress request fails", () => {
    const html = renderToStaticMarkup(createElement(StudyDockLoadingStatus, {
      error: "request failed (502)",
      onRetry: () => {},
    }))
    expect(html).toContain("Study")
    expect(html).toContain("request failed (502)")
    expect(html).toContain("Retry")
  })
})
