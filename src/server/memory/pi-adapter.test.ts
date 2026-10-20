import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { toPiToolDefinitions } from "./pi-adapter"
import type { MemoryToolSpec } from "./tools"

function spec(name: string, schema: z.ZodRawShape = {}): MemoryToolSpec {
  return {
    name,
    description: `${name} description`,
    schema,
    handler: async () => ({ text: "unused", isError: false }),
  }
}

describe("toPiToolDefinitions", () => {
  test("converts specs into pi tool definitions", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const tools = toPiToolDefinitions(
      [spec("load_memory_detail", { id: z.string() }), spec("propose_memory")],
      async (name, args) => {
        calls.push({ name, args })
        return { text: `ok:${name}` }
      }
    )

    expect(tools.map((tool) => tool.name)).toEqual(["load_memory_detail", "propose_memory"])
    expect(tools[0].label).toBe("load_memory_detail")
    expect(tools[0].description).toBe("load_memory_detail description")
    expect(tools[0].promptSnippet).toBe("load_memory_detail description")

    const params = tools[0].parameters as { type: string; properties: Record<string, unknown> }
    expect(params.type).toBe("object")
    expect(params.properties).toHaveProperty("id")

    const result = await tools[0].execute("call-1", { id: "M-1" }, undefined, async () => {}, {} as never)
    expect(calls).toEqual([{ name: "load_memory_detail", args: { id: "M-1" } }])
    expect(result).toEqual({ content: [{ type: "text", text: "ok:load_memory_detail" }], details: {} })
  })

  test("collapses single-key anyOf type variants into a type array", () => {
    const tools = toPiToolDefinitions(
      [spec("search", { query: z.string(), limit: z.union([z.number(), z.string()]) })],
      async () => ({ text: "ok" })
    )
    const properties = (tools[0].parameters as { properties: Record<string, { type?: unknown; anyOf?: unknown }> }).properties
    expect(properties.limit.anyOf).toBeUndefined()
    expect(new Set(properties.limit.type as string[])).toEqual(new Set(["string", "number"]))
    expect(properties.query.type).toBe("string")
  })

  test("execute rejects when the invoker reports an error", async () => {
    const tools = toPiToolDefinitions([spec("load_memory_detail")], async () => ({ text: "boom", isError: true }))
    await expect(tools[0].execute("call-1", {}, undefined, async () => {}, {} as never)).rejects.toThrow("boom")
  })

  test("disabled dispatch can return an error without touching the handler", async () => {
    const tools = toPiToolDefinitions([spec("propose_memory")], async () => ({
      text: "Memory tools are not available for this turn.",
      isError: true,
    }))
    await expect(tools[0].execute("call-1", {}, undefined, async () => {}, {} as never))
      .rejects.toThrow("Memory tools are not available for this turn.")
  })
})
