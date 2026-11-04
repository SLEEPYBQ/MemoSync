import { describe, expect, test } from "bun:test"
import { CapabilityRegistry, HarnessPolicyService, defaultExecutionPolicy, isNativeExecutionPolicy } from "./harness-policy"
const registry = new CapabilityRegistry()
const engineCapabilities = registry.snapshot.bind(registry)
import type { NativeExecutionPolicy } from "../shared/harness-capabilities"

describe("execution policy boundaries", () => {
  test("new defaults preserve native semantics and existing chats retain explicit behavior", () => {
    expect(defaultExecutionPolicy("codex")).toEqual({ engine: "codex", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" })
    expect(defaultExecutionPolicy("codex", true)).toEqual({ engine: "codex", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" })
    expect(defaultExecutionPolicy("claude")).toEqual({ engine: "claude", permissionMode: "default" })
    expect(defaultExecutionPolicy("claude", true)).toEqual({ engine: "claude", permissionMode: "acceptEdits" })
    expect(defaultExecutionPolicy("pi")).toEqual({ engine: "pi", toolGate: "ask" })
    expect(defaultExecutionPolicy("opencode")).toEqual({ engine: "opencode", permission: "ask" })
  })

  test("unknown versions and eligibility-sensitive enum values are not selectable", () => {
    const unknown = engineCapabilities("codex", "999.0.0")
    expect(unknown.executionPolicies.every(c => c.availability !== "available")).toBe(true)
    for (const engine of ["claude", "codex"] as const) {
      const snapshot = engineCapabilities(engine, engine === "claude" ? "2.1.241" : "0.166.0-alpha.5.1")
      expect(snapshot.executionPolicies.find(c => c.id.includes("auto"))).toMatchObject({ availability: "unavailable", reason: expect.stringContaining("eligibility") })
    }
    expect(engineCapabilities("pi").executionPolicies.every(c => c.boundary === "tool-gating")).toBe(true)
    expect(engineCapabilities("pi").executionPolicies[0]!.reason).toContain("no OS sandbox")
  })

  test("desired is pending until native acknowledgement, returned snapshots are detached", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi")
    const scope = service.beginTurn("chat", policy, 1, "turn", "1.5.0")
    expect(service.snapshot("chat", policy, 1).policy).toMatchObject({ effective: null, effectiveRevision: null, status: "pending" })
    service.applied(scope, "native-1")
    const snapshot = service.snapshot("chat", policy, 1)
    expect(snapshot.policy).toMatchObject({ desiredRevision: 1, effectiveRevision: 1, status: "applied" })
    snapshot.policy.desiredRevision = 900
    expect(service.snapshot("chat", policy, 1).policy.desiredRevision).toBe(1)
  })

  test("tightening revokes old calls and applies a fresh native epoch without losing process uncertainty", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi", true)
    const scope = service.beginTurn("chat", policy, 1, "turn", "1.5.0")
    service.applied(scope)
    expect(service.admit(scope, "bash")).toBe("allow")
    const strict: NativeExecutionPolicy = { engine: "pi", toolGate: "read-only" }
    const state = service.request("chat", strict, 1, true)
    expect(service.admit(scope, "bash")).toBe("deny")
    expect(service.isCurrent(scope)).toBe(false)
    expect(state).toMatchObject({ desiredRevision: 2, effectiveRevision: 1, status: "partial" })
    expect(state.boundaries).toContainEqual(expect.objectContaining({ boundary: "host-dispatch", status: "applied", effectiveFrom: "immediate" }))
    expect(state.boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
    expect(() => service.beginTurn("chat", strict, 2, "next", "1.5.0")).toThrow("retire")
    expect(() => service.applied(scope)).toThrow("Stale")
    service.nativeRuntimeRetired("chat", "pi")
    const next = service.beginTurn("chat", strict, 2, "next", "1.5.0")
    expect(service.admit(next, "bash")).toBe("deny")
    expect(service.admit(next, "read")).toBe("allow")
    expect(service.applied(next)).toMatchObject({ effectiveRevision: 2, status: "partial" })
    expect(service.state("chat", "pi").boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
    service.endTurn(next)
    expect(service.beginTurn("chat", strict, 2, "third", "1.5.0").policyRevision).toBe(2)
  })

  test("idle changes remain pending and read-only Pi blocks arbitrary shell commands", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi")
    const first = service.beginTurn("chat", policy, 1, "first", "1.5.0")
    service.applied(first)
    service.endTurn(first)
    const strict: NativeExecutionPolicy = { engine: "pi", toolGate: "read-only" }
    expect(service.request("chat", strict, 1, false).status).toBe("pending")
    const second = service.beginTurn("chat", strict, 2, "second", "1.5.0")
    expect(service.admit(second, "read")).toBe("allow")
    expect(service.admit(second, "bash")).toBe("deny")
    expect(service.admit(second, "write")).toBe("deny")
    expect(service.admit(second, "unknown-extension")).toBe("deny")
    expect(service.admit(second, "propose_memory")).toBe("allow")
    expect(service.isCurrent(first)).toBe(false)
    service.applied(second)
    expect(service.snapshot("chat", strict, 2).policy.effectiveRevision).toBe(2)
  })

  test("stale turn, generation, revision, engine and chat cannot authorize a call", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi")
    const scope = service.beginTurn("chat", policy, 1, "first", "1.5.0")
    for (const changed of [{ turnId: "other" }, { generation: 99 }, { policyRevision: 2 }, { engine: "claude" as const }, { chatId: "other" }]) {
      expect(service.isCurrent({ ...scope, ...changed })).toBe(false)
      expect(service.admit({ ...scope, ...changed }, "write")).toBe("deny")
    }
    const newer = service.beginTurn("chat", policy, 1, "second", "1.5.0")
    expect(service.isCurrent(scope)).toBe(false)
    expect(service.admit(newer, "write")).toBe("ask")
    service.endTurn(newer)
    expect(service.isCurrent(newer)).toBe(false)
  })

  test("native rejection remains rejected, and unsupported policy updates do not change revision", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("codex")
    const scope = service.beginTurn("chat", policy, 1, "turn", "0.166.0-alpha.5.1")
    service.failed(scope, "Managed requirements rejected workspace-write")
    expect(service.snapshot("chat", policy, 1).policy).toMatchObject({ status: "rejected", effective: null, reason: expect.stringContaining("Managed") })
    expect(service.admit(scope, "Write")).toBe("deny")
    expect(() => service.request("chat", { ...policy, engine: "codex", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" }, 1, false)).toThrow("eligibility")
    expect(service.snapshot("chat", policy, 1).policy.desiredRevision).toBe(1)
  })

  test("policy validation keeps intent, memory, reviewer and sandbox separate", () => {
    expect(isNativeExecutionPolicy({ engine: "claude", permissionMode: "plan" })).toBe(false)
    expect(isNativeExecutionPolicy({ engine: "pi", toolGate: "workspace-write" })).toBe(false)
    expect(isNativeExecutionPolicy({ engine: "codex", approvalPolicy: "on-request", sandbox: "workspace-write" })).toBe(false)
    expect(isNativeExecutionPolicy({ engine: "opencode", permission: "review" })).toBe(false)
  })
})
