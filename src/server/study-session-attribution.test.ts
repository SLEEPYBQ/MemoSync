import { describe, expect, test } from "bun:test"
import { resolveConditionPolicy } from "./experiment/condition"
import { StudyRegistry } from "./study-registry"
import { createStudySessionAttribution } from "./study-session-attribution"

describe("study memory-interaction session attribution", () => {
  test("uses one active task window even when participant actions can come from multiple chats", () => {
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"])
    const resolve = createStudySessionAttribution({
      policy: resolveConditionPolicy("memosync"),
      registry,
    })!

    // Chat identity is deliberately absent from this interface: every valid
    // assigned-project chat inside 038-S1 belongs to the same study session.
    expect(resolve()).toEqual({ taskId: "038-S1", sessionId: "038-S1" })

    registry.noteFreeze("038-S1")
    expect(resolve()).toBeNull()

    registry.noteSessionComplete("038-S1")
    expect(resolve()).toEqual({ taskId: "038-S2", sessionId: "038-S2" })
  })

  test("does not install the MemoSync control-attribution seam outside its formal arm", () => {
    const registry = new StudyRegistry(undefined, ["038-S1"])
    expect(createStudySessionAttribution({
      policy: resolveConditionPolicy("auto"),
      registry,
    })).toBeUndefined()
    expect(createStudySessionAttribution({
      policy: { ...resolveConditionPolicy("memosync"), studyMode: false },
      registry,
    })).toBeUndefined()
  })
})
