import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatHarnessSnapshot, NativeExecutionPolicy } from "../../../shared/harness-capabilities"
import { ExecutionPolicyControl, executionPolicyKey } from "./ExecutionPolicyControl"

function snapshot(effective: NativeExecutionPolicy | null, desired: NativeExecutionPolicy): ChatHarnessSnapshot {
  return {
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

  test("no native acknowledgement does not present the desired mode as effective", () => {
    const desired: NativeExecutionPolicy = { engine: "claude", permissionMode: "acceptEdits" }
    const html = renderToStaticMarkup(<ExecutionPolicyControl chatId="chat-a" snapshot={snapshot(null, desired)} onChange={async () => undefined} />)
    expect(html).toContain("Not confirmed")
    expect(html).not.toContain("Accept file edits")
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
