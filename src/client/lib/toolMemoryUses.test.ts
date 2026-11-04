import { describe, expect, test } from "bun:test"
import type { HydratedTranscriptMessage } from "../../shared/types"
import { buildToolMemoryUses, mergeToolMemoryUses, toolMemoryUsesSignature } from "./toolMemoryUses"

type Trace = Extract<HydratedTranscriptMessage, { kind: "memory_trace" }>

function trace(labels: Trace["labels"], extra: Partial<Trace> = {}): HydratedTranscriptMessage {
  return { kind: "memory_trace", id: "trace", timestamp: "2026-11-04T00:00:00.000Z", labels, ...extra } as HydratedTranscriptMessage
}

describe("buildToolMemoryUses", () => {
  test("ties used and violated memories to the step that shows them", () => {
    const uses = buildToolMemoryUses([
      trace([
        { id: "M-01", label: "operational", toolId: "tool-a", note: "kept strict types" },
        { id: "M-02", label: "violated", toolId: "tool-a" },
        { id: "M-03", label: "operational", toolId: "tool-b" },
      ]),
    ])
    expect(uses?.get("tool-a")).toEqual([
      { id: "M-01", violated: false, note: "kept strict types", noteUiText: undefined },
      { id: "M-02", violated: true, note: undefined, noteUiText: undefined },
    ])
    expect(uses?.get("tool-b")?.map((use) => use.id)).toEqual(["M-03"])
  })

  test("leaves out memories that never touched the work, or have no step", () => {
    expect(buildToolMemoryUses([
      trace([
        { id: "M-01", label: "injected_without_effect", toolId: "tool-a" },
        { id: "M-02", label: "not_applicable", toolId: "tool-a" },
        { id: "M-03", label: "operational" },
      ]),
    ])).toBeNull()
  })

  test("ignores audits that did not finish or were hidden", () => {
    const labels: Trace["labels"] = [{ id: "M-01", label: "operational", toolId: "tool-a" }]
    expect(buildToolMemoryUses([trace(labels, { status: "pending" })])).toBeNull()
    expect(buildToolMemoryUses([trace(labels, { status: "failed" })])).toBeNull()
    expect(buildToolMemoryUses([trace(labels, { hidden: true })])).toBeNull()
    expect(buildToolMemoryUses([trace(labels, { status: "ok" })])?.size).toBe(1)
  })

  test("a violation on the same step wins over an earlier use", () => {
    const uses = buildToolMemoryUses([
      trace([{ id: "M-01", label: "operational", toolId: "tool-a" }, { id: "M-01", label: "violated", toolId: "tool-a" }]),
    ])
    expect(uses?.get("tool-a")).toHaveLength(1)
    expect(uses?.get("tool-a")?.[0]?.violated).toBe(true)
  })
})

describe("mergeToolMemoryUses", () => {
  test("lists each memory once in first-use order, keeping any violation", () => {
    const uses = buildToolMemoryUses([
      trace([
        { id: "M-02", label: "operational", toolId: "tool-a" },
        { id: "M-01", label: "operational", toolId: "tool-a" },
        { id: "M-02", label: "violated", toolId: "tool-b" },
      ]),
    ])
    expect(mergeToolMemoryUses(uses, ["tool-a", "tool-b"]).map(({ id, violated }) => [id, violated])).toEqual([["M-02", true], ["M-01", false]])
    expect(mergeToolMemoryUses(null, ["tool-a"])).toEqual([])
  })
})

test("the signature changes only when the uses do", () => {
  const first = buildToolMemoryUses([trace([{ id: "M-01", label: "operational", toolId: "tool-a" }])])
  const same = buildToolMemoryUses([trace([{ id: "M-01", label: "operational", toolId: "tool-a" }])])
  const flipped = buildToolMemoryUses([trace([{ id: "M-01", label: "violated", toolId: "tool-a" }])])
  expect(toolMemoryUsesSignature(first)).toBe(toolMemoryUsesSignature(same))
  expect(toolMemoryUsesSignature(first)).not.toBe(toolMemoryUsesSignature(flipped))
  expect(toolMemoryUsesSignature(null)).toBe("")
})
