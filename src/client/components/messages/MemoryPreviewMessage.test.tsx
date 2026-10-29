import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReplyMarkdown, WorkingMemorySelectionError } from "./MemoryPreviewMessage"

describe("ReplyMarkdown", () => {
  test("renders Markdown without losing memory citation chips", () => {
    const html = renderToStaticMarkup(
      <ReplyMarkdown text={"**重点**\n\n- [M-76]\n- 普通条目"} />,
    )

    expect(html).toContain("<strong>重点</strong>")
    expect(html).toContain("<ul>")
    expect(html).toContain("[M-76]")
    expect(html).not.toContain("memosync-memory:")
  })
})

describe("working-memory failure recovery", () => {
  test("shows an explicit error and retry control instead of a successful empty-selection message", () => {
    const html = renderToStaticMarkup(<WorkingMemorySelectionError error="Working-memory selection failed." onRetry={() => {}} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain("Working-memory selection failed.")
    expect(html).toContain("Retry selection")
    expect(html).toContain("Choose items from the memory pool")
    expect(html).not.toContain("working memory is empty")
  })
})
