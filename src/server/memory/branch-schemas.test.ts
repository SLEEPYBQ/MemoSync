import { expect, test } from "bun:test"
import Ajv from "ajv"
import { memoryTransferSchema } from "./branch-schemas"
const ajv = new Ajv({ strict: false, allowUnionTypes: true })

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
