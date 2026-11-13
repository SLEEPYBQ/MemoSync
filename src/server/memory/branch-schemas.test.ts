import { expect, test } from "bun:test"
import Ajv from "ajv"
import { memoryStageSchema, memoryTransferSchema } from "./branch-schemas"
const ajv = new Ajv({ strict: false, allowUnionTypes: true })

test("candidate retention accepts only the suggested nullable durations", () => {
  const schema = memoryStageSchema("candidate") as any
  const validate = ajv.compile(schema.properties.candidates.items.properties.retentionDays)
  for (const value of [1, 7, 30, null]) expect(validate(value)).toBe(true)
  for (const value of [0, 2, "7"]) expect(validate(value)).toBe(false)
})

test("empty source snapshots forbid invented transfers in initial and review replies", () => {
  const initial = ajv.compile(memoryTransferSchema([]))
  expect(initial({ suggestions: [] })).toBe(true)
  expect(initial({ suggestions: [{}] })).toBe(false)
  const review = ajv.compile(memoryTransferSchema([], true))
  expect(review({ upsert: { suggestions: [] }, remove: { suggestions: [] } })).toBe(true)
  expect(review({ upsert: { suggestions: [{}] }, remove: { suggestions: [] } })).toBe(false)
})

test("transfer IDs and versions are bound to the supplied source snapshot", () => {
  const schema = memoryTransferSchema([{ sourceId: "M-3", sourceVersion: 4 }]) as any
  const properties = schema.properties.suggestions.items.properties
  expect(properties.sourceId.enum).toEqual(["M-3"])
  expect(properties.proposalId.enum).toEqual(["T:M-3"])
  expect(properties.sourceVersion.enum).toEqual([4])
})
