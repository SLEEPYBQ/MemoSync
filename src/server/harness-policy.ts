import type { AgentProvider } from "../shared/types"
import type { ChatHarnessSnapshot, EngineCapabilities, ExecutionPolicyChoice, ExecutionPolicyState, NativeExecutionPolicy, PolicyCallScope } from "../shared/harness-capabilities"

export function defaultExecutionPolicy(engine: AgentProvider, legacy = false): NativeExecutionPolicy {
  switch (engine) {
    case "claude": return { engine, permissionMode: legacy ? "acceptEdits" : "default" }
    case "codex": return { engine, approvalPolicy: legacy ? "never" : "on-request", approvalsReviewer: "user", sandbox: legacy ? "danger-full-access" : "workspace-write" }
    case "pi": return { engine, toolGate: legacy ? "allow" : "ask" }
    case "opencode": return { engine, permission: legacy ? "allow" : "ask" }
  }
}

export function isNativeExecutionPolicy(value: unknown): value is NativeExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  const fields = p.engine === "claude" ? ["engine", "permissionMode"] : p.engine === "codex" ? ["engine", "approvalPolicy", "approvalsReviewer", "sandbox"] : p.engine === "pi" ? ["engine", "toolGate"] : ["engine", "permission"]
  if (Object.keys(p).length !== fields.length || Object.keys(p).some(field => !fields.includes(field))) return false
  switch (p.engine) {
    case "claude": return ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto"].includes(p.permissionMode as string)
    case "codex": return ["on-request", "untrusted", "never"].includes(p.approvalPolicy as string) && ["user", "auto_review"].includes(p.approvalsReviewer as string) && ["read-only", "workspace-write", "danger-full-access"].includes(p.sandbox as string)
    case "pi": return ["read-only", "ask", "allow"].includes(p.toolGate as string)
    case "opencode": return ["ask", "allow", "deny"].includes(p.permission as string)
    default: return false
  }
}

export function isExecutionPolicyState(value: unknown): value is ExecutionPolicyState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const s = value as ExecutionPolicyState
  const statuses = ["applied", "pending", "partial", "rejected", "unknown", "unsupported"]
  return isNativeExecutionPolicy(s.desired) && (s.effective === null || (isNativeExecutionPolicy(s.effective) && s.effective.engine === s.desired.engine))
    && Number.isSafeInteger(s.desiredRevision) && s.desiredRevision > 0
    && (s.effectiveRevision === null ? s.effective === null : Number.isSafeInteger(s.effectiveRevision) && s.effectiveRevision > 0 && s.effectiveRevision <= s.desiredRevision && s.effective !== null)
    && statuses.includes(s.status) && Array.isArray(s.boundaries) && s.boundaries.every(b => b && ["host-dispatch", "native-runtime", "existing-processes"].includes(b.boundary) && statuses.includes(b.status) && ["immediate", "next-turn", "restart", "unknown"].includes(b.effectiveFrom) && (b.revision === null || Number.isSafeInteger(b.revision) && b.revision > 0))
}

export function executionPolicyKey(policy: NativeExecutionPolicy): string {
  switch (policy.engine) {
    case "claude": return `claude:${policy.permissionMode}`
    case "codex": return `codex:${policy.approvalPolicy}:${policy.approvalsReviewer}:${policy.sandbox}`
    case "pi": return `pi:${policy.toolGate}`
    case "opencode": return `opencode:${policy.permission}`
  }
}

