import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  buildAutoSteps,
  buildMemoSyncSteps,
  buildStaticSteps,
} from "./guideJourneySteps"
import {
  buildAutoSteps as buildSourceAutoSteps,
  buildMemoSyncSteps as buildSourceMemoSyncSteps,
  buildStaticSteps as buildSourceStaticSteps,
} from "./tourSteps"
import type { TourStep } from "./GuideTour"

function copy(steps: TourStep[]) {
  return steps
    .map((step) => `${step.title} ${renderToStaticMarkup(<div>{step.body}</div>)}`)
    .join("\n")
}

function ids(steps: TourStep[]) {
  return steps.map((step) => step.id)
}

const SHARED_START = [
  "system.welcome",
  "task.sessions",
  "task.instructions",
  "shared.practice-task",
  "system.session-setup",
  "system.empty-chat",
  "system.first-prompt",
]

const POST_SESSION = [
  "task.finish",
  "task.finish-practice",
  "task.freeze",
  "task.memory-questionnaire",
  "task.monitoring-tlx",
  "task.control-tlx",
  "task.next-session",
  "task.sus",
  "task.complete",
]

describe("participant-facing Guide journey", () => {
  const tours = [buildMemoSyncSteps(), buildAutoSteps(), buildStaticSteps()]

  test("all conditions follow the same task start and post-session sequence", () => {
    for (const steps of tours) {
      expect(ids(steps).slice(0, SHARED_START.length)).toEqual(SHARED_START)
      expect(ids(steps).slice(-POST_SESSION.length)).toEqual(POST_SESSION)
      expect(steps.find((step) => step.id === "task.sessions")?.chapter).toBe("experiment_workflow")
      expect(steps.find((step) => step.id === "task.instructions")?.chapter).toBe("experiment_workflow")
      expect(steps.find((step) => step.id === "task.finish")?.chapter).toBe("experiment_workflow")
      expect(
        steps
          .filter((step) => step.chapter === "experiment_workflow")
          .slice(0, 2)
          .map((step) => step.id),
      ).toEqual(["task.sessions", "task.instructions"])
    }
  })

  test("explains the frozen questionnaire with focused-memory and applied-output semantics", () => {
    for (const steps of tours) {
      const questionnaire = steps.find((step) => step.id === "task.memory-questionnaire")
      const html = renderToStaticMarkup(<div>{questionnaire?.body}</div>)

      expect(html).toContain("each distinct memory that was actually focused during this session")
      expect(html).toContain("whether the agent applied it in the session output")
      expect(html).not.toContain("each memory used during the session")
      expect(html).not.toContain("whether it affected the output")
    }
  })

  test("keeps optional practice truthful when a participant advances without acting", () => {
    const steps = buildMemoSyncSteps()
    const textById = new Map(steps.map((step) => [
      step.id,
      renderToStaticMarkup(<div>{step.body}</div>),
    ]))

    for (const id of [
      "memosync.opening-board",
      "memosync.candidate-summary",
      "memosync.candidate-reopened",
      "memosync.streaming",
      "memosync.resumed",
    ]) {
      expect(textById.get(id), id).toContain("This example")
    }

    for (const [id, html] of textById) {
      if (html.includes("Optional practice")) expect(html, id).toContain("Next")
    }
  })

  test("preserves the formal task-instruction and compensation rule", () => {
    for (const steps of tours) {
      const instructions = steps.find((step) => step.id === "task.instructions")
      const html = renderToStaticMarkup(<div>{instructions?.body}</div>)

      expect(html).toContain("browser developer tools")
      expect(html).toContain("all or a substantially verbatim part")
      expect(html).toContain("A violation makes your participation ineligible for compensation")
    }
  })

  test("labels the final completion surface as a non-submitting Guide preview", () => {
    for (const steps of tours) {
      const completion = steps.find((step) => step.id === "task.complete")
      const html = renderToStaticMarkup(<div>{completion?.body}</div>)

      expect(completion?.title).toBe("Preview the final completion page")
      expect(html).toContain("Reaching this preview inside the Guide records nothing")
      expect(html).toContain("does not mean the study is complete")
      expect(html).not.toContain("This page means the study is complete")
    }
  })

  test("the choreography preserves every source lesson and only adds the shared practice task", () => {
    const pairs = [
      [buildSourceMemoSyncSteps(), buildMemoSyncSteps()],
      [buildSourceAutoSteps(), buildAutoSteps()],
      [buildSourceStaticSteps(), buildStaticSteps()],
    ] as const

    for (const [source, journey] of pairs) {
      expect(new Set(ids(journey).filter((id) => id !== "shared.practice-task"))).toEqual(new Set(ids(source)))
      expect(new Set(ids(journey)).size).toBe(journey.length)
    }
  })

  test("MemoSync teaches one Long-term Memory system through two synchronized views", () => {
    const html = copy(buildMemoSyncSteps())
    expect(html).toContain("Long-term Memory Management has two synchronized views")
    expect(html).toContain("the Memory Board and review cards inside the chat")
    expect(html).toContain("A change in either view appears in the other")
    expect(html).toContain("The Memory Board and chat stay synchronized")
    expect(html).toContain("Working Memory is selected separately")
  })

  test("MemoSync follows the paper's four connected monitoring and control activities", () => {
    const html = copy(buildMemoSyncSteps())
    expect(html).toContain("Review and decide")
    expect(html).toContain("Inspect and adjust")
    expect(html).toContain("Trace and interrupt")
    expect(html).toContain("Audit and follow up")

    const order = ids(buildMemoSyncSteps())
    const required = [
      "memosync.opening-board",
      "memosync.long-term-card",
      "memosync.board-library",
      "memosync.transfer",
      "memosync.checkup",
      "memosync.working-memory-ask",
      "memosync.working-memory",
      "memosync.streaming",
      "memosync.live-record",
      "memosync.interrupt",
      "memosync.recovery",
      "memosync.audit",
      "memosync.enforce",
      "memosync.memory-record",
    ]
    expect(required.map((id) => order.indexOf(id))).toEqual(
      [...required.map((id) => order.indexOf(id))].sort((a, b) => a - b),
    )
  })

  test("the Guide uses participant-facing UI terms instead of implementation language", () => {
    const memoSync = copy(buildMemoSyncSteps())
    for (const forbidden of [
      "canonical store",
      "canonical status",
      "server-authoritative",
      "isolated memory store",
      "Visible Memory Pool",
      "re-curates",
      "focused for this turn",
    ]) {
      expect(memoSync).not.toContain(forbidden)
    }

    expect(memoSync).toContain("Long-term Memory Management")
    expect(memoSync).toContain("Working Memory for This Turn")
    expect(memoSync).toContain("Memory Record")
    expect(memoSync).toContain("Memory Use Audit")
  })

  test("the four Audit outcomes remain intact and are explained with the practice task", () => {
    const html = copy(buildMemoSyncSteps())
    expect(html).toContain("Shaped this turn")
    expect(html).toContain("Violated")
    expect(html).toContain("Not applicable this turn")
    expect(html).toContain("No visible effect")
    expect(html).toContain("M-02 shapes the shared cart action")
    expect(html).toContain("M-07 has no image to apply to")
  })

  test("baseline participants receive the same outer journey without MemoSync vocabulary", () => {
    for (const steps of [buildAutoSteps(), buildStaticSteps()]) {
      const html = copy(steps)
      expect(html).toContain("Practice shop")
      expect(html).toContain("Read the task brief first")
      expect(html).toContain("Finish the session when the task is complete")
      expect(html).not.toContain("MemoSync")
      expect(html).not.toContain("Memory Board")
      expect(html).not.toContain("Working Memory for This Turn")
      expect(html).not.toContain("Memory Use Audit")
    }
  })

  test("the shared practice task does not reveal experiment conditions", () => {
    for (const steps of tours) {
      const html = copy(steps)
      expect(html).toContain("use one task")
      expect(html).not.toContain("all three conditions")
    }
  })

  test("all mounted actions remain optional practice", () => {
    const memoSync = copy(buildMemoSyncSteps())
    expect(memoSync).toContain("Optional practice")
    expect(memoSync).toContain("or select <strong>Next</strong>")
    expect(memoSync).not.toContain("Complete the highlighted action")
  })

  test("the participant copy uses no em dash", () => {
    for (const steps of tours) expect(copy(steps)).not.toContain("—")
  })

  test("GuidePage uses the task-journey builders", async () => {
    const source = await Bun.file(new URL("./GuidePage.tsx", import.meta.url)).text()
    expect(source).toContain('from "./guideJourneySteps"')
    expect(source).not.toContain('from "./tourSteps"')
  })
})
