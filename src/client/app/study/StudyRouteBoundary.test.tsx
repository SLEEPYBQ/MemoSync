import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { StudyRouteBoundary } from "./StudyRouteBoundary"

function renderBoundary(pathname: string, enabled: boolean, privateText: string) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [pathname] },
    createElement(
      StudyRouteBoundary,
      { enabled, children: createElement("div", null, privateText) },
    ),
  ))
}

describe("study route boundary", () => {
  test("does not mount readable workspace content before a study chat route is checked", () => {
    const html = renderBoundary("/chat/chat-before-freeze", true, "READABLE CHAT TRANSCRIPT")

    expect(html).toContain("Checking the current study step")
    expect(html).not.toContain("READABLE CHAT TRANSCRIPT")
  })

  test("keeps the questionnaire recovery surface mounted while progress is checked", () => {
    const html = renderBoundary("/study/038-S1/quiz", true, "QUESTIONNAIRE SURFACE")

    expect(html).toContain("QUESTIONNAIRE SURFACE")
  })

  test("keeps the Guide mounted before its durable receipt exists", () => {
    const html = renderBoundary("/guide", true, "GUIDE SURFACE")

    expect(html).toContain("GUIDE SURFACE")
    expect(html).not.toContain("Checking the current study step")
  })

  test("leaves non-study routes unchanged", () => {
    const html = renderBoundary("/chat/normal", false, "NORMAL CHAT")

    expect(html).toContain("NORMAL CHAT")
  })
})
