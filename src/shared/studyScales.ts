export const RAW_TLX_INSTRUMENT_ID = "raw_tlx" as const
export const RAW_TLX_INSTRUMENT_VERSION = 1 as const
export const SUS_INSTRUMENT_ID = "sus" as const
export const SUS_INSTRUMENT_VERSION = 1 as const
export const RAW_TLX_RATING_MIN = 0 as const
export const RAW_TLX_RATING_MAX = 100 as const
export const SUS_RATING_MIN = 1 as const
export const SUS_RATING_MAX = 5 as const

export const RAW_TLX_ACTIVITIES = ["monitoring", "control"] as const
export type RawTlxActivity = (typeof RAW_TLX_ACTIVITIES)[number]

export const RAW_TLX_DIMENSION_IDS = [
  "mentalDemand",
  "physicalDemand",
  "temporalDemand",
  "performance",
  "effort",
  "frustration",
] as const

export type RawTlxDimensionId = (typeof RAW_TLX_DIMENSION_IDS)[number]
export type RawTlxRatings = Record<RawTlxDimensionId, number>

export const RAW_TLX_ACTIVITY_INSTRUCTIONS: Record<RawTlxActivity, string> = {
  monitoring: "Think only about checking or understanding what the agent remembered during this session.",
  control: "Think only about actions you took to change or update what the agent remembered during this session.",
}

export const RAW_TLX_DIMENSIONS = [
  {
    id: "mentalDemand",
    label: "Mental Demand",
    prompt: "How mentally demanding was this activity?",
    lowAnchor: "Very low",
    highAnchor: "Very high",
  },
  {
    id: "physicalDemand",
    label: "Physical Demand",
    prompt: "How physically demanding was this activity?",
    lowAnchor: "Very low",
    highAnchor: "Very high",
  },
  {
    id: "temporalDemand",
    label: "Temporal Demand",
    prompt: "How hurried or rushed was the pace of this activity?",
    lowAnchor: "Very low",
    highAnchor: "Very high",
  },
  {
    id: "performance",
    label: "Performance",
    prompt: "How successful were you in accomplishing the goals of this activity?",
    lowAnchor: "Perfect",
    highAnchor: "Failure",
  },
  {
    id: "effort",
    label: "Effort",
    prompt: "How hard did you have to work to accomplish your level of performance in this activity?",
    lowAnchor: "Very low",
    highAnchor: "Very high",
  },
  {
    id: "frustration",
    label: "Frustration",
    prompt: "How insecure, discouraged, irritated, stressed, and annoyed were you during this activity?",
    lowAnchor: "Very low",
    highAnchor: "Very high",
  },
] as const satisfies readonly {
  id: RawTlxDimensionId
  label: string
  prompt: string
  lowAnchor: string
  highAnchor: string
}[]

export const SUS_ITEM_IDS = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"] as const
export type SusItemId = (typeof SUS_ITEM_IDS)[number]
export type SusRatings = Record<SusItemId, number>

export const SUS_ITEMS = [
  { id: "q1", polarity: "positive", statement: "I think that I would like to use this system frequently." },
  { id: "q2", polarity: "negative", statement: "I found the system unnecessarily complex." },
  { id: "q3", polarity: "positive", statement: "I thought the system was easy to use." },
  {
    id: "q4",
    polarity: "negative",
    statement: "I think that I would need the support of a technical person to be able to use this system.",
  },
  {
    id: "q5",
    polarity: "positive",
    statement: "I found the various functions in this system were well integrated.",
  },
  { id: "q6", polarity: "negative", statement: "I thought there was too much inconsistency in this system." },
  {
    id: "q7",
    polarity: "positive",
    statement: "I would imagine that most people would learn to use this system very quickly.",
  },
  { id: "q8", polarity: "negative", statement: "I found this system very cumbersome to use." },
  { id: "q9", polarity: "positive", statement: "I felt very confident using the system." },
  {
    id: "q10",
    polarity: "negative",
    statement: "I needed to learn a lot of things before I could get going with this system.",
  },
] as const satisfies readonly {
  id: SusItemId
  polarity: "positive" | "negative"
  statement: string
}[]

export interface RawTlxActivityResponse<TActivity extends RawTlxActivity> {
  activity: TActivity
  ratings: RawTlxRatings
}

/** Self-describing response for one activity, suitable for independent submission and resume. */
export interface StudyRawTlxActivityResponse<TActivity extends RawTlxActivity = RawTlxActivity>
  extends RawTlxActivityResponse<TActivity> {
  instrument: typeof RAW_TLX_INSTRUMENT_ID
  instrumentVersion: typeof RAW_TLX_INSTRUMENT_VERSION
}

