import { expect,test } from "bun:test"
import { createHash } from "node:crypto"
import type { MemoryItem } from "../memory/types"
import { recordDeliveredStoreFocus } from "./focus"

test("records the exact delivered selection once with hashes and resume linkage", () => {
  const item = { id: "M-01", version: 2, content: "Use pnpm", scope: "project", status: "active" } as MemoryItem
  const events: unknown[] = []
  const event = recordDeliveredStoreFocus({
    logger: { event: value => { events.push(value) } },
    chatId: "chat-1", turnId: "turn-1", turn: 1, mode: "skills",
    promptText: "accepted prompt", visiblePool: [item, { ...item, id: "M-02" }],
    focusedMemories: [item, item], resumeOfInterruptId: "interrupt-1", injectionId: "delivery-1",
  })
  expect(events).toEqual([event])
  expect(event.deliveryStage).toBe("queued_to_claude")
  expect(event.resumeOfInterruptId).toBe("interrupt-1")
  expect(event.memories).toEqual([expect.objectContaining({ id: "M-01", version: 2, content: "Use pnpm", identity: { scheme: "store", id: "M-01" } })])
  expect(event.deliveryHash).toBe(createHash("sha256").update("accepted prompt").digest("hex"))
  expect(event.memories[0]!.contentHash).toBe(createHash("sha256").update("Use pnpm").digest("hex"))
  expect(event).not.toHaveProperty("taskId")
})
