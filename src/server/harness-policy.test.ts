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

  test("version drift leaves adapter policies selectable, with native eligibility still required", () => {
    for (const engine of ['claude', 'codex', 'pi', 'opencode'] as const) {
      for (const version of [undefined, '999.0.0', '2.1.319', 'claude 2.1.319 (Claude Code)']) {
        const snapshot = engineCapabilities(engine, version)
        expect(snapshot.executionPolicies.every(c => c.availability === 'available')).toBe(true)
        expect(snapshot.executionPolicies[0]!.proof.version).toBe(version ?? 'unknown')
        for (const choice of snapshot.executionPolicies) {
          const service = new HarnessPolicyService()
          service.snapshot('chat', defaultExecutionPolicy(engine), 1, undefined, version)
          expect(service.request('chat', choice.policy, 1, false)).toMatchObject({ status: 'pending', effective: null, desired: choice.policy })
        }
      }
    }
    for (const engine of ["claude", "codex"] as const) {
      const snapshot = engineCapabilities(engine, engine === "claude" ? "2.1.241" : "0.166.0-alpha.5.1")
      expect(snapshot.executionPolicies.find(c => c.id.includes("auto"))).toMatchObject({ availability: "available", reason: expect.stringContaining("eligibility") })
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
    expect(() => service.request("chat", { engine: 'codex', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'invalid' } as never, 1, false)).toThrow('Unsupported')
    expect(service.snapshot("chat", policy, 1).policy.desiredRevision).toBe(1)
  })

  test.each(['claude', 'codex'] as const)('%s automatic mode rejection preserves desired policy and never upgrades permissions', engine => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy(engine)
    service.snapshot('chat', policy, 1)
    const auto = service.registry.snapshot(engine).executionPolicies.find(c => c.id.includes('auto'))!.policy
    service.request('chat', auto, 1, false)
    const scope = service.beginTurn('chat', auto, 2, 'turn', 'unreported')
    service.failed(scope, 'Managed requirements: automatic approval is disabled')
    expect(service.state('chat', engine)).toMatchObject({ desired: auto, desiredRevision: 2, effective: null, status: 'rejected', reason: 'Managed requirements: automatic approval is disabled' })
    expect(service.admit(scope, 'Write')).toBe('deny')
  })

  test('presets expose Claude bypass and Codex full access separately from plan and read-only', () => {
    expect(engineCapabilities('claude').executionPolicies.map(c => c.policy)).toContainEqual({ engine: 'claude', permissionMode: 'bypassPermissions' })
    expect(engineCapabilities('claude').executionPolicies.map(c => c.id).some(id => id.includes('plan'))).toBe(false)
    expect(engineCapabilities('codex').executionPolicies.map(c => c.policy)).toContainEqual({ engine: 'codex', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' })
  })

  test("snapshots without a native handle remove historical application without revoking a newly admitted turn", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi")
    const first = service.beginTurn("chat", policy, 1, "first", "1.5.0")
    service.applied(first, "old-native")
    service.endTurn(first)
    const next = service.beginTurn("chat", policy, 1, "second", "1.5.0")
    for (const nativeRuntime of ["absent", "starting"] as const) {
      const snapshot = service.snapshot("chat", policy, 1, undefined, "1.5.0", nativeRuntime)
      expect(snapshot).toMatchObject({ nativeRuntime, policy: { status: "pending", effective: null, effectiveRevision: null } })
      expect(snapshot.policy.boundaries).toContainEqual(expect.objectContaining({ boundary: "native-runtime", status: "unknown", revision: null }))
    }
    expect(service.isCurrent(next)).toBe(true)
    expect(service.admit(next, "write")).toBe("ask")
    service.applied(next, "new-native")
    expect(service.snapshot("chat", policy, 1, undefined, "1.5.0", "present")).toMatchObject({ nativeRuntime: "present", policy: { status: "applied", effectiveRevision: 1 } })
  })

  test("retirement revokes admission and clears acknowledgement and boundary session IDs", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi")
    const scope = service.beginTurn("chat", policy, 1, "turn", "1.5.0")
    service.applied(scope, "native-session")
    const retired = service.nativeRuntimeRetired("chat", "pi")
    expect(retired).toMatchObject({ status: "pending", effective: null, effectiveRevision: null })
    expect(retired.boundaries.find(b => b.boundary === "native-runtime")).toEqual({ boundary: "native-runtime", status: "unknown", revision: null, effectiveFrom: "next-turn" })
    expect(service.isCurrent(scope)).toBe(false)
    expect(() => service.applied(scope)).toThrow("Stale")
    expect(service.admit(scope, "write")).toBe("deny")
  })

  test("retirement and restart preserve rejection and descendant-process uncertainty", () => {
    const service = new HarnessPolicyService(), policy = defaultExecutionPolicy("pi")
    const first = service.beginTurn("chat", policy, 1, "first", "1.5.0")
    service.applied(first)
    const strict: NativeExecutionPolicy = { engine: "pi", toolGate: "read-only" }
    service.request("chat", strict, 1, true)
    service.nativeRuntimeRetired("chat", "pi")
    const next = service.beginTurn("chat", strict, 2, "second", "1.5.0")
    service.failed(next, "Native policy application failed")
    const retired = service.nativeRuntimeRetired("chat", "pi")
    expect(retired).toMatchObject({ status: "rejected", effective: null, effectiveRevision: null, reason: "Native policy application failed" })
    expect(retired.boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
    const restored = new HarnessPolicyService().snapshot("chat", strict, 2, retired, "1.5.0", "absent")
    expect(restored.policy).toMatchObject({ status: "rejected", effective: null, effectiveRevision: null, reason: "Native policy application failed" })
    expect(restored.policy.boundaries).toContainEqual(expect.objectContaining({ boundary: "native-runtime", status: "rejected", revision: null }))
    expect(restored.policy.boundaries).toContainEqual(expect.objectContaining({ boundary: "existing-processes", status: "unknown" }))
  })

  test("policy validation keeps intent, memory, reviewer and sandbox separate", () => {
    expect(isNativeExecutionPolicy({ engine: "claude", permissionMode: "plan" })).toBe(false)
    expect(isNativeExecutionPolicy({ engine: "pi", toolGate: "workspace-write" })).toBe(false)
    expect(isNativeExecutionPolicy({ engine: "codex", approvalPolicy: "on-request", sandbox: "workspace-write" })).toBe(false)
    expect(isNativeExecutionPolicy({ engine: "opencode", permission: "review" })).toBe(false)
  })
})
