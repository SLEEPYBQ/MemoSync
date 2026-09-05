import { describe, expect, test } from "bun:test"
import { STUDY_TASKS } from "./studyTasks"
import {
  attentionCheckMemoryIndex,
  getPublicStudyAttentionCheck,
  scoreStudyAttentionCheck,
} from "./studyAttentionChecks"

describe("formal study attention checks", () => {
  test("assigns one explicit instructed-response check to every session", () => {
    const checks = STUDY_TASKS.map((task) => getPublicStudyAttentionCheck(task.id))
    expect(checks.every(Boolean)).toBe(true)
    expect(new Set(checks.map((check) => check?.checkId)).size).toBe(4)
    for (const check of checks) {
      expect(check?.prompt).toContain("This is an attention check.")
      expect(check?.options).toHaveLength(4)
    }
  })

  test("scores on the server-owned task definition and rejects malformed responses", () => {
    expect(scoreStudyAttentionCheck("038-S1", {
      checkId: "attention-038-s1",
      selectedValue: "option_b",
    })).toEqual({ checkId: "attention-038-s1", selectedValue: "option_b", passed: true })
    expect(scoreStudyAttentionCheck("038-S1", {
      checkId: "attention-038-s1",
      selectedValue: "option_a",
    })?.passed).toBe(false)
    expect(scoreStudyAttentionCheck("038-S1", {
      checkId: "attention-098-s1",
      selectedValue: "option_b",
    })).toBeNull()
    expect(scoreStudyAttentionCheck("038-S1", {
      checkId: "attention-038-s1",
      selectedValue: "invented",
    })).toBeNull()
  })

  test("places the check on the middle memory page when memories exist", () => {
    expect(attentionCheckMemoryIndex(0)).toBeNull()
    expect(attentionCheckMemoryIndex(1)).toBe(0)
    expect(attentionCheckMemoryIndex(2)).toBe(0)
    expect(attentionCheckMemoryIndex(3)).toBe(1)
    expect(attentionCheckMemoryIndex(26)).toBe(12)
  })
})
