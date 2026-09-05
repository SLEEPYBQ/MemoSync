import { describe, expect, test } from "bun:test"
import { buildRawTlxResponse, buildSusResponse, parseStudyPostSessionPayload } from "./studyPostSession"
import type { StudyPostSessionPayload } from "./studyPostSession"

describe("parseStudyPostSessionPayload", () => {
  test("restores the server-required post-session step", () => {
    const payload = {
      taskId: "038-S1",
      snapshotId: "snapshot-1",
      requiredStep: "monitoring_tlx",
      nextTaskId: null,
      monitoringSubmitted: false,
      controlSubmitted: false,
      sessionCompleted: false,
      susSubmitted: false,
    } satisfies StudyPostSessionPayload

    expect(parseStudyPostSessionPayload(payload)).toEqual(payload)
  })

  test("carries the server-issued completion code only as an optional server value", () => {
    const complete = {
      taskId: "098-S2",
      snapshotId: "snapshot-4",
      requiredStep: "complete" as const,
      nextTaskId: null,
      monitoringSubmitted: true,
      controlSubmitted: true,
      sessionCompleted: true,
      susSubmitted: true,
      completionCode: "SERVER-OWNED-CODE",
      completionUrl: "https://app.prolific.com/submissions/complete?cc=SERVER-OWNED-CODE",
    }
    expect(parseStudyPostSessionPayload(complete)).toEqual(complete)
    // Absent or null stays null-ish; the client never invents a code.
    expect(parseStudyPostSessionPayload({ ...complete, completionCode: null })).toEqual({
      ...complete,
      completionCode: null,
    })
    expect(parseStudyPostSessionPayload({ ...complete, completionCode: 42 })).toBeNull()
    expect(parseStudyPostSessionPayload({ ...complete, completionUrl: "https://example.com/complete" })).toBeNull()
  })

  test("rejects a next-session step without a usable destination", () => {
    expect(parseStudyPostSessionPayload({
      taskId: "038-S1",
      snapshotId: "snapshot-1",
      requiredStep: "next_session",
      nextTaskId: null,
      monitoringSubmitted: true,
      controlSubmitted: true,
      sessionCompleted: true,
      susSubmitted: false,
    })).toBeNull()
  })
})

describe("buildRawTlxResponse", () => {
  test("builds a response only after all six dimensions are answered", () => {
    const incomplete = {
      mentalDemand: 60,
      physicalDemand: 5,
      temporalDemand: 40,
      performance: 25,
      effort: 55,
    }
    expect(buildRawTlxResponse("monitoring", incomplete)).toBeNull()

    expect(buildRawTlxResponse("monitoring", { ...incomplete, frustration: 20 })).toEqual({
      instrument: "raw_tlx",
      instrumentVersion: 1,
      activity: "monitoring",
      ratings: { ...incomplete, frustration: 20 },
    })
  })
})

describe("buildSusResponse", () => {
  test("builds the standard response only after all ten items are answered", () => {
    const incomplete = { q1: 5, q2: 1, q3: 5, q4: 1, q5: 5, q6: 1, q7: 5, q8: 1, q9: 5 }
    expect(buildSusResponse(incomplete)).toBeNull()
    expect(buildSusResponse({ ...incomplete, q10: 1 })).toEqual({
      instrument: "sus",
      instrumentVersion: 1,
      ratings: { ...incomplete, q10: 1 },
    })
  })
})
