import { describe, expect, test } from "bun:test"
import { buildResolvedTranscriptRows } from "../app/ChatTranscript"
import type { HydratedTranscriptMessage } from "../../shared/types"
import { findToolEvidenceRowIndex } from "./toolEvidence"

function tool(id: string): HydratedTranscriptMessage {
  return { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: id, id: `message-${id}`, input: { command: "cat example.ts" }, timestamp: "2026-09-10T00:00:00Z" }
}

describe("audit tool evidence row lookup", () => {
  test("finds a tool inside a collapsed group without relying on its DOM", () => {
    const rows = buildResolvedTranscriptRows([
      { kind: "assistant_text", id: "intro", text: "Inspecting", timestamp: "2026-09-10T00:00:00Z" },
      tool("first"), tool("evidence"), tool("third"),
      { kind: "assistant_text", id: "done", text: "Done", timestamp: "2026-09-10T00:00:00Z" },
    ], { isLoading: false, latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null } })
    const index = findToolEvidenceRowIndex(rows, "evidence")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(rows[index].kind).toBe("tool-group")
    expect(findToolEvidenceRowIndex(rows, "absent-tool")).toBe(-1)
  })

  test("uses the provider toolId for a standalone tool, not its transcript message id", () => {
    const rows = buildResolvedTranscriptRows([tool("provider-call")], {
      isLoading: false, latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })
    expect(findToolEvidenceRowIndex(rows, "provider-call")).toBe(0)
    expect(findToolEvidenceRowIndex(rows, "message-provider-call")).toBe(-1)
  })
})
