import { describe, expect, test } from "bun:test"
import {
  calculateRawTlxScore,
  calculateSusScore,
  parseStudyRawTlxActivityResponse,
  parseStudyRawTlxResponse,
  parseStudySusResponse,
  RAW_TLX_ACTIVITY_INSTRUCTIONS,
  RAW_TLX_DIMENSIONS,
  SUS_ITEMS,
} from "./studyScales"

describe("study Raw TLX contract", () => {
  test("publishes the six standard dimensions and activity-specific anchors", () => {
    expect(RAW_TLX_DIMENSIONS.map((dimension) => dimension.id)).toEqual([
      "mentalDemand",
      "physicalDemand",
      "temporalDemand",
      "performance",
      "effort",
      "frustration",
    ])
    expect(RAW_TLX_DIMENSIONS.find((dimension) => dimension.id === "performance")).toMatchObject({
      lowAnchor: "Perfect",
      highAnchor: "Failure",
    })
    expect(RAW_TLX_ACTIVITY_INSTRUCTIONS.monitoring).toContain("checking or understanding")
    expect(RAW_TLX_ACTIVITY_INSTRUCTIONS.control).toContain("change or update")
  })

  test("parses each activity as its own versioned six-rating response", () => {
    const ratings = {
      mentalDemand: 70,
      physicalDemand: 5,
      temporalDemand: 45,
      performance: 20,
      effort: 65,
      frustration: 30,
    }

    for (const activity of ["monitoring", "control"] as const) {
      const response = {
        instrument: "raw_tlx",
        instrumentVersion: 1,
        activity,
        ratings,
      } as const
      expect(parseStudyRawTlxActivityResponse(response)).toEqual(response)
    }
  })

  test("preserves complete 0-100 ratings for the monitoring and control activities", () => {
    const response = {
      instrument: "raw_tlx",
      instrumentVersion: 1,
      monitoring: {
        activity: "monitoring",
        ratings: {
          mentalDemand: 70,
          physicalDemand: 5,
          temporalDemand: 45,
          performance: 20,
          effort: 65,
          frustration: 30,
        },
      },
      control: {
        activity: "control",
        ratings: {
          mentalDemand: 55,
          physicalDemand: 0,
          temporalDemand: 35,
          performance: 25,
          effort: 60,
          frustration: 15,
        },
      },
    } as const

    expect(parseStudyRawTlxResponse(response)).toEqual(response)
  })

  test("scores one activity as the unweighted mean of its six raw ratings", () => {
    expect(calculateRawTlxScore({
      mentalDemand: 70,
      physicalDemand: 5,
      temporalDemand: 45,
      performance: 20,
      effort: 65,
      frustration: 30,
    })).toBeCloseTo(39.1667, 4)
  })

  test("rejects an activity block unless all six ratings are present and within 0-100", () => {
    const validRatings = {
      mentalDemand: 70,
      physicalDemand: 5,
      temporalDemand: 45,
      performance: 20,
      effort: 65,
      frustration: 30,
    }
    const base = {
      instrument: "raw_tlx",
      instrumentVersion: 1,
      monitoring: { activity: "monitoring", ratings: validRatings },
      control: { activity: "control", ratings: validRatings },
    }

    const { frustration: _omitted, ...incompleteRatings } = validRatings
    expect(parseStudyRawTlxResponse({
      ...base,
      monitoring: { activity: "monitoring", ratings: incompleteRatings },
    })).toBeNull()
    expect(parseStudyRawTlxResponse({
      ...base,
      control: { activity: "control", ratings: { ...validRatings, effort: 101 } },
    })).toBeNull()
  })
})

describe("study SUS contract", () => {
  test("publishes the standard ten system-usability statements in scoring order", () => {
    expect(SUS_ITEMS).toHaveLength(10)
    expect(SUS_ITEMS[0]).toMatchObject({ id: "q1", polarity: "positive" })
    expect(SUS_ITEMS[9]).toMatchObject({ id: "q10", polarity: "negative" })
  })

  test("preserves all ten original 1-5 item ratings", () => {
    const response = {
      instrument: "sus",
      instrumentVersion: 1,
      ratings: {
        q1: 5,
        q2: 1,
        q3: 4,
        q4: 2,
        q5: 5,
        q6: 1,
        q7: 4,
        q8: 2,
        q9: 5,
        q10: 1,
      },
    } as const

    expect(parseStudySusResponse(response)).toEqual(response)
  })

  test("scores odd and even items with the standard SUS 0-100 formula", () => {
    expect(calculateSusScore({
      q1: 5,
      q2: 1,
      q3: 4,
      q4: 2,
      q5: 5,
      q6: 1,
      q7: 4,
      q8: 2,
      q9: 5,
      q10: 1,
    })).toBe(90)
  })

  test("rejects incomplete, out-of-range, or differently versioned SUS answers", () => {
    const ratings = {
      q1: 3,
      q2: 3,
      q3: 3,
      q4: 3,
      q5: 3,
      q6: 3,
      q7: 3,
      q8: 3,
      q9: 3,
      q10: 3,
    }

    const { q10: _omitted, ...incompleteRatings } = ratings
    expect(parseStudySusResponse({ instrument: "sus", instrumentVersion: 1, ratings: incompleteRatings })).toBeNull()
    expect(parseStudySusResponse({
      instrument: "sus",
      instrumentVersion: 1,
      ratings: { ...ratings, q6: 0 },
    })).toBeNull()
    expect(parseStudySusResponse({ instrument: "sus", instrumentVersion: 2, ratings })).toBeNull()
  })
})
