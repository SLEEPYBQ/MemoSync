import { describe, expect, test } from "bun:test"
import {
  createGuideNavigation,
  currentGuideStepId,
  guidePrimaryAction,
  reduceGuideNavigation,
  type GuideNavigationStep,
} from "./guideNavigation"

const steps: GuideNavigationStep[] = [
  { id: "system.setup", chapter: "system_use" },
  { id: "system.prompt", chapter: "system_use" },
  { id: "system.board", chapter: "system_use" },
  { id: "task.instructions", chapter: "experiment_workflow" },
  { id: "task.finish", chapter: "experiment_workflow" },
]

describe("Guide section navigation", () => {
  test("opens System use by default and advances only inside that section", () => {
    const initial = createGuideNavigation(steps)
    const advanced = reduceGuideNavigation(initial, { type: "next" }, steps)

    expect(initial.activeSection).toBe("system_use")
    expect(currentGuideStepId(initial, steps)).toBe("system.setup")
    expect(currentGuideStepId(advanced, steps)).toBe("system.prompt")
    expect(advanced.stepIdBySection.experiment_workflow).toBe("task.instructions")
  })

  test("switches both directions and preserves each section's own position", () => {
    let state = createGuideNavigation(steps)
    state = reduceGuideNavigation(state, { type: "next" }, steps)
    state = reduceGuideNavigation(state, { type: "switch_section", section: "experiment_workflow" }, steps)
    state = reduceGuideNavigation(state, { type: "next" }, steps)
    expect(currentGuideStepId(state, steps)).toBe("task.finish")

    state = reduceGuideNavigation(state, { type: "switch_section", section: "system_use" }, steps)
    expect(currentGuideStepId(state, steps)).toBe("system.prompt")

    state = reduceGuideNavigation(state, { type: "switch_section", section: "experiment_workflow" }, steps)
    expect(currentGuideStepId(state, steps)).toBe("task.finish")
  })

  test("clamps Next and Back within each section and survives missing saved ids", () => {
    let state = createGuideNavigation(steps)
    state = reduceGuideNavigation(state, { type: "back" }, steps)
    expect(currentGuideStepId(state, steps)).toBe("system.setup")

    state = reduceGuideNavigation(state, { type: "go_to_step", id: "system.board" }, steps)
    state = reduceGuideNavigation(state, { type: "next" }, steps)
    expect(currentGuideStepId(state, steps)).toBe("system.board")

    const stale = {
      ...state,
      stepIdBySection: { ...state.stepIdBySection, system_use: "removed.step" },
    }
    expect(currentGuideStepId(stale, steps)).toBe("system.setup")
  })

  test("Task can finish without turning optional System practice into a completion gate", () => {
    const systemEnd = reduceGuideNavigation(
      createGuideNavigation(steps),
      { type: "go_to_step", id: "system.board" },
      steps,
    )
    expect(guidePrimaryAction(systemEnd, steps)).toBe("switch_to_task")

    const taskEnd = reduceGuideNavigation(
      systemEnd,
      { type: "go_to_step", id: "task.finish" },
      steps,
    )
    expect(guidePrimaryAction(taskEnd, steps)).toBe("finish")

    const systemCompleted = reduceGuideNavigation(
      taskEnd,
      { type: "complete_section", section: "system_use" },
      steps,
    )
    expect(guidePrimaryAction(systemCompleted, steps)).toBe("finish")
  })
})
