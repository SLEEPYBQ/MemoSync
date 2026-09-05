import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { STUDY_BRIEFS } from "../study-briefs"
import {
  verifyStudyWorkspaceSnapshot,
  type StudyWorkspaceSnapshotMetadata,
} from "../study-workspace-snapshot"
import {
  buildStudyDataExport,
  resolveParticipantStudyDataDir,
  type ActualExecutionVerdict,
  type JsonActualExecutionEvidenceDocument,
} from "./study-data-export"

export interface ActualExecutionTaskCheck {
  kind: "ui" | "backend" | "design"
  instruction: string
  expectedResult: string
}

export interface ActualExecutionTaskContext {
  brief: string[]
  /** Official task checks are context, never a per-memory verdict shortcut. */
  officialChecks: ActualExecutionTaskCheck[]
}

const STUDY_ACTUAL_EXECUTION_TASKS: Record<string, ActualExecutionTaskContext> = {
  "038-S1": {
    brief: STUDY_BRIEFS["038-S1"]!,
    officialChecks: [
      { kind: "ui", instruction: "Search apartments by location.", expectedResult: "Relevant apartments are displayed." },
      { kind: "ui", instruction: "Filter apartment results to one bedroom.", expectedResult: "Only one-bedroom apartments remain." },
      { kind: "design", instruction: "Inspect the application theme.", expectedResult: "The background is linen and component highlights are maroon." },
    ],
  },
  "038-S2": {
    brief: STUDY_BRIEFS["038-S2"]!,
    officialChecks: [
      { kind: "ui", instruction: "Book an apartment for available dates.", expectedResult: "A confirmation appears and booked dates become unavailable." },
      { kind: "ui", instruction: "Open booking records.", expectedResult: "Past and current booking details are accurate." },
      { kind: "ui", instruction: "Navigate home from another page.", expectedResult: "The home page loads and remains functional." },
    ],
  },
  "098-S1": {
    brief: STUDY_BRIEFS["098-S1"]!,
    officialChecks: [
      { kind: "ui", instruction: "Browse available rental cars.", expectedResult: "Cars and their details are displayed." },
      { kind: "ui", instruction: "Choose a car and rental dates.", expectedResult: "Availability for the selected dates is shown." },
      { kind: "ui", instruction: "Continue to booking confirmation.", expectedResult: "The summary includes car, dates, and total cost." },
      { kind: "design", instruction: "Inspect the application theme.", expectedResult: "The background is papaya whip and components are dark orange." },
    ],
  },
  "098-S2": {
    brief: STUDY_BRIEFS["098-S2"]!,
    officialChecks: [
      { kind: "backend", instruction: "Complete a booking with a supported payment method.", expectedResult: "Payment succeeds and a booking reference is recorded." },
      { kind: "backend", instruction: "Retrieve, update, or cancel an existing order.", expectedResult: "Order state reflects the requested action." },
    ],
  },
}

export interface ActualExecutionEvidenceLocation {
  path: string
  startLine: number
  endLine: number
  excerpt: string
  description: string
}

export interface ActualExecutionJudgeResult {
  verdict: ActualExecutionVerdict
  rationale: string
  evidence: ActualExecutionEvidenceLocation[]
}

export interface ActualExecutionJudgeInput {
  participantId: string
  taskId: string
  snapshotId: string
  probeId: string
  desired: {
    content: string
    scope: "session" | "project" | "personal"
  }
  task: ActualExecutionTaskContext
  workspace: StudyWorkspaceSnapshotMetadata
  /** Verified frozen tree. The judge must never inspect the participant's live workspace. */
  workspaceRoot: string
}

export interface ActualExecutionJudge {
  readonly name: string
  readonly version: string
  readonly model: string
  evaluate(input: ActualExecutionJudgeInput): Promise<ActualExecutionJudgeResult>
}

export interface EvaluateStudyActualExecutionInput {
  participantDataDirs: string[]
  outputDir: string
  judge: ActualExecutionJudge
  includeInternalQa?: boolean
  now?: () => Date
}

