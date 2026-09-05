import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReplyMarkdown } from "./MemoryPreviewMessage"

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