/** Evidence is deliberately narrow. An enum member or an echoed request is not eligibility. */
export class CapabilityRegistry {
  private revisions = new Map<AgentProvider, { version: string | undefined; revision: number }>()
  snapshot(engine: AgentProvider, version?: string): EngineCapabilities {
    const previous = this.revisions.get(engine)
    const revision = !previous ? 1 : previous.version === version ? previous.revision : previous.revision + 1
    this.revisions.set(engine, { version, revision })
    const verified = engine === "pi" ? version === "1.5.0"
      : engine === "claude" ? ["2.1.241", "2.1.318"].includes(version ?? "")
      : engine === "codex" ? ["0.166.0-alpha.5.1", "0.166.0-alpha.6"].includes(version ?? "") : version === "1.19.5"
    const policies: Array<[string, NativeExecutionPolicy]> = engine === "claude" ? [
      ["Ask for native approvals", { engine, permissionMode: "default" }],
      ["Accept file edits", { engine, permissionMode: "acceptEdits" }],
      ["Deny unapproved operations", { engine, permissionMode: "dontAsk" }],
      ["Automatic reviewer", { engine, permissionMode: "auto" }],
    ] : engine === "codex" ? [
      ["Workspace sandbox, request approval", { engine, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" }],
      ["Read-only sandbox, no escalation", { engine, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only" }],
      ["Workspace sandbox, automatic reviewer", { engine, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" }],
    ] : engine === "pi" ? [
      ["Ask before tools with side effects", { engine, toolGate: "ask" }],
      ["Read tools only", { engine, toolGate: "read-only" }],
      ["Allow tools", { engine, toolGate: "allow" }],
    ] : [
      ["Ask for native permissions", { engine, permission: "ask" }],
      ["Deny native tools", { engine, permission: "deny" }],
      ["Allow native tools", { engine, permission: "allow" }],
    ]
    const executionPolicies: ExecutionPolicyChoice[] = policies.map(([label, policy]) => {
      const ineligible = (policy.engine === "claude" && policy.permissionMode === "auto") || (policy.engine === "codex" && policy.approvalsReviewer === "auto_review")
      return { id: executionPolicyKey(policy), label, policy, revision,
        executionOwner: engine === "pi" ? "host" : "native-engine",
        boundary: engine === "pi" ? "tool-gating" : engine === "codex" ? "native-sandbox" : "native-permissions",
        availability: ineligible ? "unavailable" : verified ? "available" : "unknown",
        proof: { version: version ?? "unknown", source: engine === "pi" ? "Pinned @earendil-works/pi-coding-agent 1.5.0 beforeToolCall adapter" : engine === "claude" ? "Claude SDK 0.3.241 Query.setPermissionMode / canUseTool" : engine === "codex" ? "Codex f79b26cc app-server thread/turn policy API" : "OpenCode SDK 1.19.5 session.update permission rules / permission.reply", level: "versioned-api" },
        ...(ineligible ? { reason: "Runtime/model eligibility and managed requirements have not been verified." } : !verified ? { reason: engine === "pi" ? "This runtime version has not been verified. Tool gating only; no OS sandbox." : "This runtime version has not been verified." } : engine === "pi" ? { reason: "Tool gating only. Shell subprocesses have no OS sandbox." } : {}),
      }
    })
    return { engine, revision, executionPolicies, capabilities: [{ id: "set-execution-policy", availability: "available", revision: 1, executionOwner: "host", proof: { version: "1", source: "MemoSync policy service (desired-state command)", level: "versioned-api" } }] }
  }
}

interface RuntimeState {
  state: ExecutionPolicyState
  generation: number
  turnId?: string
  version?: string
  blocked: boolean
  uncertainProcesses: boolean
  restartRequired: boolean
  hasRuntime: boolean
}

/** Persisted effective values describe the last acknowledgement, never a live process after restart. */
export class HarnessPolicyService {
  private runtimes = new Map<string, RuntimeState>()
  constructor(readonly registry = new CapabilityRegistry()) {}
  private id(chatId: string, engine: AgentProvider) { return `${chatId}:${engine}` }
  ensure(chatId: string, policy: NativeExecutionPolicy, revision: number, persisted?: ExecutionPolicyState): RuntimeState {
    if (persisted && (!isExecutionPolicyState(persisted) || persisted.desired.engine !== policy.engine)) persisted = undefined
    const id = this.id(chatId, policy.engine)
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      const uncertainProcesses = persisted?.boundaries.some(b => b.boundary === "existing-processes" && b.status === "unknown") ?? false
      runtime = { state: { desired: structuredClone(policy), effective: null, desiredRevision: revision, effectiveRevision: null, status: uncertainProcesses ? "unknown" : "pending", reason: persisted?.effective ? "Last native acknowledgement is historical; this runtime must apply the policy again." : undefined, boundaries: [
        { boundary: "host-dispatch", status: "pending", revision, effectiveFrom: "next-turn" },
        { boundary: "native-runtime", status: "unknown", revision: persisted?.effectiveRevision ?? null, effectiveFrom: "next-turn" },
        ...(uncertainProcesses ? [{ boundary: "existing-processes" as const, status: "unknown" as const, revision: null, effectiveFrom: "unknown" as const }] : []),
      ] }, generation: Math.max(0, ...persisted?.boundaries.map(b => b.generation ?? 0) ?? []), blocked: true, uncertainProcesses, restartRequired: false, hasRuntime: false }
      this.runtimes.set(id, runtime)
    }
    return runtime
  }
  state(chatId: string, engine: AgentProvider): ExecutionPolicyState {
    const runtime = this.runtimes.get(this.id(chatId, engine))
    if (!runtime) throw new Error("Execution policy not initialized")
    return structuredClone(runtime.state)
  }
  snapshot(chatId: string, policy: NativeExecutionPolicy, revision: number, persisted?: ExecutionPolicyState, version?: string): ChatHarnessSnapshot {
    const runtime = this.ensure(chatId, policy, revision, persisted)
    if (version && !runtime.hasRuntime) runtime.version = version
    return { capabilities: this.registry.snapshot(policy.engine, runtime.version), policy: structuredClone(runtime.state) }
  }
  request(chatId: string, policy: NativeExecutionPolicy, expectedRevision: number, active: boolean): ExecutionPolicyState {
    const runtime = this.runtimes.get(this.id(chatId, policy.engine))
    if (!runtime || !Number.isSafeInteger(expectedRevision) || expectedRevision !== runtime.state.desiredRevision) throw new Error("Execution policy revision changed; refresh the chat")
    const choice = this.registry.snapshot(policy.engine, runtime.version).executionPolicies.find(c => executionPolicyKey(c.policy) === executionPolicyKey(policy))
    if (!choice || choice.availability !== "available") throw new Error(choice?.reason ?? "Unsupported execution policy")
    runtime.generation++
    runtime.blocked = true
    runtime.uncertainProcesses ||= active
    runtime.restartRequired = active
    runtime.state.desired = structuredClone(policy)
    runtime.state.desiredRevision++
    runtime.state.status = runtime.uncertainProcesses ? "partial" : "pending"
    runtime.state.reason = runtime.uncertainProcesses ? "New calls are blocked until the native session restarts. Previously started processes have not confirmed shutdown." : "Waiting for the next native policy acknowledgement."
    runtime.state.boundaries = [
      { boundary: "host-dispatch", status: "applied", revision: runtime.state.desiredRevision, effectiveFrom: "immediate", generation: runtime.generation },
      { boundary: "native-runtime", status: "pending", revision: runtime.state.effectiveRevision, effectiveFrom: "restart" },
      ...(runtime.uncertainProcesses ? [{ boundary: "existing-processes" as const, status: "unknown" as const, revision: null, effectiveFrom: "unknown" as const }] : []),
    ]
    return structuredClone(runtime.state)
  }
  /** Known native sessions have retired; descendant-process uncertainty remains a separate fact. */
  nativeRuntimeRetired(chatId: string, engine: AgentProvider): ExecutionPolicyState {
    const runtime = this.runtimes.get(this.id(chatId, engine))
    if (!runtime) throw new Error("Execution policy not initialized")
    runtime.restartRequired = false
    runtime.hasRuntime = false
    runtime.turnId = undefined
    runtime.blocked = true
    runtime.state.effective = null
    runtime.state.effectiveRevision = null
    runtime.state.reason = "Waiting for a fresh native session to acknowledge the requested policy."
    return structuredClone(runtime.state)
  }
  beginTurn(chatId: string, policy: NativeExecutionPolicy, revision: number, turnId: string, version?: string): PolicyCallScope {
    const runtime = this.ensure(chatId, policy, revision)
    if (runtime.restartRequired) throw new Error("The previous native session must retire before applying a new execution policy")
    if (revision !== runtime.state.desiredRevision || executionPolicyKey(policy) !== executionPolicyKey(runtime.state.desired)) throw new Error("Stale execution policy turn")
    runtime.version = version
    runtime.hasRuntime = true
    runtime.generation++
    runtime.turnId = turnId
    runtime.blocked = false
    runtime.state.status = runtime.uncertainProcesses ? "partial" : "pending"
    runtime.state.reason = "Waiting for native acknowledgement for this turn."
    runtime.state.boundaries = [
      { boundary: "host-dispatch", status: "applied", revision, effectiveFrom: "immediate", generation: runtime.generation, turnId },
      { boundary: "native-runtime", status: "pending", revision: runtime.state.effectiveRevision, effectiveFrom: "next-turn", generation: runtime.generation, turnId },
      ...(runtime.uncertainProcesses ? [{ boundary: "existing-processes" as const, status: "unknown" as const, revision: null, effectiveFrom: "unknown" as const }] : []),
    ]
    return Object.freeze({ chatId, engine: policy.engine, requestId: "turn", turnId, generation: runtime.generation, policyRevision: revision })
  }
  isCurrent(scope: PolicyCallScope): boolean {
    const runtime = this.runtimes.get(this.id(scope.chatId, scope.engine))
    return !!runtime && !runtime.blocked && runtime.turnId === scope.turnId && runtime.generation === scope.generation && runtime.state.desiredRevision === scope.policyRevision
  }
  applied(scope: PolicyCallScope, nativeSessionId?: string): ExecutionPolicyState | undefined {
    if (!this.isCurrent(scope)) throw new Error("Stale execution policy acknowledgement")
    const runtime = this.runtimes.get(this.id(scope.chatId, scope.engine))!
    runtime.state = { ...runtime.state, effective: structuredClone(runtime.state.desired), effectiveRevision: scope.policyRevision, status: runtime.uncertainProcesses ? "partial" : "applied", reason: runtime.uncertainProcesses ? "New calls use the acknowledged permissions. Previously started processes have not confirmed shutdown." : undefined, boundaries: [
      { boundary: "host-dispatch", status: "applied", revision: scope.policyRevision, effectiveFrom: "immediate", generation: scope.generation, turnId: scope.turnId },
      { boundary: "native-runtime", status: "applied", revision: scope.policyRevision, effectiveFrom: "next-turn", generation: scope.generation, nativeSessionId, turnId: scope.turnId },
      ...(runtime.uncertainProcesses ? [{ boundary: "existing-processes" as const, status: "unknown" as const, revision: null, effectiveFrom: "unknown" as const }] : []),
    ] }
    return structuredClone(runtime.state)
  }
  failed(scope: PolicyCallScope, reason: string): ExecutionPolicyState | undefined {
    if (!this.isCurrent(scope)) return
    const runtime = this.runtimes.get(this.id(scope.chatId, scope.engine))!
    runtime.blocked = true
    runtime.state.status = "rejected"
    runtime.state.reason = reason
    runtime.state.boundaries = runtime.state.boundaries.map(b => b.boundary === "native-runtime" ? { ...b, status: "rejected" } : b)
    return structuredClone(runtime.state)
  }
  endTurn(scope: PolicyCallScope) {
    if (!this.isCurrent(scope)) return
    const runtime = this.runtimes.get(this.id(scope.chatId, scope.engine))!
    runtime.turnId = undefined
    runtime.blocked = true
  }
  /** Only host-owned tools use this gate; native permission requests always need a native reply. */
  admit(scope: PolicyCallScope, toolName: string): "allow" | "ask" | "deny" {
    if (!this.isCurrent(scope)) return "deny"
    // Memory governance stays on its independent auto/review control axis.
    if (isMemoryTool(toolName) || isReadOnlyTool(toolName)) return "allow"
    const p = this.runtimes.get(this.id(scope.chatId, scope.engine))!.state.desired
    switch (p.engine) {
      case "pi": return p.toolGate === "read-only" ? "deny" : p.toolGate
      case "opencode": return p.permission
      case "codex": return p.sandbox === "read-only" ? "deny" : p.approvalPolicy === "never" ? "allow" : "ask"
      case "claude": return p.permissionMode === "dontAsk" ? "deny" : "ask"
    }
  }
}

export function isMemoryTool(name: string): boolean {
  return ["load_memory_detail", "propose_memory"].includes(name) || ["mcp__memory__load_memory_detail", "mcp__memory__propose_memory"].includes(name)
}
export function isReadOnlyTool(name: string): boolean {
  return ["read", "grep", "find", "ls", "glob", "list", "Read", "Grep", "Glob"].includes(name)
}
