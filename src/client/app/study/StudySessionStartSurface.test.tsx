import { describe, expect, test } from "bun:test"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { StudySessionStartSurface } from "./StudySessionStartSurface"

function findNewSessionChatAction(node: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null
  const element = node as ReactElement<Record<string, unknown>>
  if (element.props["data-study-new-session-chat"] === "true") return element

  let match: ReactElement<Record<string, unknown>> | null = null
  Children.forEach(element.props.children as ReactNode, (child) => {
    if (match === null) match = findNewSessionChatAction(child)
  })
  return match
}

describe("study session setup presentation", () => {
  test("creates a chat only when the participant activates New session chat", () => {
    let starts = 0
    const surface = StudySessionStartSurface({
      sessionTitle: "Session 1",
      projectTitle: "Apartment rentals",
      projectSlug: "apartment",
      continuesExistingWork: false,
      onStart: () => { starts += 1 },
    })

    expect(starts).toBe(0)
    const action = findNewSessionChatAction(surface)
    expect(action).not.toBeNull()
    expect(action?.props.children).toBeTruthy()
    const click = action?.props.onClick as (() => void) | undefined
    click?.()
    expect(starts).toBe(1)
  })

  test("explains the empty-chat handoff without exposing a study condition", () => {
    const html = renderToStaticMarkup(
      <StudySessionStartSurface
        sessionTitle="Session 2"
        projectTitle="Apartment rentals"
        projectSlug="apartment"
        continuesExistingWork
        onStart={() => {}}
      />,
    )

    expect(html).toContain("Session setup")
    expect(html).toContain("Your task brief is saved")
    expect(html).toContain("No message is sent when you create the chat")
    expect(html).toContain("write your first prompt in your own words")
    expect(html).toContain("Apartment rentals")
    expect(html).toContain("apartment")
    expect(html).toContain("continues the code from Session 1")
    expect(html).not.toContain("MemoSync")
    expect(html).not.toContain("Working Memory")
  })
})
