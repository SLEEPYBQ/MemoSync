import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatHarnessSnapshot, NativeExecutionPolicy } from "../../../shared/harness-capabilities"
import { ExecutionPolicyControl, executionPolicyKey } from "./ExecutionPolicyControl"

function snapshot(effective: NativeExecutionPolicy | null, desired: NativeExecutionPolicy): ChatHarnessSnapshot {
  return {
    nativeRuntime: effective ? "present" : "absent",
    capabilities: { engine: desired.engine, revision: 1, capabilities: [], executionPolicies: [] },
    policy: {
      desired,
      effective,
      desiredRevision: 2,
      effectiveRevision: effective ? 1 : null,
      status: "pending",
      boundaries: [{ boundary: "native-runtime", status: "pending", revision: 1, effectiveFrom: "next-turn" }],
    },
  }
}

describe("execution permission state", () => {
  test("a pending Codex change keeps the effective mode on the composer", () => {
    const current: NativeExecutionPolicy = { engine: "codex", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" }
    const desired: NativeExecutionPolicy = { engine: "codex", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" }
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={snapshot(current, desired)} onChange={async () => undefined} />)
    expect(html).toContain("Read only / Ask when needed")
    expect(html).toContain("Waiting to apply")
    expect(html).not.toContain("Full access")
  })

  test("before startup the composer shows the selected launch configuration", () => {
    const desired: NativeExecutionPolicy = { engine: "claude", permissionMode: "acceptEdits" }
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={snapshot(null, desired)} onChange={async () => undefined} />)
    expect(html).toContain("Accept edits")
    expect(html).not.toContain("Not confirmed")
    expect(html).not.toContain("Waiting to apply")
  })

  test("a prepared session with no earlier policy shows the selection without a warning", () => {
    const desired: NativeExecutionPolicy = { engine: "pi", toolGate: "ask" }
    const prepared = snapshot(null, desired)
    prepared.nativeRuntime = "present"
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={prepared} onChange={async () => undefined} />)
    expect(html).toContain("Ask before tool use")
    expect(html).not.toContain("Not confirmed")
    expect(html).not.toContain("Waiting to apply")
  })

  test("an admitted native turn retains its real pending state", () => {
    const desired: NativeExecutionPolicy = { engine: "claude", permissionMode: "acceptEdits" }
    const starting = snapshot(null, desired)
    starting.nativeRuntime = "starting"
    starting.policy.boundaries[0]!.turnId = "turn-starting"
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={starting} onChange={async () => undefined} />)
    expect(html).toContain("Starting the native session")
    expect(html).toContain("Accept edits")
  })

  test("a closed runtime cannot keep a historical policy on the composer", () => {
    const previous: NativeExecutionPolicy = { engine: "claude", permissionMode: "default" }
    const desired: NativeExecutionPolicy = { engine: "claude", permissionMode: "acceptEdits" }
    const closed = snapshot(previous, desired)
    closed.nativeRuntime = "absent"
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={closed} onChange={async () => undefined} />)
    expect(html).toContain("Accept edits")
    expect(html).not.toContain("Ask when needed")
    expect(html).not.toContain("Waiting to apply")
  })

  test("a rejected launch keeps its error status visible", () => {
    const desired: NativeExecutionPolicy = { engine: "claude", permissionMode: "acceptEdits" }
    const rejected = snapshot(null, desired)
    rejected.policy.status = "rejected"
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={rejected} onChange={async () => undefined} />)
    expect(html).toContain("Accept edits")
    expect(html).toContain("Rejected")
  })

  test("Pi advertises its tool boundary in the composer label", () => {
    const policy: NativeExecutionPolicy = { engine: "pi", toolGate: "read-only" }
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={snapshot(policy, policy)} onChange={async () => undefined} />)
    expect(html).toContain("Read-only tools")
    expect(html).not.toContain("sandbox")
  })

  test("Codex reviewer and sandbox both participate in choice identity", () => {
    const user: NativeExecutionPolicy = { engine: "codex", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" }
    expect(executionPolicyKey(user)).not.toBe(executionPolicyKey({ ...user, approvalsReviewer: "auto_review" }))
    expect(executionPolicyKey(user)).not.toBe(executionPolicyKey({ ...user, sandbox: "read-only" }))
  })
})
