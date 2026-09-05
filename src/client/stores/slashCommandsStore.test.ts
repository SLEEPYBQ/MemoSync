import { describe, expect, test, beforeEach } from "bun:test"
import { useSlashCommandsStore } from "./slashCommandsStore"

describe("slashCommandsStore", () => {
  beforeEach(() => {
    useSlashCommandsStore.setState({ byProvider: {} })
  })

  test("remembers the engine-reported list per provider", () => {
    useSlashCommandsStore.getState().remember("claude", ["compact", "context"])
    useSlashCommandsStore.getState().remember("codex", ["review"])
    expect(useSlashCommandsStore.getState().byProvider.claude).toEqual(["compact", "context"])
    expect(useSlashCommandsStore.getState().byProvider.codex).toEqual(["review"])
  })

  test("an empty report never clobbers a known list", () => {
    useSlashCommandsStore.getState().remember("claude", ["compact"])
    useSlashCommandsStore.getState().remember("claude", [])
    expect(useSlashCommandsStore.getState().byProvider.claude).toEqual(["compact"])
  })

  test("identical list is a no-op (no state churn)", () => {
    useSlashCommandsStore.getState().remember("claude", ["compact"])
    const before = useSlashCommandsStore.getState().byProvider
    useSlashCommandsStore.getState().remember("claude", ["compact"])
    expect(useSlashCommandsStore.getState().byProvider).toBe(before)
  })
})
