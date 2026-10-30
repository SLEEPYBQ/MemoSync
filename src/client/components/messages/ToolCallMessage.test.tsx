import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReadResultImages, ToolCallMessage } from "./ToolCallMessage"
import { CollapsedToolGroup } from "./CollapsedToolGroup"
import type { ProcessedToolCall } from "./types"

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

for (const grouped of [false, true]) {
  test(`does not inspect or serialize collapsed tool bodies (${grouped ? "grouped" : "single"})`, () => {
    let bodyReads = 0
    const message = {
      kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "lazy-call", id: "lazy-entry",
      input: { filePath: "/fixture/file" }, timestamp: "2026-10-30T00:00:00Z",
      result: { toJSON() { bodyReads++; return { content: "expensive result" } }, get blocks() { bodyReads++; return [] } },
      get rawResult() { bodyReads++; return [] },
    } as ProcessedToolCall
    const messages = [message, { ...message, id: "second", toolId: "lazy-call-2" }]
    bodyReads = 0
    renderToStaticMarkup(grouped
      ? <CollapsedToolGroup messages={messages} expanded isLoading={false} onExpandedChange={() => {}} />
      : <ToolCallMessage message={message} />)
    expect(bodyReads).toBe(0)
  })
}
