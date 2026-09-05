import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp } from "node:fs/promises"
import { snapshotStudyWorkspace } from "../study-workspace-snapshot"
import {
  actualExecutionEvidenceFromFile,
  buildStudyDataExport,
} from "./study-data-export"
import { StudyMemoryStore } from "./study-memory-store"
import {
  evaluateStudyActualExecution,
  type ActualExecutionJudge,
  type ActualExecutionJudgeInput,
} from "./study-actual-execution"

const tempRoots: string[] = []

async function makeWritable(target: string): Promise<void> {
  const info = await lstat(target)
  if (info.isSymbolicLink()) return
  if (!info.isDirectory()) {
    await chmod(target, 0o600)
    return
  }
  await chmod(target, 0o700)
  for (const entry of await readdir(target)) await makeWritable(join(target, entry))
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await makeWritable(root).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

async function makeFrozenParticipant(): Promise<{
  dataDir: string
  outputDir: string
  probeId: string
  treeHash: string
}> {
  const root = await mkdtemp(join(tmpdir(), "memosync-actual-execution-"))
  tempRoots.push(root)
  const dataDir = join(root, "data")
  const experimentsDir = join(dataDir, "experiments")
  const sourceDir = join(root, "workspace", "apartment")
  const outputDir = join(root, "actual-execution")
  await mkdir(join(sourceDir, "src"), { recursive: true })
  await mkdir(experimentsDir, { recursive: true })
  await writeFile(join(sourceDir, "src", "theme.ts"), "export const accent = 'maroon'\n")
  await writeFile(join(experimentsDir, "study-allocation.json"), `${JSON.stringify({
    schemaVersion: 1,
    participantId: "P17",
    allocationMode: "study",
    condition: "auto",
    studyTaskOrder: ["038-S1", "038-S2", "098-S1", "098-S2"],
    issuedAt: "2026-08-20T00:00:00.000Z",
    claimedAt: "2026-08-20T00:01:00.000Z",
  }, null, 2)}\n`)

  const store = new StudyMemoryStore(join(experimentsDir, "study.sqlite"))
  store.recordFocusDelivery({
    injectionId: "delivery-1",
    taskId: "038-S1",
    chatId: "chat-1",
    turnId: "turn-1",
    turn: 1,
    focusedAt: "2026-08-20T00:02:00.000Z",
    condition: "auto",
    engine: "claude",
    mode: "plain",
    outcome: "delivered",
    deliveryStage: "queued_to_claude",
    deliveryHash: "delivery-hash",
    visiblePoolHash: "pool-hash",
    items: [{
      identity: { scheme: "store", id: "M-01" },
      version: 1,
      content: "Use maroon for component highlights.",
      scope: "project",
      sourceRef: { kind: "auto_store", memoryId: "M-01", storeVersion: 1 },
    }],
  })
  const workspaceSnapshot = await snapshotStudyWorkspace({
    dataDir,
    sourceDir,
    taskId: "038-S1",
    snapshotId: "freeze-038-s1",
    project: { slug: "apartment", title: "Apartment rentals" },
    frozenAt: "2026-08-20T00:03:00.000Z",
  })
  const snapshot = store.createFreezeSnapshot({
    snapshotId: workspaceSnapshot.snapshotId,
    taskId: workspaceSnapshot.taskId,
    frozenAt: workspaceSnapshot.frozenAt,
    workspaceSnapshot,
  })
  const probeId = snapshot.items[0]!.probeId
  store.recordQuestionnaireSubmission({
    submissionId: "questionnaire-1",
    snapshotId: snapshot.snapshotId,
    submittedAt: "2026-08-20T00:04:00.000Z",
    questionnaireVersion: 2,
    answers: [{
      probeId,
      snapshotId: snapshot.snapshotId,
      desired: { rating: 5, presence: "present", correctedContent: null, scope: "project" },
      assessed: { rating: 5, presence: "present", believedContent: null, scope: "project" },
      execution: 5,
    }],
  })
  store.close()
  return { dataDir, outputDir, probeId, treeHash: workspaceSnapshot.treeHash }
}

describe("evaluateStudyActualExecution", () => {
  test("verifies frozen output and publishes per-probe evidence for canonical export", async () => {
    const fixture = await makeFrozenParticipant()
    const calls: ActualExecutionJudgeInput[] = []
    const judge: ActualExecutionJudge = {
      name: "test-output-judge",
      version: "v1",
      model: "fixture-judge",
      async evaluate(input) {
        calls.push(input)
        expect(await readFile(join(input.workspaceRoot, "src", "theme.ts"), "utf8"))
          .toBe("export const accent = 'maroon'\n")
        return {
          verdict: "fully_realized",
          rationale: "The frozen source defines the requested accent color.",
          evidence: [{
            path: "src/theme.ts",
            startLine: 1,
            endLine: 1,
            excerpt: "export const accent = 'maroon'",
            description: "The implementation uses the requested component highlight.",
          }],
        }
      },
    }

    const evidenceDocument = await evaluateStudyActualExecution({
      participantDataDirs: [fixture.dataDir],
      outputDir: fixture.outputDir,
      judge,
      now: () => new Date("2026-08-20T01:00:00.000Z"),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      participantId: "P17",
      taskId: "038-S1",
      snapshotId: "freeze-038-s1",
      probeId: fixture.probeId,
      desired: { content: "Use maroon for component highlights.", scope: "project" },
      workspace: { treeHash: fixture.treeHash },
    })
    expect(calls[0]!.task.officialChecks.length).toBeGreaterThan(0)
    expect(evidenceDocument).toMatchObject({
      schemaVersion: 2,
      records: [{
        participantId: "P17",
        taskId: "038-S1",
        snapshotId: "freeze-038-s1",
        probeId: fixture.probeId,
        workspaceTreeHash: fixture.treeHash,
        verdict: "fully_realized",
        evaluator: { name: "test-output-judge", version: "v1", model: "fixture-judge" },
        evaluatedAt: "2026-08-20T01:00:00.000Z",
      }],
    })
    const record = evidenceDocument.records[0]!
    const artifact = JSON.parse(await readFile(join(fixture.outputDir, record.evidenceRef), "utf8"))
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      binding: {
        participantId: "P17",
        taskId: "038-S1",
        snapshotId: "freeze-038-s1",
        probeId: fixture.probeId,
      },
      workspace: { treeHash: fixture.treeHash },
      result: {
        verdict: "fully_realized",
        rationale: "The frozen source defines the requested accent color.",
      },
    })

    const dataset = buildStudyDataExport({
      participantDataDirs: [fixture.dataDir],
      actualExecutionEvidence: actualExecutionEvidenceFromFile(join(fixture.outputDir, "actual-execution.json")),
    })
    expect(dataset.memoryItems[0]).toMatchObject({
      participantExecutionJudgment: 5,
      actualExecutionStatus: "available",
      actualExecution: { verdict: "fully_realized", realized: true },
      measurements: { controlAccuracy: { status: "available", realized: true } },
    })
  })

  test("reuses immutable evidence on an identical rerun without calling the judge again", async () => {
    const fixture = await makeFrozenParticipant()
    let calls = 0
    const judge: ActualExecutionJudge = {
      name: "test-output-judge",
      version: "v1",
      model: "fixture-judge",
      async evaluate() {
        calls += 1
        return {
          verdict: "fully_realized",
          rationale: "The requested color is present in the frozen output.",
          evidence: [{
            path: "src/theme.ts",
            startLine: 1,
            endLine: 1,
            excerpt: "accent = 'maroon'",
            description: "Frozen source uses the requested accent.",
          }],
        }
      },
    }

    const first = await evaluateStudyActualExecution({
      participantDataDirs: [fixture.dataDir],
      outputDir: fixture.outputDir,
      judge,
      now: () => new Date("2026-08-20T01:00:00.000Z"),
    })
    const firstBytes = await readFile(join(fixture.outputDir, "actual-execution.json"), "utf8")
    const second = await evaluateStudyActualExecution({
      participantDataDirs: [fixture.dataDir],
      outputDir: fixture.outputDir,
      judge,
      now: () => new Date("2026-08-21T01:00:00.000Z"),
    })

    expect(calls).toBe(1)
    expect(second).toEqual(first)
    expect(second.records[0]!.evaluatedAt).toBe("2026-08-20T01:00:00.000Z")
    expect(await readFile(join(fixture.outputDir, "actual-execution.json"), "utf8")).toBe(firstBytes)
  })

  test("records a judge failure as durable uncertain evidence instead of not realized", async () => {
    const fixture = await makeFrozenParticipant()
    const judge: ActualExecutionJudge = {
      name: "test-output-judge",
      version: "v1",
      model: "fixture-judge",
      async evaluate() {
        throw new Error("provider unavailable")
      },
    }

    const document = await evaluateStudyActualExecution({
      participantDataDirs: [fixture.dataDir],
      outputDir: fixture.outputDir,
      judge,
      now: () => new Date("2026-08-20T01:00:00.000Z"),
    })

    expect(document.records[0]).toMatchObject({ verdict: "uncertain" })
    const artifact = JSON.parse(await readFile(
      join(fixture.outputDir, document.records[0]!.evidenceRef),
      "utf8",
    ))
    expect(artifact.result).toEqual({
      verdict: "uncertain",
      rationale: "The evaluator failed before it could determine actual execution (Error: provider unavailable).",
      evidence: [],
    })
    const dataset = buildStudyDataExport({
      participantDataDirs: [fixture.dataDir],
      actualExecutionEvidence: actualExecutionEvidenceFromFile(join(fixture.outputDir, "actual-execution.json")),
    })
    expect(dataset.memoryItems[0]).toMatchObject({
      actualExecutionStatus: "uncertain",
      measurements: {
        controlAccuracy: { status: "unavailable", realized: null, reason: "actual_execution_uncertain" },
      },
    })
  })

  test("refuses a mutated frozen workspace before the judge sees it", async () => {
    const fixture = await makeFrozenParticipant()
    const frozenFile = join(
      fixture.dataDir,
      "experiments",
      "workspace-snapshots",
      "038-S1",
      "freeze-038-s1",
      "workspace",
      "src",
      "theme.ts",
    )
    await chmod(frozenFile, 0o600)
    await writeFile(frozenFile, "export const accent = 'blue'\n")
    let calls = 0
    const judge: ActualExecutionJudge = {
      name: "test-output-judge",
      version: "v1",
      model: "fixture-judge",
      async evaluate() {
        calls += 1
        return { verdict: "uncertain", rationale: "Should not run.", evidence: [] }
      },
    }

    await expect(evaluateStudyActualExecution({
      participantDataDirs: [fixture.dataDir],
      outputDir: fixture.outputDir,
      judge,
    })).rejects.toThrow("Study workspace snapshot verification failed")
    expect(calls).toBe(0)
  })
})
