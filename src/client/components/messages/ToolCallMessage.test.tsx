import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReadResultImages, ToolCallMessage } from "./ToolCallMessage"
import { CollapsedToolGroup, summarizeToolGroup } from "./CollapsedToolGroup"
import { ToolMemoryUsesProvider } from "./render-context"
import { ToolCallExpandedContent } from "./ToolCallExpandedContent"
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

describe("the tool trace", () => {
  const read = (toolId: string, filePath: string): ProcessedToolCall => ({
    kind: "tool", toolKind: "read_file", toolName: "Read", toolId, id: toolId, input: { filePath }, result: "x", timestamp: "2026-09-10T00:00:00Z",
  } as ProcessedToolCall)
  const bash = (toolId: string, extra: Partial<ProcessedToolCall> = {}): ProcessedToolCall => ({
    kind: "tool", toolKind: "bash", toolName: "Bash", toolId, id: toolId, input: { command: `run ${toolId}` }, result: "ok", timestamp: "2026-09-10T00:00:00Z", ...extra,
  } as ProcessedToolCall)

  test("counts a file read twice as one file", () => {
    expect(summarizeToolGroup([read("a", "/x.ts"), read("b", "/x.ts"), read("c", "/y.ts"), bash("d")])).toBe("Read 2 files, ran 1 command")
  })

  test("while a step runs, the collapsed row names it and counts only what finished", () => {
    const running = bash("d", { result: undefined })
    const html = renderToStaticMarkup(
      <CollapsedToolGroup messages={[read("a", "/x.ts"), running]} isLoading expanded={false} onExpandedChange={() => {}} />,
    )
    expect(html).toContain("Read 1 file")
    expect(html).toContain("run d")
    expect(html).not.toContain("Ran 1 command")
  })

  test("a finished run says how many failed, and why when opened", () => {
    const failed = bash("d", { isError: true, result: "\nexit code 1\nmore" })
    const collapsed = renderToStaticMarkup(
      <CollapsedToolGroup messages={[read("a", "/x.ts"), failed]} isLoading={false} expanded={false} onExpandedChange={() => {}} />,
    )
    expect(collapsed).toContain("1 failed")
    expect(renderToStaticMarkup(<ToolCallMessage message={failed} />)).toContain("exit code 1")
  })

  test("the memories a step used show on the step and on its collapsed group", () => {
    const uses = new Map([["d", [{ id: "M-07", violated: false }]]])
    const wrap = (node: React.ReactNode) => renderToStaticMarkup(<ToolMemoryUsesProvider value={uses}>{node}</ToolMemoryUsesProvider>)
    expect(wrap(<CollapsedToolGroup messages={[read("a", "/x.ts"), bash("d")]} isLoading={false} expanded={false} onExpandedChange={() => {}} />)).toContain('data-tool-memory-uses="M-07"')
    expect(wrap(<ToolCallMessage message={bash("d")} />)).toContain('data-tool-memory-uses="M-07"')
    expect(wrap(<ToolCallMessage message={read("a", "/x.ts")} />)).not.toContain("data-tool-memory-uses")
  })

  test("opening a command shows it with its output, ready for the evidence jump", () => {
    const html = renderToStaticMarkup(<ToolCallExpandedContent message={bash("d", { result: "12 pass" })} />)
    expect(html).toContain("run d")
    expect(html).toContain("12 pass")
    // toolEvidence.ts finds quoted evidence by looking inside these.
    expect(html.match(/<pre/g)?.length).toBe(2)
  })

  test("other tools list what they were asked instead of dumping JSON", () => {
    const grep = { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: "g", id: "g", input: { pattern: "needle", outputMode: "files_with_matches" }, result: "a.ts", timestamp: "2026-09-10T00:00:00Z" } as ProcessedToolCall
    const html = renderToStaticMarkup(<ToolCallExpandedContent message={grep} />)
    expect(html).toContain("needle")
    expect(html).toContain("a.ts")
    expect(html).not.toContain("{")
  })

  test("a command that printed nothing says so", () => {
    expect(renderToStaticMarkup(<ToolCallExpandedContent message={bash("d", { result: "" })} />)).toContain("No output")
  })
})
