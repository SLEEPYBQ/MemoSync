import { describe, expect, test } from "bun:test"
import { MEMORY_PROPOSALS_HELP_COPY } from "./MemoryProposalsGate"
import { MEMORY_TRANSFER_HELP_COPY } from "./MemoryTransferGate"

describe("memory pool review copy", () => {
  test.each([
    ["Candidate", MEMORY_PROPOSALS_HELP_COPY],
    ["Transfer", MEMORY_TRANSFER_HELP_COPY],
  ])("%s separates saving from this-turn focus", (_station, copy) => {
    expect(copy).toContain("Visible Memory Pool")
    expect(copy).toContain("Working Memory")
    expect(copy).toContain("focused for this turn")
    expect(copy).not.toContain("Injected Set")
    expect(copy).not.toContain("injected this very turn")
  })
})