export interface StudyRawTlxResponse {
  instrument: typeof RAW_TLX_INSTRUMENT_ID
  instrumentVersion: typeof RAW_TLX_INSTRUMENT_VERSION
  monitoring: RawTlxActivityResponse<"monitoring">
  control: RawTlxActivityResponse<"control">
}

export interface StudySusResponse {
  instrument: typeof SUS_INSTRUMENT_ID
  instrumentVersion: typeof SUS_INSTRUMENT_VERSION
  ratings: SusRatings
}

/** Raw TLX uses an equal-weight mean; it does not include NASA-TLX pairwise weighting. */
export function calculateRawTlxScore(ratings: RawTlxRatings): number {
  const total = RAW_TLX_DIMENSION_IDS.reduce((sum, dimension) => sum + ratings[dimension], 0)
  return total / RAW_TLX_DIMENSION_IDS.length
}

/** Standard SUS scoring: odd items subtract 1, even items invert from 5, then multiply by 2.5. */
export function calculateSusScore(ratings: SusRatings): number {
  const contribution = SUS_ITEM_IDS.reduce((sum, itemId, index) => {
    const rating = ratings[itemId]
    return sum + (index % 2 === 0 ? rating - 1 : 5 - rating)
  }, 0)
  return contribution * 2.5
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  const actual = Object.keys(value)
  return actual.length === expected.size && actual.every((key) => expected.has(key))
}

function parseRawTlxRatings(raw: unknown): RawTlxRatings | null {
  if (!isRecord(raw) || !hasExactKeys(raw, RAW_TLX_DIMENSION_IDS)) return null

  for (const dimension of RAW_TLX_DIMENSION_IDS) {
    const rating = raw[dimension]
    if (
      typeof rating !== "number"
      || !Number.isFinite(rating)
      || rating < RAW_TLX_RATING_MIN
      || rating > RAW_TLX_RATING_MAX
    ) return null
  }

  return Object.fromEntries(
    RAW_TLX_DIMENSION_IDS.map((dimension) => [dimension, raw[dimension]]),
  ) as RawTlxRatings
}

function parseUnversionedRawTlxActivityResponse<TActivity extends RawTlxActivity>(
  raw: unknown,
  activity: TActivity,
): RawTlxActivityResponse<TActivity> | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["activity", "ratings"]) || raw.activity !== activity) return null
  const ratings = parseRawTlxRatings(raw.ratings)
  return ratings ? { activity, ratings } : null
}

export function parseStudyRawTlxActivityResponse(raw: unknown): StudyRawTlxActivityResponse | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["instrument", "instrumentVersion", "activity", "ratings"])) {
    return null
  }
  if (raw.instrument !== RAW_TLX_INSTRUMENT_ID || raw.instrumentVersion !== RAW_TLX_INSTRUMENT_VERSION) return null
  if (raw.activity !== "monitoring" && raw.activity !== "control") return null
  const ratings = parseRawTlxRatings(raw.ratings)
  if (!ratings) return null

  return {
    instrument: RAW_TLX_INSTRUMENT_ID,
    instrumentVersion: RAW_TLX_INSTRUMENT_VERSION,
    activity: raw.activity,
    ratings,
  }
}

export function parseStudyRawTlxResponse(raw: unknown): StudyRawTlxResponse | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["instrument", "instrumentVersion", "monitoring", "control"])) {
    return null
  }
  if (raw.instrument !== RAW_TLX_INSTRUMENT_ID || raw.instrumentVersion !== RAW_TLX_INSTRUMENT_VERSION) return null

  const monitoring = parseUnversionedRawTlxActivityResponse(raw.monitoring, "monitoring")
  const control = parseUnversionedRawTlxActivityResponse(raw.control, "control")
  if (!monitoring || !control) return null

  return {
    instrument: RAW_TLX_INSTRUMENT_ID,
    instrumentVersion: RAW_TLX_INSTRUMENT_VERSION,
    monitoring,
    control,
  }
}

export function parseStudySusResponse(raw: unknown): StudySusResponse | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["instrument", "instrumentVersion", "ratings"])) return null
  if (raw.instrument !== SUS_INSTRUMENT_ID || raw.instrumentVersion !== SUS_INSTRUMENT_VERSION) return null
  if (!isRecord(raw.ratings) || !hasExactKeys(raw.ratings, SUS_ITEM_IDS)) return null
  const ratings = raw.ratings

  for (const itemId of SUS_ITEM_IDS) {
    const rating = ratings[itemId]
    if (
      typeof rating !== "number"
      || !Number.isInteger(rating)
      || rating < SUS_RATING_MIN
      || rating > SUS_RATING_MAX
    ) return null
  }

  return {
    instrument: SUS_INSTRUMENT_ID,
    instrumentVersion: SUS_INSTRUMENT_VERSION,
    ratings: Object.fromEntries(SUS_ITEM_IDS.map((itemId) => [itemId, ratings[itemId]])) as SusRatings,
  }
}
