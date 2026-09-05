import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { LlmJsonCaller } from "../memory/deepseek"
import type {
  ActualExecutionEvidenceLocation,
  ActualExecutionJudge,
  ActualExecutionJudgeInput,
  ActualExecutionJudgeResult,
} from "./study-actual-execution"

const MAX_FILE_BYTES = 256 * 1024
const MAX_FILE_CHARACTERS = 32_000
const MAX_DOSSIER_CHARACTERS = 160_000
const MAX_INDEX_CHARACTERS = 30_000

const HIGH_VALUE_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".jsx", ".json", ".md", ".mjs", ".prisma", ".py",
  ".scss", ".sql", ".ts", ".tsx", ".vue", ".yaml", ".yml",
])

const SYSTEM_PROMPT = `You are an external research evaluator judging actual execution E_i from a frozen coding output.

Judge exactly one Desired Memory against only the supplied frozen source evidence. The participant's questionnaire self-report is never provided and must never be inferred. Official task checks explain the task but are not pass/fail results and cannot be copied into the memory verdict.

Return one JSON object with exactly:
{
  "verdict": "fully_realized" | "partially_realized" | "not_realized" | "not_applicable" | "uncertain",
  "rationale": "specific evidence-based explanation",
  "evidence": [{
    "path": "relative/source/path",
    "startLine": 1,
    "endLine": 1,
    "excerpt": "exact text contained in that line range",
    "description": "why this source supports the verdict"
  }]
}

Verdict rules:
- fully_realized: frozen output clearly and completely implements the Desired Memory.
- partially_realized: frozen output implements a material part but is incomplete.
- not_realized: frozen output provides affirmative evidence that the Desired Memory was not implemented or was contradicted. Mere inability to find it is insufficient.
- not_applicable: this Desired Memory has no applicable object or opportunity in this task output.
- uncertain: supplied frozen source is insufficient or ambiguous.

fully_realized, partially_realized, and not_realized require at least one exact source citation. Never turn uncertainty, missing files, or partial realization into not_realized.`

export interface FrozenSourceActualExecutionJudgeOptions {
  callJson: LlmJsonCaller
  modelId: string
  evaluatorVersion: string
}

interface WorkspaceFile {
  relativePath: string
  absolutePath: string
  size: number
  score: number
}

function tokens(input: ActualExecutionJudgeInput): string[] {
  return [...new Set(
    [input.desired.content, ...input.task.brief]
      .join(" ")
      .toLowerCase()
      .match(/[a-z0-9_-]{3,}/g) ?? [],
  )]
}

function pathScore(relativePath: string, desiredTokens: string[]): number {
  const lower = relativePath.toLowerCase()
  if (
    lower.endsWith(".lock")
    || lower.includes("package-lock")
    || lower.includes("yarn.lock")
    || lower.endsWith(".map")
  ) return -1_000
  let score = desiredTokens.reduce((total, token) => total + (lower.includes(token) ? 100 : 0), 0)
  if (HIGH_VALUE_EXTENSIONS.has(path.extname(lower))) score += 20
  if (lower.startsWith("src/") || lower.includes("/src/") || lower.startsWith("app/")) score += 15
  if (/^(package\.json|dockerfile|readme\.md)$/i.test(relativePath)) score += 5
  return score
}

async function listWorkspaceFiles(root: string, desiredTokens: string[]): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = []
  async function visit(directory: string, parts: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const childParts = [...parts, entry.name]
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, childParts)
        continue
      }
      if (!entry.isFile()) continue
      const file = Bun.file(absolutePath)
      files.push({
        relativePath: childParts.join("/"),
        absolutePath,
        size: file.size,
        score: pathScore(childParts.join("/"), desiredTokens),
      })
    }
  }
  await visit(root, [])
  return files
}

function lineNumbered(relativePath: string, source: string): string {
  const numbered = source.split(/\r?\n/).map((line, index) => `${index + 1} | ${line}`).join("\n")
  return `FILE ${relativePath}\n${numbered}\nEND FILE ${relativePath}`
}

