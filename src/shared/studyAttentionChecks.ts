import { STUDY_TASKS } from "./studyTasks"

export interface PublicStudyAttentionCheck {
  checkId: string
  prompt: string
  options: Array<{ value: string; label: string }>
}

export interface StudyAttentionCheckResponse {
  checkId: string
  selectedValue: string
}

export interface StudyAttentionCheckResult extends StudyAttentionCheckResponse {
  passed: boolean
}

interface StudyAttentionCheckDefinition extends PublicStudyAttentionCheck {
  correctValue: string
}

const OPTIONS = [
  { value: "option_a", label: "Option A" },
  { value: "option_b", label: "Option B" },
  { value: "option_c", label: "Option C" },
  { value: "option_d", label: "Option D" },
]

const CHECKS: Record<string, StudyAttentionCheckDefinition> = {
  "038-S1": {
    checkId: "attention-038-s1",
    prompt: "This is an attention check. To show that you are reading carefully, select Option B.",
    options: OPTIONS,
    correctValue: "option_b",
  },
  "038-S2": {
    checkId: "attention-038-s2",
    prompt: "This is an attention check. To show that you are reading carefully, select Option D.",
    options: OPTIONS,
    correctValue: "option_d",
  },
  "098-S1": {
    checkId: "attention-098-s1",
    prompt: "This is an attention check. To show that you are reading carefully, select Option A.",
    options: OPTIONS,
    correctValue: "option_a",
  },
  "098-S2": {
    checkId: "attention-098-s2",
    prompt: "This is an attention check. To show that you are reading carefully, select Option C.",
    options: OPTIONS,
    correctValue: "option_c",
  },
}

// Keep the formal task catalog and attention-check catalog in lockstep.
for (const task of STUDY_TASKS) {
  if (!CHECKS[task.id]) throw new Error(`Missing attention check for study task ${task.id}`)
}

export function getPublicStudyAttentionCheck(taskId: string): PublicStudyAttentionCheck | null {
  const check = CHECKS[taskId]
  if (!check) return null
  return {
    checkId: check.checkId,
    prompt: check.prompt,
    options: check.options.map((option) => ({ ...option })),
  }
}

export function scoreStudyAttentionCheck(
  taskId: string,
  raw: unknown,
): StudyAttentionCheckResult | null {
  const check = CHECKS[taskId]
  if (!check || !raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (
    Object.keys(record).length !== 2
    || record.checkId !== check.checkId
    || typeof record.selectedValue !== "string"
    || !check.options.some((option) => option.value === record.selectedValue)
  ) return null
  return {
    checkId: check.checkId,
    selectedValue: record.selectedValue,
    passed: record.selectedValue === check.correctValue,
  }
}

/** The check appears on the middle memory page, never systematically first or last. */
export function attentionCheckMemoryIndex(memoryCount: number): number | null {
  if (!Number.isInteger(memoryCount) || memoryCount <= 0) return null
  return Math.floor((memoryCount - 1) / 2)
}
