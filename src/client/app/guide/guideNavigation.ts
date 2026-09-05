export type GuideSection = "system_use" | "experiment_workflow"

export interface GuideNavigationStep {
  readonly id: string
  readonly chapter: GuideSection
}

export interface GuideNavigationState {
  readonly activeSection: GuideSection
  readonly stepIdBySection: Record<GuideSection, string | null>
  readonly completedSections: Record<GuideSection, boolean>
}

export type GuideNavigationEvent =
  | { readonly type: "switch_section"; readonly section: GuideSection }
  | { readonly type: "next" }
  | { readonly type: "back" }
  | { readonly type: "go_to_step"; readonly id: string }
  | { readonly type: "complete_section"; readonly section: GuideSection }

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  "system_use",
  "experiment_workflow",
]

function sectionSteps(
  steps: readonly GuideNavigationStep[],
  section: GuideSection,
): readonly GuideNavigationStep[] {
  return steps.filter((step) => step.chapter === section)
}

function firstStepId(
  steps: readonly GuideNavigationStep[],
  section: GuideSection,
): string | null {
  return sectionSteps(steps, section)[0]?.id ?? null
}

export function createGuideNavigation(
  steps: readonly GuideNavigationStep[],
): GuideNavigationState {
  return {
    activeSection: "system_use",
    stepIdBySection: {
      system_use: firstStepId(steps, "system_use"),
      experiment_workflow: firstStepId(steps, "experiment_workflow"),
    },
    completedSections: {
      system_use: false,
      experiment_workflow: false,
    },
  }
}

export function currentGuideStepId(
  state: GuideNavigationState,
  steps: readonly GuideNavigationStep[],
): string | null {
  const candidates = sectionSteps(steps, state.activeSection)
  const saved = state.stepIdBySection[state.activeSection]
  return candidates.some((step) => step.id === saved)
    ? saved
    : candidates[0]?.id ?? null
}

export function reduceGuideNavigation(
  state: GuideNavigationState,
  event: GuideNavigationEvent,
  steps: readonly GuideNavigationStep[],
): GuideNavigationState {
  if (event.type === "switch_section") {
    return { ...state, activeSection: event.section }
  }

  if (event.type === "complete_section") {
    return {
      ...state,
      completedSections: {
        ...state.completedSections,
        [event.section]: true,
      },
    }
  }

  if (event.type === "go_to_step") {
    const target = steps.find((step) => step.id === event.id)
    if (!target) return state
    return {
      ...state,
      activeSection: target.chapter,
      stepIdBySection: {
        ...state.stepIdBySection,
        [target.chapter]: target.id,
      },
    }
  }

  const candidates = sectionSteps(steps, state.activeSection)
  if (candidates.length === 0) return state
  const currentId = currentGuideStepId(state, steps)
  const currentIndex = Math.max(0, candidates.findIndex((step) => step.id === currentId))
  const delta = event.type === "next" ? 1 : -1
  const nextIndex = Math.max(0, Math.min(currentIndex + delta, candidates.length - 1))
  return {
    ...state,
    stepIdBySection: {
      ...state.stepIdBySection,
      [state.activeSection]: candidates[nextIndex]?.id ?? candidates[0]!.id,
    },
  }
}

export function guideSectionProgress(
  state: GuideNavigationState,
  steps: readonly GuideNavigationStep[],
): { current: number; total: number; isFirst: boolean; isLast: boolean } {
  const candidates = sectionSteps(steps, state.activeSection)
  const currentId = currentGuideStepId(state, steps)
  const index = Math.max(0, candidates.findIndex((step) => step.id === currentId))
  return {
    current: candidates.length === 0 ? 0 : index + 1,
    total: candidates.length,
    isFirst: index <= 0,
    isLast: candidates.length === 0 || index >= candidates.length - 1,
  }
}

export type GuidePrimaryAction = "advance" | "switch_to_task" | "finish"

export function guidePrimaryAction(
  state: GuideNavigationState,
  steps: readonly GuideNavigationStep[],
): GuidePrimaryAction {
  const progress = guideSectionProgress(state, steps)
  if (!progress.isLast) return "advance"
  if (state.activeSection === "system_use") return "switch_to_task"
  return "finish"
}
