import { describe, expect, test } from "bun:test"
import { projectMemoryBoardScopes } from "../MemoryBoardPage"
import {
  GUIDE_BOARD_CANDIDATE_DEMO,
  GUIDE_BOARD_PENDING_DEMO,
  createGuideBoardDemoController,
} from "./guideBoardDemo"

describe("GuideBoardDemoController", () => {
  test("locally resolves candidates, durable Transfer, and durable Checkup without participant state", () => {
    const controller = createGuideBoardDemoController(GUIDE_BOARD_PENDING_DEMO)

    controller.updateMemory("M-04", { status: "active" })
    controller.removeMemory("M-05")
    expect(controller.snapshot().status.pending).toEqual({
      candidates: 0,
      transfers: 1,
      checkups: 1,
      total: 2,
    })

    const transferred = controller.resolveTransfer("M-11", {
      content: "Ask for confirmation before emptying the cart",
      targetScope: "project",
      targetProjectId: "guide-demo-shop",
      boardResolution: {
        taskId: "038-S2",
        chatId: "guide-prior-chat",
        gateId: "guide-board-transfer",
      },
    })
    expect(transferred.status).toBe("active")
    expect(controller.snapshot().status.pending.transfers).toBe(0)

    controller.resolveCheckup({
      taskId: "038-S2",
      chatId: "guide-prior-chat",
      gateId: "guide-board-checkup",
      suggestionKind: "staleness",
      memoryId: "M-06",
    })
    expect(controller.snapshot().status.pending).toEqual({
      candidates: 0,
      transfers: 0,
      checkups: 0,
      total: 0,
    })
  })

  test("resets from a fresh clone so replaying the lesson never reuses prior actions", () => {
    const controller = createGuideBoardDemoController(GUIDE_BOARD_PENDING_DEMO)
    controller.removeMemory("M-04")
    controller.reset(GUIDE_BOARD_PENDING_DEMO)

    expect(controller.snapshot().status.pending.total).toBe(4)
    expect(controller.snapshot().items.filter((item) => item.status === "candidate")).toHaveLength(2)
  })

  test("models Candidate accept, undo, and the production Board projection", () => {
    const controller = createGuideBoardDemoController(GUIDE_BOARD_CANDIDATE_DEMO)

    controller.updateMemory("M-04", { status: "active" })
    expect(controller.snapshot().items.find((item) => item.id === "M-04")?.status).toBe("active")
    expect(controller.snapshot().items.find((item) => item.id === "M-05")?.status).toBe("candidate")
    const columns = projectMemoryBoardScopes(controller.snapshot().items)
    expect(columns.project.find((entry) => entry.item.id === "M-04")?.kind).toBe("memory")
    expect(columns.personal.find((entry) => entry.item.id === "M-05")?.kind).toBe("candidate-placeholder")

    controller.updateMemory("M-04", { status: "candidate" })
    expect(controller.snapshot().status.pending).toEqual({
      candidates: 2,
      transfers: 0,
      checkups: 0,
      total: 2,
    })
  })
})
