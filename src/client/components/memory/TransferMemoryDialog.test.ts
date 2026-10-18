import { describe, expect, test } from "bun:test"
import type { TransferProposal } from "../../lib/memoriesApi"
import { buildManualTransferCommitBody } from "./TransferMemoryDialog"

describe("buildManualTransferCommitBody", () => {
  test("binds manual commits to the reviewed source and landing versions", () => {
    const proposal: TransferProposal = {
      verdict: "rewrite",
      sourceVersion: 12,
      portable: "Use a consistent package manager",
      applicability: "JavaScript projects",
      content: "Use pnpm for this project",
      detail: "Do not mix package managers.",
      abstractionLevel: "general",
      note: "Adapted to the target project.",
      landing: {
        route: "reinforces",
        targetId: "M-02",
        targetContent: "Prefer pnpm",
        targetVersion: 4,
      },
    }

    const body = buildManualTransferCommitBody({
      proposal,
      target: { targetScope: "project", targetProjectId: "project-1" },
      content: "  Use pnpm for this project  ",
      archiveOriginal: false,
      surface: "board",
    })

    expect(body.sourceVersion).toBe(12)
    expect(body.landingTargetId).toBe("M-02")
    expect(body.landingTargetVersion).toBe(4)
    expect(body.targetScope).toBe("project")
    expect(body.targetProjectId).toBe("project-1")
    expect(body.content).toBe("Use pnpm for this project")
    expect(body.surface).toBe("board")
  })
})
