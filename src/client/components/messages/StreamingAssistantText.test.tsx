import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StreamingAssistantText } from "./StreamingAssistantText"

// The throttle must be trailing-edge with an immediate first value: the very
// first render shows the text as-is (no blank frame while a timer waits).
test("the first streamed text renders immediately, unthrottled", () => {
  const html = renderToStaticMarkup(<StreamingAssistantText text="streaming **now**" />)
  expect(html).toContain("streaming")
  expect(html).toContain("<strong>now</strong>")
})

test("only the in-flight reply marks its memory citations as current-turn interrupt targets", () => {
  const html = renderToStaticMarkup(<StreamingAssistantText text="Applying [M-01] now." />)

  expect(html).toContain('data-memory-interrupt-source="current-turn"')
})
