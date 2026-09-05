import { describe, expect, test } from "bun:test"
import { STUDY_TASKS } from "../../../shared/studyTasks"
import { STUDY_BRIEFS } from "../../../server/study-briefs"
import { QUIZ_FIELD_OPTIONS, QUIZ_SECTIONS } from "./studyQuizCopy"
import { findAssignedStudyProject } from "./studyProjectSelection"
import { classifyInstructionGuardKey } from "./ProtectedStudyInstructions"
import { STUDY_COMPLETION_MESSAGE, STUDY_COMPLETION_TITLE } from "./studyCompletionCopy"
import { getAssignedChatStartError } from "./StudyTaskPage"

describe("study task catalog", () => {
  test("turns assigned chat creation failure into an actionable local error", () => {
    expect(getAssignedChatStartError({ ok: false, error: "chat.create failed" })).toBe(
      "Could not open the assigned project chat: chat.create failed. Try again. If it still fails, stop here and ask the experimenter for help."
    )
  })

  test("all four session briefs exist server-side and are blinding-safe", () => {
    expect(STUDY_TASKS.map((t) => t.id)).toEqual(["038-S1", "038-S2", "098-S1", "098-S2"])
    for (const task of STUDY_TASKS) {
      const brief = STUDY_BRIEFS[task.id]
      const text = [task.title, ...(brief ?? [])].join(" ")
      expect(brief?.length).toBeGreaterThanOrEqual(3)
      expect(text.includes("MemoSync")).toBe(false)
      expect(text.includes("—")).toBe(false)
    }
  })

  test("the client-side catalog never carries brief text (no peeking ahead)", () => {
    for (const task of STUDY_TASKS) {
      expect("brief" in task).toBe(false)
    }
  })

  test("binds both sessions of each benchmark task to one persistent project", () => {
    expect(STUDY_TASKS.map(({ id, projectSlug, projectTitle }) => ({ id, projectSlug, projectTitle }))).toEqual([
      { id: "038-S1", projectSlug: "apartment", projectTitle: "Apartment rentals" },
      { id: "038-S2", projectSlug: "apartment", projectTitle: "Apartment rentals" },
      { id: "098-S1", projectSlug: "car", projectTitle: "Car rentals" },
      { id: "098-S2", projectSlug: "car", projectTitle: "Car rentals" },
    ])
  })

  test("selects only the server-issued project identity even when a spoof basename comes first", () => {
    const projects = [
      { groupKey: "spoof", localPath: "/tmp/unregistered/apartment" },
      { groupKey: "project-a", localPath: "/workspace/apartment" },
      { groupKey: "project-b", localPath: "C:\\workspace\\car\\" },
    ]
    expect(findAssignedStudyProject(projects, "project-a")?.groupKey).toBe("project-a")
    expect(findAssignedStudyProject(projects, "project-b")?.groupKey).toBe("project-b")
    expect(findAssignedStudyProject(projects, "missing")).toBeNull()
  })

  test("blocks ordinary copy and common DevTools shortcuts while instructions are visible", () => {
    const key = (overrides: Partial<KeyboardEvent>) => ({
      key: "",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    })
    expect(classifyInstructionGuardKey(key({ key: "c", metaKey: true }))).toBe("keyboard_copy")
    expect(classifyInstructionGuardKey(key({ key: "F12" }))).toBe("devtools_shortcut")
    expect(classifyInstructionGuardKey(key({ key: "i", ctrlKey: true, shiftKey: true }))).toBe("devtools_shortcut")
    expect(classifyInstructionGuardKey(key({ key: "a", metaKey: true }))).toBeNull()
  })
})

describe("quiz copy", () => {
  const questions = QUIZ_SECTIONS.flatMap((section) => section.questions)

  test("covers the design's three probes as five questions", () => {
    expect(QUIZ_SECTIONS.length).toBe(3)
    expect(questions.map((q) => q.field)).toEqual([
      "desiredContent",
      "desiredScope",
      "believedContent",
      "believedScope",
      "execution",
    ])
  })

  test("every question's options exactly cover its schema enum, in order", () => {
    for (const question of questions) {
      expect(question.options.map((o) => o.value)).toEqual([...QUIZ_FIELD_OPTIONS[question.field]])
    }
  })

  test("offers exactly one unknown response in questionnaire v2", () => {
    const unknownOptions = questions.flatMap((question) => question.options)
      .filter((option) => option.value === "unknown" || option.value === "unsure")
    expect(unknownOptions.map((option) => option.value)).toEqual(["unknown"])
  })

  test("wording is blinding-safe and em-dash-free", () => {
    const text = QUIZ_SECTIONS.flatMap((section) => [
      section.title,
      ...section.questions.flatMap((q) => [q.prompt, q.hint ?? "", ...q.options.map((o) => o.label)]),
    ]).join(" ")
    expect(text.includes("MemoSync")).toBe(false)
    expect(text.includes("—")).toBe(false)
    expect(text).toContain("the agent")
  })

  test("completion waits for grading before result and compensation notification", () => {
    const copy = `${STUDY_COMPLETION_TITLE} ${STUDY_COMPLETION_MESSAGE}`
    expect(copy).toContain("after grading")
    expect(copy).toContain("compensation decision")
    expect(copy).not.toContain("FullStack-Bench")
  })

  test("participant-visible client copy never names FullStack-Bench", async () => {
    // Study-owner cleanup 2026-08-20: remove exactly the phrase
    // FullStack-Bench from participant copy; broader terms stay untouched.
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")
    const root = new URL("../..", import.meta.url).pathname
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx|css|html)$/.test(entry) && !/\.test\./.test(entry)) {
          if (readFileSync(full, "utf8").includes("FullStack-Bench")) offenders.push(full)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
