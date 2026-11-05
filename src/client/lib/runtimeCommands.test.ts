import { describe, expect, test } from "bun:test"
import type { ChatCommandCatalog, RuntimeCommand } from "../../shared/runtime-commands"
import { resolveRuntimeSlash, runtimeCatalogSettling } from "./runtimeCommands"

const proof = { api: "native.commands", version: "verified", evidence: "native-response" as const }
const compact: RuntimeCommand = { id: "compact", name: "compact", description: "Compact", namespace: "native", owner: "native-engine", arguments: { type: "string" }, requiresIdle: true, sideEffect: "context-compaction", route: "compact", source: proof, requiredRuntimeVersion: "verified" }
function catalog(items = [compact]): ChatCommandCatalog {
  return { runtime: { engine: "pi", nativeInstance: "one", nativeSession: "session", version: "verified", profile: "test", workspace: "/workspace", mode: "ask" }, runtimeKey: "one", revision: 1,
    commands: { status: "ready", items, source: proof }, skills: { status: "ready", items: [], source: proof }, connectors: { status: "ready", items: [], source: proof }, compact: { status: "available" }, operation: null }
}

describe("native command submission", () => {
  test("compact resolves to a native control; an unsupported or absent runtime rejects it", () => {
    expect(resolveRuntimeSlash("/compact preserve current task", catalog())).toEqual({ command: compact, args: "preserve current task" })
    expect(() => resolveRuntimeSlash("/compact", null)).toThrow()
    const unavailable = catalog()
    unavailable.compact = { status: "unsupported", reason: "No verified compact API" }
    expect(() => resolveRuntimeSlash("/compact", unavailable)).toThrow("No verified compact API")
  })
  test("successful empty discovery and stale discovery cannot resurrect an older command", () => {
    expect(() => resolveRuntimeSlash("/compact", catalog([]))).toThrow()
    const stale = catalog()
    stale.commands.status = "stale"
    expect(() => resolveRuntimeSlash("/compact", stale)).toThrow()
  })
  test("same-name skills and native commands require unambiguous namespace tokens", () => {
    const skill: RuntimeCommand = { ...compact, id: "skill-compact", namespace: "skill", route: "native-skill", sideEffect: "model-turn" }
    const both = catalog([compact, skill])
    expect(resolveRuntimeSlash("/native:compact", both)?.command.id).toBe("compact")
    expect(resolveRuntimeSlash("/skill:compact Keep Foo.ts", both)).toEqual({ command: skill, args: "Keep Foo.ts" })
    expect(() => resolveRuntimeSlash("/compact", both)).toThrow()
  })
  test("an unlisted slash command reaches the engine as text instead of failing", () => {
    expect(resolveRuntimeSlash("/frobnicate now", catalog())).toBeNull()
    expect(resolveRuntimeSlash("/review", null)).toBeNull()
    const failed = catalog()
    failed.commands.status = "failed"
    expect(resolveRuntimeSlash("/review", failed)).toBeNull()
  })
  test("a list that is still loading is waited for; a failed preparation is not", () => {
    expect(runtimeCatalogSettling(null)).toBe(true)
    const preparing = catalog()
    preparing.preparation = { status: "preparing" }
    expect(runtimeCatalogSettling(preparing)).toBe(true)
    const unknown = catalog()
    unknown.commands.status = "unknown"
    expect(runtimeCatalogSettling(unknown)).toBe(true)
    unknown.preparation = { status: "error", message: "account-signed-out" }
    expect(runtimeCatalogSettling(unknown)).toBe(false)
    expect(runtimeCatalogSettling(catalog())).toBe(false)
  })
  test("ordinary prose and filesystem paths retain the regular message path", () => {
    for (const value of ["Please inspect /compact", "/Users/example/project/File.ts", "Show me the source."]) expect(resolveRuntimeSlash(value, null)).toBeNull()
  })
})
