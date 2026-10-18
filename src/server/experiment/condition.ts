export type ExperimentConditionName = "memosync"

export interface ConditionPolicy {
  condition: ExperimentConditionName
  capture: "review"
  preview: boolean
  trace: boolean
  boardVisible: boolean
  boardWritable: boolean
  bringIn: boolean
  injection: "skills"
  memoryTools: boolean
  /** Explicit MemoSync study mode isolates workspace settings from memory injection. */
  studyMode: boolean
}

export function resolveConditionPolicy(condition = process.env.EXPERIMENT_CONDITION): ConditionPolicy {
  if (condition && condition !== "memosync") {
    console.warn(`[experiment] unsupported EXPERIMENT_CONDITION "${condition}" — using MemoSync`)
  }
  return {
    condition: "memosync",
    capture: "review",
    preview: true,
    trace: true,
    boardVisible: true,
    boardWritable: true,
    bringIn: true,
    injection: "skills",
    memoryTools: true,
    studyMode: condition === "memosync",
  }
}