async function buildFrozenSourceDossier(input: ActualExecutionJudgeInput): Promise<string> {
  const files = await listWorkspaceFiles(input.workspaceRoot, tokens(input))
  const index = files.map((file) => file.relativePath).join("\n").slice(0, MAX_INDEX_CHARACTERS)
  const selected = files
    .filter((file) => file.score > -1_000 && file.size <= MAX_FILE_BYTES)
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
  const sections: string[] = []
  let used = 0
  for (const file of selected) {
    let source: string
    try {
      source = await readFile(file.absolutePath, "utf8")
    } catch {
      continue
    }
    if (source.includes("\0")) continue
    const section = lineNumbered(file.relativePath, source.slice(0, MAX_FILE_CHARACTERS))
    if (used + section.length > MAX_DOSSIER_CHARACTERS) continue
    sections.push(section)
    used += section.length
  }
  if (sections.length === 0) throw new Error("No readable frozen source was available for evaluation")
  return `Workspace file index:\n${index}\n\nSelected frozen source:\n${sections.join("\n\n")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseEvidence(value: unknown): ActualExecutionEvidenceLocation | null {
  if (!isRecord(value)) return null
  if (
    typeof value.path !== "string"
    || typeof value.startLine !== "number"
    || typeof value.endLine !== "number"
    || typeof value.excerpt !== "string"
    || typeof value.description !== "string"
  ) return null
  return {
    path: value.path,
    startLine: value.startLine,
    endLine: value.endLine,
    excerpt: value.excerpt,
    description: value.description,
  }
}

function parseJudgeResult(raw: Record<string, unknown>): ActualExecutionJudgeResult {
  const verdict = raw.verdict
  if (
    verdict !== "fully_realized"
    && verdict !== "partially_realized"
    && verdict !== "not_realized"
    && verdict !== "not_applicable"
    && verdict !== "uncertain"
  ) throw new Error("Source evaluator returned an invalid verdict")
  if (typeof raw.rationale !== "string" || !raw.rationale.trim() || !Array.isArray(raw.evidence)) {
    throw new Error("Source evaluator returned malformed rationale or evidence")
  }
  const evidence = raw.evidence.map(parseEvidence)
  if (evidence.some((entry) => entry === null)) throw new Error("Source evaluator returned malformed evidence")
  return { verdict, rationale: raw.rationale, evidence: evidence as ActualExecutionEvidenceLocation[] }
}

function userPrompt(input: ActualExecutionJudgeInput, dossier: string): string {
  const checks = input.task.officialChecks.map((check, index) => (
    `${index + 1}. [${check.kind}] ${check.instruction}\n   Expected: ${check.expectedResult}`
  )).join("\n")
  return [
    `Binding: participant=${input.participantId}; task=${input.taskId}; snapshot=${input.snapshotId}; probe=${input.probeId}`,
    `Desired Scope: ${input.desired.scope}`,
    `Desired Memory:\n${input.desired.content}`,
    `Task brief:\n${input.task.brief.join("\n")}`,
    `Official checks are task context only, not observed results:\n${checks}`,
    dossier,
  ].join("\n\n")
}

export function createFrozenSourceActualExecutionJudge(
  options: FrozenSourceActualExecutionJudgeOptions,
): ActualExecutionJudge {
  if (!options.modelId.trim()) throw new Error("modelId is required")
  if (!options.evaluatorVersion.trim()) throw new Error("evaluatorVersion is required")
  return {
    name: "memosync-frozen-source-judge",
    version: `${options.evaluatorVersion}+${options.modelId}`,
    model: options.modelId,
    async evaluate(input) {
      const dossier = await buildFrozenSourceDossier(input)
      const raw = await options.callJson({
        system: SYSTEM_PROMPT,
        user: userPrompt(input, dossier),
        maxTokens: 6_000,
        timeoutMs: 120_000,
        reasoningEffort: "max",
      })
      return parseJudgeResult(raw)
    },
  }
}
