import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LlmJsonCaller } from "../memory/deepseek"
import type { ActualExecutionJudgeInput } from "./study-actual-execution"
import { createFrozenSourceActualExecutionJudge } from "./study-actual-execution-judge"

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function judgeInput(): Promise<ActualExecutionJudgeInput> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "memosync-source-judge-"))
  tempRoots.push(workspaceRoot)
  await mkdir(join(workspaceRoot, "src"), { recursive: true })
  await writeFile(join(workspaceRoot, "src", "theme.ts"), [
    "export const background = 'linen'",
    "export const accent = 'maroon'",
    "",
  ].join("\n"))
  return {
    participantId: "P17",
    taskId: "038-S1",
    snapshotId: "freeze-1",
    probeId: "probe-1",
    desired: { content: "Use maroon for component highlights.", scope: "project" },
    task: {
      brief: ["Build apartment browsing and discovery."],
      officialChecks: [{
        kind: "design",
        instruction: "Inspect the application theme.",
        expectedResult: "Component highlights are maroon.",
      }],
    },
    workspace: {
      schemaVersion: 1,
      taskId: "038-S1",
      snapshotId: "freeze-1",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-20T00:00:00.000Z",
      exportedPath: "experiments/workspace-snapshots/038-S1/freeze-1/workspace",
      treeHash: "a".repeat(64),
      fileCount: 1,
      totalBytes: 64,
      exclusions: ["**/node_modules/**"],
    },
    workspaceRoot,
  }
}

describe("createFrozenSourceActualExecutionJudge", () => {
  test("judges one Desired Memory from line-numbered frozen source evidence", async () => {
    const requests: Parameters<LlmJsonCaller>[0][] = []
    const callJson: LlmJsonCaller = async (request) => {
      requests.push(request)
      return {
        verdict: "fully_realized",
        rationale: "The implementation defines maroon as the accent.",
        evidence: [{
          path: "src/theme.ts",
          startLine: 2,
          endLine: 2,
          excerpt: "export const accent = 'maroon'",
          description: "The frozen source implements the requested highlight color.",
        }],
      }
    }
    const judge = createFrozenSourceActualExecutionJudge({
      callJson,
      modelId: "deepseek-v4-flash",
      evaluatorVersion: "2026-08-20-v1",
    })

    const result = await judge.evaluate(await judgeInput())

    expect(judge).toMatchObject({
      name: "memosync-frozen-source-judge",
      version: "2026-08-20-v1+deepseek-v4-flash",
      model: "deepseek-v4-flash",
    })
    expect(result).toEqual({
      verdict: "fully_realized",
      rationale: "The implementation defines maroon as the accent.",
      evidence: [{
        path: "src/theme.ts",
        startLine: 2,
        endLine: 2,
        excerpt: "export const accent = 'maroon'",
        description: "The frozen source implements the requested highlight color.",
      }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.user).toContain("Desired Memory:\nUse maroon for component highlights.")
    expect(requests[0]!.user).toContain("FILE src/theme.ts\n1 | export const background = 'linen'\n2 | export const accent = 'maroon'")
    expect(requests[0]!.user).toContain("Official checks are task context only")
    expect(requests[0]!.user).not.toContain("participantExecutionJudgment")
  })
})
