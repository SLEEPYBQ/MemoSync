import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReadResultImages, ToolCallMessage } from "./ToolCallMessage"

describe("ToolCallMessage", () => {
  test("keeps its provider tool anchor mounted while tool details are collapsed", () => {
    const html = renderToStaticMarkup(<ToolCallMessage message={{
      kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "call-evidence", id: "transcript-entry",
      input: { command: "cat file.ts" }, result: "the evidence", timestamp: "2026-09-10T00:00:00Z",
    }} />)
    expect(html).toContain('data-tool-id="call-evidence"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("the evidence")
  })
  test("renders read result image blocks as inline images", () => {
    const html = renderToStaticMarkup(
      <ReadResultImages
        images={[
          {
            type: "image",
            data: "ZmFrZS1pbWFnZS1kYXRh",
            mimeType: "image/png",
          },
        ]}
      />
    )

    expect(html).toContain("data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh")
    expect(html).toContain("alt=\"Read result 1\"")
  })
})
