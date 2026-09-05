import { describe, expect, test } from "bun:test"
import { runRetainedDraftSubmission } from "./chatDraftSubmission"

describe("runRetainedDraftSubmission", () => {
  test("keeps the persisted draft until the delayed submit is accepted", async () => {
    const events: string[] = []
    let acceptSubmit!: () => void
    const submit = new Promise<void>((resolve) => { acceptSubmit = resolve })

    const running = runRetainedDraftSubmission({
      submit: () => submit,
      onAccepted: () => { events.push("clear") },
      onRejected: () => { events.push("retain") },
    })

    await Promise.resolve()
    expect(events).toEqual([])
    acceptSubmit()
    await running
    expect(events).toEqual(["clear"])
  })

  test("retains the draft when the Board flow or real send rejects", async () => {
    const events: string[] = []
    await runRetainedDraftSubmission({
      submit: async () => { throw new Error("send failed") },
      onAccepted: () => { events.push("clear") },
      onRejected: (error) => { events.push(error instanceof Error ? error.message : "unknown") },
    })
    expect(events).toEqual(["send failed"])
  })
})
