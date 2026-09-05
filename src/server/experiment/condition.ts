// Study-condition policy (SPEC §2/§6, STUDY_PLAN §2.2/§2.3): EXPERIMENT_CONDITION
// no longer just tags the log — it decides which memory behaviors exist. One
// place defines each arm; everything downstream (service construction, engine
// injection/tool registration, HTTP mutation gating, client surfaces) reads
// this policy.
//
// The three arms, operationalized (STUDY_PLAN §5):
// - memosync: the full system — memory-as-skills injection with [M-NN] ids +
//   citation rule + search/detail tools, capture→review cards, preview gate,
//   trace, operable Board, bring-in.
// - auto: "Auto-extract" — capture stores silently as ACTIVE; injection is a
//   PLAIN markdown list (no ids, no citations, no tools), matching today's
//   real-world baseline of an auto-generated CLAUDE.md-style file. No
//   monitoring/control surfaces at all.
// - static: "Static-config" — no capture, no items library in play; injection
//   reads the participant-maintained workspace files (MEMORY.md + memory/*.md)
//   verbatim each turn. No tools, no surfaces.

export type ExperimentConditionName = "memosync" | "static" | "auto"

export interface ConditionPolicy {
  condition: ExperimentConditionName
  /** How capture surfaces new memories: review card | silently active | disabled. */
  capture: "review" | "silent" | "off"
  preview: boolean
  trace: boolean
  boardVisible: boolean
  boardWritable: boolean
  bringIn: boolean
  /**
   * What the engine's memory injection looks like:
   * - "skills": short forms with [M-NN] ids + citation rule (+ tools if enabled)
   * - "plain":  content-only markdown list, indistinguishable from a CLAUDE.md
   * - "file":   verbatim contents of the workspace memory files
   */
  injection: "skills" | "plain" | "file"
  /** Whether the load_memory_detail tool is registered. */
  memoryTools: boolean
  /**
   * True when the researcher explicitly pinned an arm via EXPERIMENT_CONDITION.
   * In study mode the Claude SDK settingSources are narrowed to ["user"] so a
   * workspace CLAUDE.md cannot bypass the system's injection channel — this
   * applies to EVERY arm, or the manipulation isn't controlled.
   */
  studyMode: boolean
}

const POLICIES: Record<ExperimentConditionName, Omit<ConditionPolicy, "studyMode">> = {
  memosync: {
    condition: "memosync",
    capture: "review",
    preview: true,
    trace: true,
    boardVisible: true,
    boardWritable: true,
    bringIn: true,
    injection: "skills",
    memoryTools: true,
  },
  auto: {
    condition: "auto",
    capture: "silent",
    preview: false,
    trace: false,
    boardVisible: false,
    boardWritable: false,
    bringIn: false,
    injection: "plain",
    memoryTools: false,
  },
  static: {
    condition: "static",
    capture: "off",
    preview: false,
    trace: false,
    boardVisible: false,
    boardWritable: false,
    bringIn: false,
    injection: "file",
    memoryTools: false,
  },
}

export function resolveConditionPolicy(condition = process.env.EXPERIMENT_CONDITION): ConditionPolicy {
  if (condition === "auto" || condition === "static" || condition === "memosync") {
    return { ...POLICIES[condition], studyMode: true }
  }
  if (condition && condition !== "memosync") {
    console.warn(`[experiment] unknown EXPERIMENT_CONDITION "${condition}" — falling back to memosync`)
  }
  return { ...POLICIES.memosync, studyMode: false }
}