export class StudyActualExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StudyActualExecutionError"
  }
}

interface ActualExecutionEvidenceArtifact {
  schemaVersion: 1
  inputHash: string
  binding: {
    participantId: string
    taskId: string
    snapshotId: string
    probeId: string
    desiredContentSha256: string
  }
  desired: ActualExecutionJudgeInput["desired"]
  task: ActualExecutionTaskContext
  workspace: StudyWorkspaceSnapshotMetadata
  evaluator: { name: string; version: string; model: string }
  evaluatedAt: string
  result: ActualExecutionJudgeResult
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isExistingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST"
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new StudyActualExecutionError(`${label} must be a non-empty string`)
  return value
}

function uncertainJudgeFailure(error: unknown): ActualExecutionJudgeResult {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const reason = raw.replaceAll(/\s+/g, " ").trim().slice(0, 500) || "unknown error"
  return {
    verdict: "uncertain",
    rationale: `The evaluator failed before it could determine actual execution (${reason}).`,
    evidence: [],
  }
}

function safePathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new StudyActualExecutionError(`Unsafe ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

function assertRelativeEvidencePath(value: string): void {
  if (
    !value
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new StudyActualExecutionError(`Judge returned an unsafe evidence path: ${JSON.stringify(value)}`)
  }
}

async function validateJudgeResult(
  result: ActualExecutionJudgeResult,
  workspaceRoot: string,
): Promise<ActualExecutionJudgeResult> {
  if (
    !result
    || ![
      "fully_realized",
      "partially_realized",
      "not_realized",
      "not_applicable",
      "uncertain",
    ].includes(result.verdict)
  ) {
    throw new StudyActualExecutionError("Judge returned an invalid actual-execution verdict")
  }
  requireNonEmpty(result.rationale, "Judge rationale")
  if (!Array.isArray(result.evidence)) {
    throw new StudyActualExecutionError("Judge evidence must be an array")
  }
  if (
    ["fully_realized", "partially_realized", "not_realized"].includes(result.verdict)
    && result.evidence.length === 0
  ) {
    throw new StudyActualExecutionError(`${result.verdict} requires at least one frozen-output evidence location`)
  }
  if (result.evidence.length > 50) throw new StudyActualExecutionError("Judge returned too many evidence locations")

  for (const [index, evidence] of result.evidence.entries()) {
    assertRelativeEvidencePath(evidence.path)
    if (
      !Number.isSafeInteger(evidence.startLine)
      || !Number.isSafeInteger(evidence.endLine)
      || evidence.startLine < 1
      || evidence.endLine < evidence.startLine
    ) {
      throw new StudyActualExecutionError(`Judge evidence ${index} has an invalid line range`)
    }
    requireNonEmpty(evidence.excerpt, `Judge evidence ${index} excerpt`)
    requireNonEmpty(evidence.description, `Judge evidence ${index} description`)
    let source: string
    try {
      source = await readFile(path.join(workspaceRoot, ...evidence.path.split("/")), "utf8")
    } catch {
      throw new StudyActualExecutionError(`Judge evidence ${index} does not reference a readable frozen-output file`)
    }
    const selected = source.split(/\r?\n/).slice(evidence.startLine - 1, evidence.endLine).join("\n")
    if (!selected.includes(evidence.excerpt)) {
      throw new StudyActualExecutionError(`Judge evidence ${index} excerpt does not match the frozen output`)
    }
  }
  return result
}

async function publishImmutable(destination: string, body: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, body, "utf8")
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!isExistingPathError(error)) throw error
      const existing = await readFile(destination, "utf8")
      if (existing !== body) {
        throw new StudyActualExecutionError(`Immutable output already exists with different content: ${destination}`)
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function artifactInputHash(input: ActualExecutionJudgeInput, judge: ActualExecutionJudge): string {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    binding: {
      participantId: input.participantId,
      taskId: input.taskId,
      snapshotId: input.snapshotId,
      probeId: input.probeId,
    },
    desired: input.desired,
    task: input.task,
    workspace: input.workspace,
    evaluator: { name: judge.name, version: judge.version, model: judge.model },
  }))
}

function actualExecutionRecord(
  artifact: ActualExecutionEvidenceArtifact,
  evidenceRef: string,
  evidenceSha256: string,
): JsonActualExecutionEvidenceDocument["records"][number] {
  return {
    participantId: artifact.binding.participantId,
    taskId: artifact.binding.taskId,
    snapshotId: artifact.binding.snapshotId,
    probeId: artifact.binding.probeId,
    workspaceTreeHash: artifact.workspace.treeHash,
    desiredContentSha256: artifact.binding.desiredContentSha256,
    verdict: artifact.result.verdict,
    evaluator: artifact.evaluator,
    evaluatedAt: artifact.evaluatedAt,
    evidenceRef,
    evidenceSha256,
  }
}

async function readExistingArtifact(input: {
  evidencePath: string
  inputHash: string
  judgeInput: ActualExecutionJudgeInput
  judge: ActualExecutionJudge
}): Promise<{ artifact: ActualExecutionEvidenceArtifact; body: string } | null> {
  let body: string
  try {
    body = await readFile(input.evidencePath, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new StudyActualExecutionError(`Existing evidence artifact is malformed: ${input.evidencePath}`)
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.inputHash !== input.inputHash) {
    throw new StudyActualExecutionError(`Existing evidence artifact has a stale input binding: ${input.evidencePath}`)
  }
  const artifact = raw as unknown as ActualExecutionEvidenceArtifact
  const expectedBinding = {
    participantId: input.judgeInput.participantId,
    taskId: input.judgeInput.taskId,
    snapshotId: input.judgeInput.snapshotId,
    probeId: input.judgeInput.probeId,
    desiredContentSha256: sha256(input.judgeInput.desired.content),
  }
  if (
    JSON.stringify(artifact.binding) !== JSON.stringify(expectedBinding)
    || JSON.stringify(artifact.desired) !== JSON.stringify(input.judgeInput.desired)
    || JSON.stringify(artifact.task) !== JSON.stringify(input.judgeInput.task)
    || JSON.stringify(artifact.workspace) !== JSON.stringify(input.judgeInput.workspace)
    || artifact.evaluator?.name !== input.judge.name
    || artifact.evaluator?.version !== input.judge.version
    || artifact.evaluator?.model !== input.judge.model
    || !isCanonicalIsoTimestamp(artifact.evaluatedAt)
  ) {
    throw new StudyActualExecutionError(`Existing evidence artifact contradicts the frozen input: ${input.evidencePath}`)
  }
  await validateJudgeResult(artifact.result, input.judgeInput.workspaceRoot)
  return { artifact, body }
}

/**
 * Evaluate each canonical Desired Memory against its verified frozen workspace.
 * The returned document is the only evaluator output consumed by study:export;
 * detailed reasoning remains in immutable per-probe artifacts referenced by it.
 */
export async function evaluateStudyActualExecution(
  input: EvaluateStudyActualExecutionInput,
): Promise<JsonActualExecutionEvidenceDocument> {
  requireNonEmpty(input.judge.name, "Evaluator name")
  requireNonEmpty(input.judge.version, "Evaluator version")
  requireNonEmpty(input.judge.model, "Evaluator model")
  const participantSources = new Map<string, string>()
  for (const source of [...new Set(input.participantDataDirs.map((value) => path.resolve(value)))].sort()) {
    const one = buildStudyDataExport({ participantDataDirs: [source], includeInternalQa: true })
    if (one.participants.length !== 1) {
      throw new StudyActualExecutionError(`Expected one participant source at ${source}`)
    }
    const participantId = one.participants[0]!.participantId
    if (participantSources.has(participantId)) {
      throw new StudyActualExecutionError(`Duplicate participant source: ${participantId}`)
    }
    participantSources.set(participantId, resolveParticipantStudyDataDir(source))
  }

  const dataset = buildStudyDataExport({
    participantDataDirs: input.participantDataDirs,
    includeInternalQa: input.includeInternalQa,
  })
  const records: JsonActualExecutionEvidenceDocument["records"] = []
  for (const row of dataset.memoryItems) {
    if (row.desired?.presence !== "present" || !row.desired.content || !row.desired.scope) continue
    if (!row.workspaceSnapshot) {
      throw new StudyActualExecutionError(
        `Frozen workspace is missing for ${row.participantId}/${row.taskId}/${row.probeId}`,
      )
    }
    const dataDir = participantSources.get(row.participantId)
    if (!dataDir) throw new StudyActualExecutionError(`Participant source is missing for ${row.participantId}`)
    await verifyStudyWorkspaceSnapshot(dataDir, row.workspaceSnapshot)
    const workspaceRoot = path.join(dataDir, ...row.workspaceSnapshot.exportedPath.split("/"))
    const task = STUDY_ACTUAL_EXECUTION_TASKS[row.taskId]
    if (!task) throw new StudyActualExecutionError(`Evaluation task context is missing for ${row.taskId}`)
    const judgeInput: ActualExecutionJudgeInput = {
      participantId: row.participantId,
      taskId: row.taskId,
      snapshotId: row.snapshotId,
      probeId: row.probeId,
      desired: { content: row.desired.content, scope: row.desired.scope },
      task,
      workspace: row.workspaceSnapshot,
      workspaceRoot,
    }
    const inputHash = artifactInputHash(judgeInput, input.judge)
    const participantSegment = safePathSegment(row.participantId, "participantId")
    const taskSegment = safePathSegment(row.taskId, "taskId")
    const probeSegment = safePathSegment(row.probeId, "probeId")
    const evidenceRef = path.posix.join("evidence", participantSegment, taskSegment, `${probeSegment}-${inputHash}.json`)
    const evidencePath = path.join(input.outputDir, ...evidenceRef.split("/"))
    const existingArtifact = await readExistingArtifact({ evidencePath, inputHash, judgeInput, judge: input.judge })
    let artifact: ActualExecutionEvidenceArtifact
    let artifactBody: string
    if (existingArtifact) {
      artifact = existingArtifact.artifact
      artifactBody = existingArtifact.body
    } else {
      let result: ActualExecutionJudgeResult
      try {
        result = await validateJudgeResult(await input.judge.evaluate(judgeInput), workspaceRoot)
      } catch (error) {
        result = uncertainJudgeFailure(error)
      }
      const evaluatedAt = (input.now ?? (() => new Date()))().toISOString()
      artifact = {
        schemaVersion: 1,
        inputHash,
        binding: {
          participantId: row.participantId,
          taskId: row.taskId,
          snapshotId: row.snapshotId,
          probeId: row.probeId,
          desiredContentSha256: sha256(row.desired.content),
        },
        desired: judgeInput.desired,
        task,
        workspace: row.workspaceSnapshot,
        evaluator: { name: input.judge.name, version: input.judge.version, model: input.judge.model },
        evaluatedAt,
        result,
      }
      artifactBody = `${JSON.stringify(artifact, null, 2)}\n`
      await publishImmutable(evidencePath, artifactBody)
    }
    records.push(actualExecutionRecord(artifact, evidenceRef, sha256(artifactBody)))
  }
  records.sort((left, right) => {
    const leftKey = `${left.participantId}\0${left.taskId}\0${left.probeId}`
    const rightKey = `${right.participantId}\0${right.taskId}\0${right.probeId}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const document: JsonActualExecutionEvidenceDocument = { schemaVersion: 2, records }
  await publishImmutable(path.join(input.outputDir, "actual-execution.json"), `${JSON.stringify(document, null, 2)}\n`)
  return document
}
