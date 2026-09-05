import { describe, expect, test } from "bun:test"
import { requestConditionPolicyWithRetry } from "./conditionApi"
import type { ConditionPolicy } from "../../server/experiment/condition"

const staticPolicy: ConditionPolicy = {
  condition: "static",
  capture: "off",
  preview: false,
  trace: false,
  boardVisible: false,
  boardWritable: false,
  bringIn: false,
  injection: "static_files",
  memoryTools: false,
  studyMode: true,
}

describe("requestConditionPolicyWithRetry", () => {
  test("recovers from a transient first-load failure using the bounded backoff", async () => {
    let requests = 0
    const delays: number[] = []
    const fetchPolicy = async () => {
      requests += 1
      if (requests === 1) throw new Error("server is still starting")
      return Response.json({ data: staticPolicy })
    }

    const result = await requestConditionPolicyWithRetry({
      fetchPolicy,
      retryDelaysMs: [0, 250, 750],
      sleep: async (ms) => {
        delays.push(ms)
      },
    })

    expect(requests).toBe(2)
    expect(delays).toEqual([250])
    expect(result.data).toEqual(staticPolicy)
  })

  test("rejects after the bounded retry sequence so the shell remains fail-closed", async () => {
    let requests = 0
    const fetchPolicy = async () => {
      requests += 1
      throw new Error("condition endpoint unavailable")
    }

    await expect(requestConditionPolicyWithRetry({
      fetchPolicy,
      retryDelaysMs: [0, 0, 0],
      sleep: async () => undefined,
    })).rejects.toThrow("condition endpoint unavailable")
    expect(requests).toBe(3)
  })
})
