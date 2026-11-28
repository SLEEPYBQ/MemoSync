import { describe, expect, mock, test } from "bun:test"
import {
  EMPTY_DRAFT_STATE,
  MAX_DRAFT_STORAGE_CHUNKS,
  MAX_SECURE_STORE_DRAFT_BYTES,
  OVERSIZED_UNCOMMITTED_SEND_ERROR,
  applyDraftEdit,
  applyFailedSendRestore,
  applyPendingRestoredCommand,
  applyRestoredCommandReplace,
  applyStartInFlightSend,
  canApplySnapshotSynchronously,
  captureColdStartBaseline,
  capturePreSendBaseline,
  clearInFlightSendState,
  clearPendingRestoredCommand,
  createClientRequestId,
  deriveEffectiveChatStatus,
  deriveMemoryGateState,
  findPendingInteractiveToolId,
  hashDraftContent,
  hasUnconsumedPlanApproval,
  isStaleNativeCommandRestore,
  mergeTranscriptEntries,
  parsePersistedDraftState,
  reconcileColdStartInFlightSend,
  reconcilePendingDequeueRestoreAgainstSnapshot,
  reconcilePendingRetryAgainstSnapshot,
  recoverConnectionModelSelection,
  resolveSendClientRequestId,
  serializePersistedDraftState,
  serializePersistedDraftStateForStorage,
  shouldConfirmStaleCommandRestore,
  splitStringByUtf8Bytes,
  utf8ByteLength,
  wasSendCommittedInSnapshot,
} from "./chatState"
import { formatPairingCode, isValidHost, normalizeHostInput, parsePairingUri } from "./pairing"
import type { ChatSnapshot, ClientCommand, QueuedChatMessage, TranscriptEntry } from "../types"

const nativeRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto)
let expoCryptoUuidCalls = 0
mock.module("expo-crypto", () => ({
  randomUUID: () => {
    expoCryptoUuidCalls += 1
    return nativeRandomUUID()
  },
}))

mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}))

describe("mobile Fix 1: clientRequestId lifecycle and draft restoration", () => {
  test("reuses the same key on pure retries of identical content and mints a fresh key when edited", () => {
    const generated = ["uuid-1", "uuid-2", "uuid-3"]
    const nextId = () => generated.shift()!

    const initialKey = resolveSendClientRequestId("Regenerate report", null, nextId)
    expect(initialKey).toBe("uuid-1")

    // Unacked send restores into an empty composer -> keeps retry key.
    const restored = applyFailedSendRestore(
      EMPTY_DRAFT_STATE,
      "Regenerate report",
      "Disconnected from the MemoSync host",
      initialKey,
    )
    expect(restored.draft).toBe("Regenerate report")
    expect(restored.pendingRetry).toEqual({ clientRequestId: "uuid-1", content: "Regenerate report" })

    // Pure retry (even with leading/trailing whitespace unchanged in trimmed form) reuses uuid-1.
    expect(resolveSendClientRequestId("Regenerate report", restored.pendingRetry, nextId)).toBe("uuid-1")

    // Survives serialize/parse across app restarts.
    const raw = serializePersistedDraftState(restored)
    const rehydrated = parsePersistedDraftState(raw)
    expect(rehydrated).toEqual(restored)
    expect(resolveSendClientRequestId(rehydrated!.draft, rehydrated!.pendingRetry, nextId)).toBe("uuid-1")

    // Editing content invalidates the retry key so the next send gets a fresh UUID.
    const edited = applyDraftEdit(rehydrated!, "Regenerate report for Q3")
    expect(edited.pendingRetry).toBeNull()
    expect(resolveSendClientRequestId(edited.draft, edited.pendingRetry, nextId)).toBe("uuid-2")
  })

  test("merging an unacked send with newly typed text drops the old retry key", () => {
    const existing = { draft: "New message", pendingRetry: null, sendError: null }
    const merged = applyFailedSendRestore(existing, "Old message", "Disconnected", "uuid-1")
    expect(merged.draft).toBe("Old message\n\nNew message")
    expect(merged.pendingRetry).toBeNull()
  })

  test("parsePersistedDraftState discards mismatched retry keys and createClientRequestId returns a UUID", () => {
    const mismatched = parsePersistedDraftState(
      JSON.stringify({
        draft: "Edited text",
        pendingRetry: { clientRequestId: "uuid-1", content: "Original text" },
        sendError: null,
      }),
    )
    expect(mismatched).toEqual({ draft: "Edited text", pendingRetry: null, sendError: null })
    expect(createClientRequestId()).toMatch(/^[0-9a-f-]{36}$/i)
  })

  test("send reconciliation excludes baseline queue ids reused as prompt ids", () => {
    const baseline = capturePreSendBaseline(
      [{ _id: "p1", createdAt: 1, kind: "user_prompt", content: "hi" }],
      [{ id: "q1", content: "same text", createdAt: 2 }],
    )
    expect(
      wasSendCommittedInSnapshot(
        "same text",
        baseline,
        [{ _id: "q1", createdAt: 3, kind: "user_prompt", content: "same text" }],
        [],
      ),
    ).toBe(false)
    expect(
      wasSendCommittedInSnapshot(
        "same text",
        baseline,
        [{ _id: "p2", createdAt: 4, kind: "user_prompt", content: "same text" }],
        [],
      ),
    ).toBe(true)
  })
})

describe("mobile Fix 2: expired slash-command restore guard", () => {
  const expiredSlash: QueuedChatMessage = {
    id: "q-slash",
    rejection: "stale_native_command",
    content: "/review",
    createdAt: 10,
  }
  const regularQueued: QueuedChatMessage = {
    id: "q-normal",
    content: "follow up",
    createdAt: 11,
  }

  test("restores directly when composer is empty, requires confirmation when nonempty", () => {
    expect(isStaleNativeCommandRestore(expiredSlash)).toBe(true)
    expect(isStaleNativeCommandRestore(regularQueued)).toBe(false)
    expect(shouldConfirmStaleCommandRestore(expiredSlash, "")).toBe(false)
    expect(shouldConfirmStaleCommandRestore(expiredSlash, "   ")).toBe(false)
    expect(shouldConfirmStaleCommandRestore(expiredSlash, "Summarize the tests")).toBe(true)
    expect(shouldConfirmStaleCommandRestore(regularQueued, "Summarize the tests")).toBe(false)
  })

  test("replacing draft with restored command clears any previous retry key and does not merge", () => {
    const replaced = applyRestoredCommandReplace("/review")
    expect(replaced).toEqual({ draft: "/review", pendingRetry: null, sendError: null })
  })
})

describe("mobile Fix 3: stale/superseded memory-review cards", () => {
  test("active parked preview stays interactive when wire state is idle or previewing_memory", () => {
    const entries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Fix bug" },
      {
        _id: "mp1",
        createdAt: 2,
        kind: "memory_preview",
        previewId: "prev-1",
        memories: [{ id: "m1", content: "Rule A", scope: "project" }],
      },
    ]
    const idleState = deriveMemoryGateState(entries, "idle")
    expect(idleState.pendingPreviewId).toBe("prev-1")
    expect(idleState.supersededPreviewId).toBeNull()
    expect(idleState.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("idle", idleState)).toBe("waiting_for_user")

    const prepState = deriveMemoryGateState(entries, "previewing_memory")
    expect(prepState.pendingPreviewId).toBe("prev-1")
    expect(prepState.supersededPreviewId).toBeNull()
  })

  test("deactivates memory_preview as superseded when desktop reopens preparation and reactivates on matching update", () => {
    const reopenedEntries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Fix bug" },
      { _id: "pr1", createdAt: 2, kind: "memory_proposals", proposalsId: "prop-1", candidates: [{ id: "c1" }] },
      { _id: "prd1", createdAt: 3, kind: "memory_proposals_decision", proposalsId: "prop-1", decision: "reviewed" },
      { _id: "ck1", createdAt: 4, kind: "memory_checkup", checkupId: "chk-1" },
      { _id: "ckd1", createdAt: 5, kind: "memory_checkup_decision", checkupId: "chk-1", decision: "empty" },
      {
        _id: "mp1",
        createdAt: 6,
        kind: "memory_preview",
        previewId: "prev-1",
        memories: [{ id: "m1", content: "Rule A", scope: "project" }],
      },
      {
        _id: "rst1",
        createdAt: 7,
        kind: "memory_preparation_reset",
        previewId: "prev-1",
        revision: 1,
        from: "proposals",
        proposalsId: "prop-1",
        checkupId: "chk-1",
      },
    ]

    const reopenedState = deriveMemoryGateState(reopenedEntries, "previewing_memory")
    expect(reopenedState.pendingPreviewId).toBeNull()
    expect(reopenedState.supersededPreviewId).toBe("prev-1")
    expect(reopenedState.supersededPreviewReason).toBe("reopened")
    expect(reopenedState.openProposalsById.get("prop-1")).toMatchObject({
      proposalsId: "prop-1",
      scanning: false,
      superseded: false,
    })
    expect(reopenedState.openCheckupsById.get("chk-1")).toMatchObject({
      checkupId: "chk-1",
      waiting: true,
      superseded: false,
    })
    expect(deriveEffectiveChatStatus("previewing_memory", reopenedState)).toBe("waiting_for_user")

    // Once proposals and checkup settle, preview STILL stays superseded until memory_preview_update(rev >= 1) lands.
    const checkupScanningEntries: TranscriptEntry[] = [
      ...reopenedEntries,
      { _id: "prd2", createdAt: 8, kind: "memory_proposals_decision", proposalsId: "prop-1", decision: "reviewed" },
      {
        _id: "rst2",
        createdAt: 9,
        kind: "memory_preparation_reset",
        previewId: "prev-1",
        revision: 1,
        from: "checkup",
        proposalsId: "prop-1",
        checkupId: "chk-1",
      },
    ]
    const scanningState = deriveMemoryGateState(checkupScanningEntries, "previewing_memory")
    expect(scanningState.pendingPreviewId).toBeNull()
    expect(scanningState.supersededPreviewId).toBe("prev-1")
    expect(scanningState.hasOpenGate).toBe(true)
    expect(scanningState.hasParkedGate).toBe(false)
    expect(deriveEffectiveChatStatus("previewing_memory", scanningState)).toBe("previewing_memory")

    // After checkup finishes and host publishes memory_preview_update(revision: 1), preview reactivates.
    const refreshedEntries: TranscriptEntry[] = [
      ...checkupScanningEntries,
      { _id: "ckd2", createdAt: 10, kind: "memory_checkup_decision", checkupId: "chk-1", decision: "empty" },
      {
        _id: "mpu1",
        createdAt: 11,
        kind: "memory_preview_update",
        previewId: "prev-1",
        revision: 1,
        memories: [{ id: "m2", content: "Rule B", scope: "project" }],
      },
    ]
    const refreshedState = deriveMemoryGateState(refreshedEntries, "idle")
    expect(refreshedState.pendingPreviewId).toBe("prev-1")
    expect(refreshedState.supersededPreviewId).toBeNull()
    expect(refreshedState.previewMemoriesById.get("prev-1")).toEqual([
      { id: "m2", content: "Rule B", scope: "project" },
    ])
    expect(refreshedState.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("idle", refreshedState)).toBe("waiting_for_user")
  })

  test("marks preview and step-one gates superseded when host wire status proves it is no longer parked", () => {
    const previewEntries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Run" },
      { _id: "mp1", createdAt: 2, kind: "memory_preview", previewId: "prev-1", memories: [] },
    ]
    const runningState = deriveMemoryGateState(previewEntries, "running")
    expect(runningState.pendingPreviewId).toBeNull()
    expect(runningState.supersededPreviewId).toBe("prev-1")
    expect(runningState.supersededPreviewReason).toBe("inactive")
    expect(runningState.hasOpenGate).toBe(false)
    expect(runningState.hasParkedGate).toBe(false)

    // Step-one proposals gate when host restarted (wire status = idle): superseded, not parked.
    const stepOneOrphan: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Run" },
      { _id: "pr1", createdAt: 2, kind: "memory_proposals", proposalsId: "prop-1", candidates: [{ id: "c1" }] },
    ]
    const orphanState = deriveMemoryGateState(stepOneOrphan, "idle")
    expect(orphanState.openProposalsById.get("prop-1")).toMatchObject({
      proposalsId: "prop-1",
      superseded: true,
      scanning: false,
    })
    expect(orphanState.hasOpenGate).toBe(false)
    expect(orphanState.hasParkedGate).toBe(false)
    expect(deriveEffectiveChatStatus("idle", orphanState)).toBe("idle")
  })
})

describe("mobile smoke assertions: plan mode, model selection, pending tool, pairing", () => {
  test("plan approval, connection recovery, pending interactive tool, and pairing helpers", () => {
    const planEntries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Plan it" },
      { _id: "tc1", createdAt: 2, kind: "tool_call", tool: { kind: "tool", toolKind: "exit_plan_mode", toolId: "t1" } },
      { _id: "tr1", createdAt: 3, kind: "tool_result", toolId: "t1", content: { confirmed: true } },
    ]
    expect(hasUnconsumedPlanApproval(planEntries)).toBe(true)
    expect(findPendingInteractiveToolId(planEntries.slice(0, 2), "waiting_for_user")).toBe("t1")
    expect(findPendingInteractiveToolId(planEntries, "waiting_for_user")).toBeNull()

    const recovered = recoverConnectionModelSelection(
      { provider: "claude", model: "removed-model", modelOptions: { connectionId: "deleted-conn" } },
      { connections: [], engines: {} },
    )
    expect(recovered).toEqual({ provider: "claude" })

    expect(parsePairingUri("memosync://pair?host=192.168.1.20&port=4040")).toEqual({
      host: "192.168.1.20",
      port: 4040,
    })
    expect(parsePairingUri("memosync://pair?host=evil.com/path&port=4040")).toBeNull()
    expect(normalizeHostInput("http://192.168.1.20:4040/", "")).toEqual({ host: "192.168.1.20", port: 4040 })
    expect(isValidHost("192.168.1.20")).toBe(true)
    expect(isValidHost("999.1.1.1")).toBe(false)
    expect(formatPairingCode("abcd1234efgh")).toBe("ABCD-1234-EFGH")
  })
})

describe("F-3.1: separated in-flight tracking, cold-start reconciliation, unmount safety, and steer action binding", () => {
  test("cold-start reconciliation clears committed sends without resurrecting draft or reusing old key on deliberate resend", () => {
    const preSendEntries: TranscriptEntry[] = [
      { _id: "p1", createdAt: 100, kind: "user_prompt", content: "Start" },
    ]
    const baseline = captureColdStartBaseline(preSendEntries, [])
    const inFlightState = applyStartInFlightSend(EMPTY_DRAFT_STATE, {
      clientRequestId: "K1",
      content: "Continue",
      action: "send",
      baseline,
      sentAt: 200,
    })

    // Visible composer draft stays empty while in-flight metadata is persisted separately.
    expect(inFlightState.draft).toBe("")
    expect(inFlightState.pendingRetry).toBeNull()
    expect(inFlightState.inFlightSend?.clientRequestId).toBe("K1")

    // Rehydrate across simulated app restart.
    const raw = serializePersistedDraftStateForStorage(inFlightState)
    const rehydrated = parsePersistedDraftState(raw)
    expect(rehydrated?.draft).toBe("")
    expect(rehydrated?.inFlightSend?.clientRequestId).toBe("K1")

    // Host committed "Continue" and even replied before the app reopened.
    const postRestartSnapshotEntries: TranscriptEntry[] = [
      ...preSendEntries,
      { _id: "p2", createdAt: 210, kind: "user_prompt", content: "Continue" },
      { _id: "a2", createdAt: 220, kind: "assistant_text", text: "Done." },
    ]
    const result = reconcileColdStartInFlightSend(rehydrated!, postRestartSnapshotEntries, [])
    expect(result.reconciled).toBe(true)
    expect(result.committed).toBe(true)
    expect(result.state).toEqual(EMPTY_DRAFT_STATE)

    // Deliberate resend of identical text ("Continue") on the NEXT turn mints a brand-new key!
    const nextIds = ["K2"]
    const nextKey = resolveSendClientRequestId("Continue", result.state.pendingRetry, {
      action: "send",
      generateId: () => nextIds.shift()!,
    })
    expect(nextKey).toBe("K2")
  })

  test("cold-start reconciliation restores uncommitted sends with retry key and excludes baseline queue ids", () => {
    const preSendEntries: TranscriptEntry[] = [
      { _id: "p1", createdAt: 100, kind: "user_prompt", content: "Earlier" },
    ]
    const preSendQueue: QueuedChatMessage[] = [{ id: "q1", content: "Continue", createdAt: 150 }]
    const baseline = captureColdStartBaseline(preSendEntries, preSendQueue)
    const inFlightState = applyStartInFlightSend(EMPTY_DRAFT_STATE, {
      clientRequestId: "K1",
      content: "Continue",
      action: "queue",
      baseline,
      sentAt: 200,
    })

    // Pre-existing queued message q1 drained into a prompt with _id === "q1" — must NOT count as our new send!
    const snapshotEntries: TranscriptEntry[] = [
      ...preSendEntries,
      { _id: "q1", createdAt: 205, kind: "user_prompt", content: "Continue" },
    ]
    const result = reconcileColdStartInFlightSend(inFlightState, snapshotEntries, [])
    expect(result.reconciled).toBe(true)
    expect(result.committed).toBe(false)
    expect(result.state.draft).toBe("Continue")
    expect(result.state.pendingRetry).toEqual({
      clientRequestId: "K1",
      content: "Continue",
      action: "queue",
    })
    expect(result.state.inFlightSend).toBeUndefined()
  })

  test("switching follow-up mode between queue and steer mints a fresh clientRequestId while queue <-> send reuses it", () => {
    const ids = ["fresh-1", "fresh-2", "fresh-3"]
    const nextId = () => ids.shift()!

    const queuedRetry = applyFailedSendRestore(
      EMPTY_DRAFT_STATE,
      "Check logs",
      "Disconnected",
      "K-queue",
      "queue",
    ).pendingRetry
    expect(queuedRetry).toEqual({ clientRequestId: "K-queue", content: "Check logs", action: "queue" })

    // Pure queue retry or send retry (if turn finished while offline) reuses K-queue.
    expect(resolveSendClientRequestId("Check logs", queuedRetry, { action: "queue", generateId: nextId })).toBe("K-queue")
    expect(resolveSendClientRequestId("Check logs", queuedRetry, { action: "send", generateId: nextId })).toBe("K-queue")

    // Switching from queue -> steer MUST mint a fresh key so host doesn't skip steering.
    expect(resolveSendClientRequestId("Check logs", queuedRetry, { action: "steer", generateId: nextId })).toBe("fresh-1")

    // Conversely, switching from steer -> queue mints a fresh key, while steer -> steer and
    // steer -> send (when the active turn finishes while offline) both reuse K-steer.
    const steerRetry = applyFailedSendRestore(
      EMPTY_DRAFT_STATE,
      "Check logs",
      "Disconnected",
      "K-steer",
      "steer",
    ).pendingRetry
    expect(resolveSendClientRequestId("Check logs", steerRetry, { action: "steer", generateId: nextId })).toBe("K-steer")
    expect(resolveSendClientRequestId("Check logs", steerRetry, { action: "send", generateId: nextId })).toBe("K-steer")
    expect(resolveSendClientRequestId("Check logs", steerRetry, { action: "queue", generateId: nextId })).toBe("fresh-2")
  })

  test("V-3: wasSendCommittedInSnapshot checks clientRequestId first and reconcilePendingRetryAgainstSnapshot clears post-timeout committed drafts", () => {
    const baseline = capturePreSendBaseline([], [])
    // Native skill rewritten on host from "/audit src/" -> "$audit src/" still reconciles via clientRequestId!
    expect(
      wasSendCommittedInSnapshot(
        "/audit src/",
        baseline,
        [{ _id: "p1", createdAt: 10, kind: "user_prompt", content: "$audit src/", clientRequestId: "K-skill-1" }],
        [],
        "K-skill-1",
      ),
    ).toBe(true)

    // Snapshot arriving AFTER the 8s timeout cleared inFlightSend and restored pendingRetry
    // must clear the stale restored draft, retry key, and error banner once user_prompt(K1) appears.
    const restoredAfterTimeout = applyFailedSendRestore(
      EMPTY_DRAFT_STATE,
      "Refactor auth.ts",
      "Disconnected from the MemoSync host",
      "K-steer-timeout-1",
      "steer",
    )
    expect(reconcilePendingRetryAgainstSnapshot(restoredAfterTimeout, [])).toBe(restoredAfterTimeout)

    const cleared = reconcilePendingRetryAgainstSnapshot(restoredAfterTimeout, [
      { _id: "p2", createdAt: 20, kind: "user_prompt", content: "Refactor auth.ts", clientRequestId: "K-steer-timeout-1" },
    ])
    expect(cleared).toEqual(EMPTY_DRAFT_STATE)

    // Rewritten native skill draft is also cleared by clientRequestId match when composer draft is unedited.
    const restoredSkill = applyFailedSendRestore(
      EMPTY_DRAFT_STATE,
      "/audit src/",
      "Disconnected from the MemoSync host",
      "K-skill-timeout-1",
      "send",
    )
    const clearedSkill = reconcilePendingRetryAgainstSnapshot(restoredSkill, [
      { _id: "p3", createdAt: 30, kind: "user_prompt", content: "$audit src/", clientRequestId: "K-skill-timeout-1" },
    ])
    expect(clearedSkill).toEqual(EMPTY_DRAFT_STATE)
  })
})

describe("F-3.2 & F-4.1: draftStore CJK capacity, serialized Keychain writes, unmount safety, forget() cleanup, and persisted restored commands", () => {
  test("compact v2 serialization eliminates doubling: 400-char CJK draft + retry key fits under 1900 bytes and round-trips", () => {
    const cjkPrompt = "请帮我检查这个并发写入竞态问题。".repeat(25) // 400 CJK chars = 1,200 UTF-8 bytes
    expect(utf8ByteLength(cjkPrompt)).toBeGreaterThan(1_100)

    const restored = applyFailedSendRestore(
      EMPTY_DRAFT_STATE,
      cjkPrompt,
      "Disconnected from the MemoSync host",
      "11111111-2222-4333-8444-555555555555",
      "queue",
    )
    const serialized = serializePersistedDraftStateForStorage(restored, MAX_SECURE_STORE_DRAFT_BYTES)
    expect(serialized).not.toBeNull()
    expect(utf8ByteLength(serialized!)).toBeLessThanOrEqual(MAX_SECURE_STORE_DRAFT_BYTES)

    const rehydrated = parsePersistedDraftState(serialized)
    expect(rehydrated).toEqual(restored)
  })

  test("oversized draft (>1900 bytes) preserves hash-only clientRequestId + cold-start reconciliation metadata instead of dropping key", () => {
    const hugeCjk = "长文本测试数据用于验证超长消息的去重键和冷启动对账逻辑。".repeat(40) // >3000 UTF-8 bytes
    expect(utf8ByteLength(hugeCjk)).toBeGreaterThan(MAX_SECURE_STORE_DRAFT_BYTES)

    const baseline = captureColdStartBaseline([], [])
    const inFlight = applyStartInFlightSend(EMPTY_DRAFT_STATE, {
      clientRequestId: "K-huge-1",
      content: hugeCjk,
      action: "send",
      baseline,
      sentAt: 500,
    })
    const stored = serializePersistedDraftStateForStorage(inFlight, MAX_SECURE_STORE_DRAFT_BYTES)
    expect(stored).not.toBeNull()
    expect(utf8ByteLength(stored!)).toBeLessThanOrEqual(MAX_SECURE_STORE_DRAFT_BYTES)

    const rehydrated = parsePersistedDraftState(stored)
    expect(rehydrated?.inFlightSend?.clientRequestId).toBe("K-huge-1")
    expect(rehydrated?.inFlightSend?.contentHash).toBe(hashDraftContent(hugeCjk))

    // Cold-start reconciliation still detects host commit via contentHash!
    const committed = reconcileColdStartInFlightSend(
      rehydrated!,
      [{ _id: "p1", createdAt: 510, kind: "user_prompt", content: hugeCjk }],
      [],
    )
    expect(committed.committed).toBe(true)
    expect(committed.state).toEqual(EMPTY_DRAFT_STATE)

    // And when NOT committed, pasting the exact same prompt reuses K-huge-1!
    const uncommitted = reconcileColdStartInFlightSend(rehydrated!, [], [])
    expect(uncommitted.committed).toBe(false)
    expect(
      resolveSendClientRequestId(hugeCjk, uncommitted.state.pendingRetry, {
        action: "send",
        generateId: () => "should-not-mint",
      }),
    ).toBe("K-huge-1")
  })

  test("draftStore serializes Keychain writes (slow save -> fast clear), preserves newer drafts across unmount completion, persists pendingRestoredCommand, and wipes all keys on clearAllPersistedDrafts()", async () => {
    const draftStore = await import("./draftStore")
    const disk = new Map<string, string>()
    let releaseFirstSet!: () => void
    let setCalls = 0
    const firstSetDelay = new Promise<void>((resolve) => {
      releaseFirstSet = resolve
    })

    draftStore.setDraftStorageBackendForTesting({
      getItemAsync: async (key) => disk.get(key) ?? null,
      setItemAsync: async (key, value) => {
        setCalls += 1
        if (setCalls === 1) await firstSetDelay
        disk.set(key, value)
      },
      deleteItemAsync: async (key) => {
        disk.delete(key)
      },
    })

    try {
      // 1. Rapid save -> clear race: first setItemAsync is delayed, deleteItemAsync follows immediately.
      const s1 = applyFailedSendRestore(EMPTY_DRAFT_STATE, "Quick send", "Offline", "K-race", "send")
      draftStore.savePersistedDraftState("chat-race", s1, { immediate: true })
      draftStore.clearPersistedDraftState("chat-race")
      releaseFirstSet()
      await draftStore.flushAllDraftWrites()
      expect(disk.has(draftStore.secureStoreKeyForDraft("chat-race"))).toBe(false)
      expect(draftStore.getCachedDraftState("chat-race")).toBeNull()

      // 2. Unmounted send completion uses live draftStore state and notifies active subscriber without clobbering newer draft.
      const observed: string[] = []
      const unsub = draftStore.subscribeDraftState("chat-unmount", (next) => observed.push(next.draft))
      draftStore.markInFlightSendActive("chat-unmount", "K-in-flight")
      draftStore.updatePersistedDraftState(
        "chat-unmount",
        (cur) =>
          applyStartInFlightSend(cur, {
            clientRequestId: "K-in-flight",
            content: "Original message",
            action: "send",
            baseline: captureColdStartBaseline([], []),
            sentAt: 1,
          }),
        { immediate: true },
      )
      // Remounted instance sees empty composer and user types "New draft".
      expect(draftStore.getCachedDraftState("chat-unmount")?.draft).toBe("")
      draftStore.updatePersistedDraftState("chat-unmount", (cur) => applyDraftEdit(cur, "New draft"), {
        immediate: false,
      })
      // Unmounted first send succeeds -> clears inFlightSend ONLY, keeping "New draft".
      draftStore.clearInFlightSendActive("chat-unmount", "K-in-flight")
      draftStore.updatePersistedDraftState(
        "chat-unmount",
        (live) => clearInFlightSendState(live, "K-in-flight"),
        { immediate: true },
      )
      expect(draftStore.getCachedDraftState("chat-unmount")?.draft).toBe("New draft")
      expect(draftStore.getCachedDraftState("chat-unmount")?.inFlightSend).toBeUndefined()
      expect(observed.at(-1)).toBe("New draft")
      unsub()

      // 3. F-4.1: pendingRestoredCommand survives serialization and unmount/remount, and can be discarded cleanly.
      draftStore.updatePersistedDraftState(
        "chat-unmount",
        (live) => applyPendingRestoredCommand(live, "/review src/"),
        { immediate: true },
      )
      await draftStore.flushAllDraftWrites()
      const rawBeforeRestart = disk.get(draftStore.secureStoreKeyForDraft("chat-unmount"))
      expect(parsePersistedDraftState(rawBeforeRestart)?.pendingRestoredCommand).toBe("/review src/")
      const afterKeep = clearPendingRestoredCommand(draftStore.getCachedDraftState("chat-unmount")!)
      expect(afterKeep.draft).toBe("New draft")
      expect(afterKeep.pendingRestoredCommand).toBeUndefined()

      // 4. F-3.2: clearAllPersistedDrafts (called by hostStore.forget()) wipes RAM + all Keychain entries + index,
      // even after a cold restart where RAM is empty.
      draftStore.savePersistedDraftState("chat-other", { draft: "Secret prompt", pendingRetry: null, sendError: null })
      await draftStore.flushAllDraftWrites()
      expect(disk.size).toBeGreaterThanOrEqual(3) // 2 chats + _index

      // Simulate cold restart with empty memoryDrafts before forget() runs.
      const diskBackend = {
        getItemAsync: async (key: string) => disk.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => {
          disk.set(key, value)
        },
        deleteItemAsync: async (key: string) => {
          disk.delete(key)
        },
      }
      draftStore.setDraftStorageBackendForTesting(diskBackend)
      await draftStore.clearAllPersistedDrafts()
      await draftStore.flushAllDraftWrites()
      expect(disk.size).toBe(0)
      expect(draftStore.getCachedDraftState("chat-other")).toBeNull()
    } finally {
      draftStore.setDraftStorageBackendForTesting()
    }
  })
})

describe("F-5.1, F-5.2, F-5.3: memory preview liveness with failed previous turn, host restart orphans, recompute transfer, and atomic snapshots", () => {
  test("F-5.1: genuinely parked memory_preview stays live even when lastTurnOutcome === 'failed' (wireStatus === 'failed')", () => {
    const entries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Turn 1" },
      { _id: "r1", createdAt: 2, kind: "result", subtype: "error", isError: true, durationMs: 10, result: "Boom" },
      { _id: "u2", createdAt: 3, kind: "user_prompt", content: "Turn 2" },
      {
        _id: "mp2",
        createdAt: 4,
        kind: "memory_preview",
        previewId: "prev-2",
        memories: [{ id: "m1", content: "Rule A", scope: "project" }],
      },
    ]

    // Authoritative host runtime reports wireStatus="failed" (from Turn 1) + pendingMemoryPreviewId="prev-2".
    const liveState = deriveMemoryGateState(entries, "failed", "prev-2")
    expect(liveState.pendingPreviewId).toBe("prev-2")
    expect(liveState.supersededPreviewId).toBeNull()
    expect(liveState.hasOpenGate).toBe(true)
    expect(liveState.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("failed", liveState)).toBe("waiting_for_user")

    // Older-host fallback (pendingMemoryPreviewId === undefined) also keeps it live when no post-preview result exists,
    // while a current-turn failure (post-preview result entry) terminates the tail scan and hides the card.
    const legacyState = deriveMemoryGateState(entries, "failed")
    expect(legacyState.pendingPreviewId).toBe("prev-2")
    const currentTurnFailed = deriveMemoryGateState(
      [...entries, { _id: "r2", createdAt: 5, kind: "result", subtype: "error", isError: true, durationMs: 0, result: "Prep failed" }],
      "failed",
    )
    expect(currentTurnFailed.pendingPreviewId).toBeNull()
    expect(currentTurnFailed.supersededPreviewId).toBeNull()
  })

  test("F-5.2: orphaned memory_preview after host restart (wireStatus='idle', pendingMemoryPreviewId=null) deactivates as superseded", () => {
    const entries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Task" },
      {
        _id: "mp1",
        createdAt: 2,
        kind: "memory_preview",
        previewId: "prev-orphan",
        memories: [{ id: "m1", content: "Rule A", scope: "project" }],
      },
    ]

    const restartedState = deriveMemoryGateState(entries, "idle", null)
    expect(restartedState.pendingPreviewId).toBeNull()
    expect(restartedState.supersededPreviewId).toBe("prev-orphan")
    expect(restartedState.supersededPreviewReason).toBe("inactive")
    expect(restartedState.hasOpenGate).toBe(false)
    expect(restartedState.hasParkedGate).toBe(false)
    expect(deriveEffectiveChatStatus("idle", restartedState)).toBe("idle")
  })

  test("F-5.2: recomputed memory_transfer_result(done: true) after proposals reopen clears prior transfer decision and surfaces the re-parked gate", () => {
    // Mirrors the exact event stream emitted by AgentCoordinator.runReopenedMemoryPreparation ->
    // refreshTransferAfterCandidateReview -> runTransferGate(..., { recompute: true }) in memoryBranches mode.
    const baseEntries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Task" },
      { _id: "pr1", createdAt: 2, kind: "memory_proposals", proposalsId: "prop-1", candidates: [{ id: "c1" }] },
      { _id: "prd1", createdAt: 3, kind: "memory_proposals_decision", proposalsId: "prop-1", decision: "reviewed" },
      { _id: "tr1", createdAt: 4, kind: "memory_transfer", transferId: "tr-1", suggestions: [{ sourceId: "s1", content: "Old" }] },
      { _id: "trd1", createdAt: 5, kind: "memory_transfer_decision", transferId: "tr-1", decision: "handled" },
      { _id: "mp1", createdAt: 6, kind: "memory_preview", previewId: "prev-1", memories: [] },
      // Host reopens proposals (from: "proposals", NOT from: "transfer")
      {
        _id: "rst1",
        createdAt: 7,
        kind: "memory_preparation_reset",
        previewId: "prev-1",
        revision: 1,
        from: "proposals",
        proposalsId: "prop-1",
        transferId: "tr-1",
        checkupId: "chk-1",
      },
      // Proposals settles again; refreshTransferAfterCandidateReview runs with recompute: true
      // and appends the final done: true result when the gate re-parks.
      { _id: "prd2", createdAt: 8, kind: "memory_proposals_decision", proposalsId: "prop-1", decision: "reviewed" },
    ]

    const parkedTransfer = deriveMemoryGateState(
      [
        ...baseEntries,
        {
          _id: "trr2",
          createdAt: 10,
          kind: "memory_transfer_result",
          transferId: "tr-1",
          suggestions: [{ sourceId: "s2", content: "Updated transfer" }],
          done: true,
        },
      ],
      "previewing_memory",
      null,
    )
    expect(parkedTransfer.openTransfersById.get("tr-1")).toMatchObject({
      transferId: "tr-1",
      count: 1,
      scanning: false,
      superseded: false,
    })
    expect(parkedTransfer.hasParkedGate).toBe(true)
    expect(parkedTransfer.pendingPreviewId).toBeNull()
    expect(parkedTransfer.supersededPreviewId).toBe("prev-1")
    expect(deriveEffectiveChatStatus("previewing_memory", parkedTransfer)).toBe("waiting_for_user")
  })

  test("F-5.3: synchronous atomic snapshot fast-path applies contiguous updates without splitting wireStatus and transcript", () => {
    const initial: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Hi" },
      { _id: "mp1", createdAt: 2, kind: "memory_preview", previewId: "prev-1", memories: [] },
    ]
    const nextWindow: TranscriptEntry[] = [
      ...initial,
      { _id: "mpd1", createdAt: 3, kind: "memory_preview_decision", previewId: "prev-1", decision: "go_on" },
    ]

    // Normal decision update includes anchor "mp1" and has no pending backfill -> synchronous atomic commit!
    expect(canApplySnapshotSynchronously(initial, nextWindow, false)).toBe(true)
    const merged = mergeTranscriptEntries(initial, nextWindow)
    const afterDecision = deriveMemoryGateState(merged, "starting", null)
    expect(afterDecision.pendingPreviewId).toBeNull()
    expect(afterDecision.supersededPreviewId).toBeNull()

    // Gap beyond 200 messages (anchor "mp1" missing) OR active backfill forces async atomic commit (deferring snapshot until backfill completes).
    const gappedWindow: TranscriptEntry[] = [
      { _id: "u50", createdAt: 500, kind: "user_prompt", content: "Much later" },
    ]
    expect(canApplySnapshotSynchronously(initial, gappedWindow, false)).toBe(false)
    expect(canApplySnapshotSynchronously(initial, nextWindow, true)).toBe(false)
  })

  test("V-5: memory_preparation_reset(from: 'checkup') on in-place checkup invalidation transitions mobile card to scanning until fresh result lands", () => {
    const parkedEntries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Check migrations" },
      { _id: "ck1", createdAt: 2, kind: "memory_checkup", checkupId: "chk-1", pending: true },
      {
        _id: "ckr1",
        createdAt: 3,
        kind: "memory_checkup_result",
        checkupId: "chk-1",
        suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "Old suggestion" }],
      },
    ]
    const parked = deriveMemoryGateState(parkedEntries, "previewing_memory", null)
    expect(parked.openCheckupsById.get("chk-1")).toMatchObject({
      checkupId: "chk-1",
      count: 1,
      scanning: false,
      waiting: false,
      superseded: false,
    })
    expect(parked.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("previewing_memory", parked)).toBe("waiting_for_user")

    // Host invalidates the parked checkup gate and emits memory_preparation_reset(from: "checkup", checkupId).
    const invalidatingEntries: TranscriptEntry[] = [
      ...parkedEntries,
      {
        _id: "rst-chk-1",
        createdAt: 4,
        kind: "memory_preparation_reset",
        revision: 1,
        from: "checkup",
        checkupId: "chk-1",
      },
    ]
    const recomputing = deriveMemoryGateState(invalidatingEntries, "previewing_memory", null)
    expect(recomputing.openCheckupsById.get("chk-1")).toMatchObject({
      checkupId: "chk-1",
      count: 0,
      scanning: true,
      waiting: false,
      superseded: false,
    })
    expect(recomputing.hasOpenGate).toBe(true)
    expect(recomputing.hasParkedGate).toBe(false)
    expect(deriveEffectiveChatStatus("previewing_memory", recomputing)).toBe("previewing_memory")

    // Once recomputation finishes and publishes a fresh memory_checkup_result, the card becomes interactive again.
    const refreshed = deriveMemoryGateState(
      [
        ...invalidatingEntries,
        {
          _id: "ckr2",
          createdAt: 5,
          kind: "memory_checkup_result",
          checkupId: "chk-1",
          suggestions: [{ kind: "conflict", memoryId: "M-02", reason: "Refreshed suggestion" }],
        },
      ],
      "previewing_memory",
      null,
    )
    expect(refreshed.openCheckupsById.get("chk-1")).toMatchObject({
      checkupId: "chk-1",
      count: 1,
      scanning: false,
      waiting: false,
      superseded: false,
    })
    expect(refreshed.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("previewing_memory", refreshed)).toBe("waiting_for_user")
  })

  test("F-9: invalidateMemoryGate({ kind: 'transfer' }) emitting memory_transfer_result(done: false) flips mobile card to scanning until done: true lands", () => {
    const parkedEntries: TranscriptEntry[] = [
      { _id: "u1", createdAt: 1, kind: "user_prompt", content: "Review auth token refresh" },
      {
        _id: "tr1",
        createdAt: 2,
        kind: "memory_transfer",
        transferId: "tr-live-1",
        suggestions: [{ sourceId: "s1", content: "Old transfer suggestion" }],
      },
    ]
    const parked = deriveMemoryGateState(parkedEntries, "previewing_memory", null)
    expect(parked.openTransfersById.get("tr-live-1")).toMatchObject({
      transferId: "tr-live-1",
      count: 1,
      scanning: false,
      superseded: false,
    })
    expect(parked.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("previewing_memory", parked)).toBe("waiting_for_user")

    // Host invalidates transfer gate -> emits memory_transfer_result(suggestions: [], done: false) before recomputation.
    const invalidatingEntries: TranscriptEntry[] = [
      ...parkedEntries,
      {
        _id: "trr-inv",
        createdAt: 3,
        kind: "memory_transfer_result",
        transferId: "tr-live-1",
        suggestions: [],
        done: false,
      },
    ]
    const recomputing = deriveMemoryGateState(invalidatingEntries, "previewing_memory", null)
    expect(recomputing.openTransfersById.get("tr-live-1")).toMatchObject({
      transferId: "tr-live-1",
      count: 0,
      scanning: true,
      superseded: false,
    })
    expect(recomputing.hasOpenGate).toBe(true)
    expect(recomputing.hasParkedGate).toBe(false)
    expect(deriveEffectiveChatStatus("previewing_memory", recomputing)).toBe("previewing_memory")

    // Recomputed done: true result arrives -> card re-parks and becomes actionable again.
    const refreshed = deriveMemoryGateState(
      [
        ...invalidatingEntries,
        {
          _id: "trr-done",
          createdAt: 4,
          kind: "memory_transfer_result",
          transferId: "tr-live-1",
          suggestions: [{ sourceId: "s1", content: "Refreshed transfer suggestion" }],
          done: true,
        },
      ],
      "previewing_memory",
      null,
    )
    expect(refreshed.openTransfersById.get("tr-live-1")).toMatchObject({
      transferId: "tr-live-1",
      count: 1,
      scanning: false,
      superseded: false,
    })
    expect(refreshed.hasParkedGate).toBe(true)
    expect(deriveEffectiveChatStatus("previewing_memory", refreshed)).toBe("waiting_for_user")
  })
})

describe("Round-4 regressions: CSPRNG (F-3), queued reconciliation (F-4), chunked drafts (F-5), dequeue resilience (F-7), slash non-merge (F-8), and ChatScreen actions (F-10)", () => {
  function makeSnapshot(overrides?: Partial<ChatSnapshot>): ChatSnapshot {
    return {
      runtime: {
        memoryDisabled: false,
        chatId: "chat-1",
        projectId: "proj-1",
        localPath: "/repo",
        title: "Test Chat",
        status: "running",
        pendingMemoryPreviewId: null,
        isDraining: false,
        provider: "pi",
        planMode: false,
        sessionToken: null,
        streamingText: null,
      },
      queuedMessages: [],
      messages: [],
      history: { hasOlder: false, olderCursor: null, recentLimit: 200 },
      ...overrides,
    }
  }

  test("F-3: draftStore registers expo-crypto CSPRNG so createClientRequestId does not fall back to Math.random() on Hermes", async () => {
    await import("./draftStore")
    const before = expoCryptoUuidCalls
    const originalCrypto = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true })
    try {
      const id = createClientRequestId()
      expect(id).toMatch(/^[0-9a-f-]{36}$/i)
      expect(expoCryptoUuidCalls).toBe(before + 1)
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true, writable: true })
    }
  })

  test("F-5: draftStore chunks >1900-byte drafts cleanly across SecureStore keys without wiping Keychain while typing, restores full text on cold start, and uses truthful copy past the multi-chunk cap", async () => {
    const draftStore = await import("./draftStore")
    const disk = new Map<string, string>()
    const oversizedWrites: Array<{ key: string; bytes: number }> = []
    const makeBackend = () => ({
      getItemAsync: async (key: string) => disk.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => {
        const bytes = utf8ByteLength(value)
        if (bytes > MAX_SECURE_STORE_DRAFT_BYTES) {
          oversizedWrites.push({ key, bytes })
        }
        disk.set(key, value)
      },
      deleteItemAsync: async (key: string) => {
        disk.delete(key)
      },
    })
    draftStore.setDraftStorageBackendForTesting(makeBackend())

    try {
      // 1. Typing across the 1,900-byte boundary (1,800B -> 3,600B -> 10,000B CJK + emoji surrogate pairs).
      const smallDraft = "a".repeat(1_500)
      draftStore.savePersistedDraftState("chat-long", { draft: smallDraft, pendingRetry: null, sendError: null }, { immediate: true })
      await draftStore.flushAllDraftWrites()
      expect(disk.has(draftStore.secureStoreKeyForDraft("chat-long"))).toBe(true)

      const mediumCjkDraft = "请帮我排查这个多段落长消息的持久化问题🚀。".repeat(80) // ~4,800 UTF-8 bytes
      expect(utf8ByteLength(mediumCjkDraft)).toBeGreaterThan(4_000)
      expect(splitStringByUtf8Bytes(mediumCjkDraft, MAX_SECURE_STORE_DRAFT_BYTES).join("")).toBe(mediumCjkDraft)
      draftStore.savePersistedDraftState("chat-long", { draft: mediumCjkDraft, pendingRetry: null, sendError: null }, { immediate: true })
      await draftStore.flushAllDraftWrites()
      expect(oversizedWrites).toEqual([])
      expect(disk.has(draftStore.secureStoreKeyForDraft("chat-long"))).toBe(true)
      expect(disk.has(draftStore.secureStoreChunkKeyForDraft("chat-long", 0))).toBe(true)
      expect(disk.has(draftStore.secureStoreChunkKeyForDraft("chat-long", 1))).toBe(true)

      // Cold restart: empty in-memory cache -> loads 100% verbatim draft from chunks!
      draftStore.setDraftStorageBackendForTesting(makeBackend())
      const loadedDraft = await draftStore.loadPersistedDraftState("chat-long")
      expect(loadedDraft?.draft).toBe(mediumCjkDraft)

      // 2. Cold-start uncommitted send >1,900 bytes (~6,000 bytes) restores FULL prompt text verbatim!
      const largeUnackedPrompt = "Detailed multi-paragraph review prompt with CJK 中文 and context. ".repeat(90)
      expect(utf8ByteLength(largeUnackedPrompt)).toBeGreaterThan(5_000)
      const inFlight = applyStartInFlightSend(EMPTY_DRAFT_STATE, {
        clientRequestId: "K-large-chunked",
        content: largeUnackedPrompt,
        action: "send",
        baseline: captureColdStartBaseline([], []),
        sentAt: 1000,
      })
      draftStore.savePersistedDraftState("chat-inflight-large", inFlight, { immediate: true })
      await draftStore.flushAllDraftWrites()
      expect(oversizedWrites).toEqual([])

      draftStore.setDraftStorageBackendForTesting(makeBackend())
      const rehydratedInFlight = await draftStore.loadPersistedDraftState("chat-inflight-large")
      expect(rehydratedInFlight?.inFlightSend?.content).toBe(largeUnackedPrompt.trim())
      const reconciled = reconcileColdStartInFlightSend(rehydratedInFlight!, [], [])
      expect(reconciled.committed).toBe(false)
      expect(reconciled.state.draft).toBe(largeUnackedPrompt.trim())
      expect(reconciled.state.pendingRetry?.clientRequestId).toBe("K-large-chunked")

      // 3. Shrinking back below 1,900 bytes cleans up stale chunk keys.
      draftStore.savePersistedDraftState("chat-long", { draft: "Short again", pendingRetry: null, sendError: null }, { immediate: true })
      await draftStore.flushAllDraftWrites()
      expect(disk.has(draftStore.secureStoreChunkKeyForDraft("chat-long", 0))).toBe(false)
      expect(disk.has(draftStore.secureStoreChunkKeyForDraft("chat-long", 1))).toBe(false)

      // 4. Exceeding the 8-chunk (~15 KB) cap falls back to hash-only metadata and surfaces truthful non-actionable copy.
      const giantPrompt = "超大文本提示词".repeat(1_200) // >25,000 UTF-8 bytes (> 8 * 1,900)
      expect(utf8ByteLength(giantPrompt)).toBeGreaterThan(MAX_DRAFT_STORAGE_CHUNKS * MAX_SECURE_STORE_DRAFT_BYTES)
      const giantInFlight = applyStartInFlightSend(EMPTY_DRAFT_STATE, {
        clientRequestId: "K-giant-1",
        content: giantPrompt,
        action: "send",
        baseline: captureColdStartBaseline([], []),
        sentAt: 2000,
      })
      draftStore.savePersistedDraftState("chat-giant", giantInFlight, { immediate: true })
      await draftStore.flushAllDraftWrites()
      expect(oversizedWrites).toEqual([])

      draftStore.setDraftStorageBackendForTesting(makeBackend())
      const rehydratedGiant = await draftStore.loadPersistedDraftState("chat-giant")
      expect(rehydratedGiant?.inFlightSend?.clientRequestId).toBe("K-giant-1")
      expect(rehydratedGiant?.inFlightSend?.content).toBe("")
      const reconciledGiant = reconcileColdStartInFlightSend(rehydratedGiant!, [], [])
      expect(reconciledGiant.committed).toBe(false)
      expect(reconciledGiant.state.draft).toBe("")
      expect(reconciledGiant.state.sendError).toBe(OVERSIZED_UNCOMMITTED_SEND_ERROR)
      expect(reconciledGiant.state.sendError).not.toContain("Tap send to retry")

      // 5. clearAllPersistedDrafts wipes all chunk keys as well as base keys and index.
      await draftStore.clearAllPersistedDrafts()
      await draftStore.flushAllDraftWrites()
      expect(disk.size).toBe(0)
    } finally {
      draftStore.setDraftStorageBackendForTesting()
    }
  })

  test("F-8: applyFailedSendRestore never merges a failed slash command into a nonempty composer draft", () => {
    const existing = { draft: "Summarize failing CI jobs", pendingRetry: null, sendError: null }
    const restored = applyFailedSendRestore(
      existing,
      "/review",
      "Disconnected from the MemoSync host",
      "K-slash-1",
      "send",
    )
    expect(restored.draft).toBe("Summarize failing CI jobs")
    expect(restored.draft).not.toContain("/review")
    expect(restored.pendingRestoredCommand).toBe("/review")
    expect(restored.sendError).toBe("Disconnected from the MemoSync host")

    // Also works with leading whitespace and slash command arguments.
    const restoredWithArgs = applyFailedSendRestore(existing, "  /init", "Timed out", "K-init-1", "send")
    expect(restoredWithArgs.draft).toBe("Summarize failing CI jobs")
    expect(restoredWithArgs.pendingRestoredCommand).toBe("  /init")

    // Empty composer still restores slash command directly with retry key.
    const restoredEmpty = applyFailedSendRestore(EMPTY_DRAFT_STATE, "/review", "Offline", "K-slash-2", "send")
    expect(restoredEmpty.draft).toBe("/review")
    expect(restoredEmpty.pendingRetry).toEqual({
      clientRequestId: "K-slash-2",
      content: "/review",
      action: "send",
    })
    expect(restoredEmpty.pendingRestoredCommand).toBeUndefined()
  })

  test("F-4 + F-7 + F-8 + F-10: real ChatScreen action orchestrators handle post-timeout queued reconciliation, mid-dequeue disconnect/unmount/double-tap, slash non-merge, and atomic snapshot backfill", async () => {
    const draftStore = await import("./draftStore")
    const actions = await import("./chatScreenActions")
    const disk = new Map<string, string>()
    const makeBackend = () => ({
      getItemAsync: async (key: string) => disk.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => {
        disk.set(key, value)
      },
      deleteItemAsync: async (key: string) => {
        disk.delete(key)
      },
    })
    draftStore.setDraftStorageBackendForTesting(makeBackend())

    try {
      // --- 1. F-4: Post-timeout (>8s) queued message reconciliation via real performChatSendAction + applyIncomingChatSnapshot ---
      let latestSnapshot: ChatSnapshot | null = makeSnapshot()
      let knownEntries: TranscriptEntry[] = []
      let historyInitialized = false
      let historyGeneration = 0
      let pendingWindowUpdates = 0
      let windowUpdates: Promise<void> = Promise.resolve()
      let pendingSendReconciliation: import("./chatScreenActions").PendingSendReconciliation | null = null
      const committedViews: import("./chatScreenActions").CommittedChatView[] = []
      const sentCommands: ClientCommand[] = []
      let sending = false
      let reconciling = false
      let sendError: string | null = null

      const clearPending = () => {
        const cur = pendingSendReconciliation
        if (!cur) return null
        clearTimeout(cur.timer)
        pendingSendReconciliation = null
        reconciling = false
        return cur
      }

      const buildSnapshotRefs = (socket: import("./chatScreenActions").ChatCommandSocket) => ({
        chatId: "chat-1",
        socket,
        getSnapshot: () => latestSnapshot,
        setSnapshot: (v: ChatSnapshot | null) => {
          latestSnapshot = v
        },
        getKnownEntries: () => knownEntries,
        setKnownEntries: (e: TranscriptEntry[]) => {
          knownEntries = e
        },
        getHistoryInitialized: () => historyInitialized,
        setHistoryInitialized: (v: boolean) => {
          historyInitialized = v
        },
        getHistoryGeneration: () => historyGeneration,
        bumpHistoryGeneration: () => {
          historyGeneration += 1
          return historyGeneration
        },
        getPendingWindowUpdates: () => pendingWindowUpdates,
        setPendingWindowUpdates: (v: number) => {
          pendingWindowUpdates = v
        },
        getWindowUpdates: () => windowUpdates,
        setWindowUpdates: (p: Promise<void>) => {
          windowUpdates = p
        },
        getPendingSendReconciliation: () => pendingSendReconciliation,
        clearPendingSendReconciliation: clearPending,
        getDraftStateFallback: () => draftStore.getCachedDraftState("chat-1") ?? EMPTY_DRAFT_STATE,
        setChatView: (view: import("./chatScreenActions").CommittedChatView) => {
          committedViews.push(view)
        },
        setMissing: () => {},
        setOlderEntries: () => {},
        setHistoryCursor: () => {},
        setHasOlderHistory: () => {},
        setHistoryError: () => {},
      })

      const disconnectSocket: import("./chatScreenActions").ChatCommandSocket = {
        command: async (cmd) => {
          sentCommands.push(cmd)
          throw new Error("Disconnected from the MemoSync host")
        },
      }

      // Send while busy (action: "queue") -> socket drops before ack -> wait past reconcileTimeoutMs (25ms).
      await actions.performChatSendAction({
        chatId: "chat-1",
        content: "Also update README",
        active: true,
        action: "queue",
        pendingRetry: null,
        socket: disconnectSocket,
        effectivePlanMode: false,
        composerModelSelection: null,
        combinedEntries: [],
        baselineQueue: [],
        getLatestSnapshot: () => latestSnapshot,
        getKnownEntries: () => knownEntries,
        isMounted: () => true,
        clearPendingSendReconciliation: clearPending,
        setPendingSendReconciliation: (next) => {
          pendingSendReconciliation = next
        },
        getPendingSendReconciliation: () => pendingSendReconciliation,
        setSending: (v) => {
          sending = v
        },
        setReconcilingSend: (v) => {
          reconciling = v
        },
        setSendError: (v) => {
          sendError = v
        },
        reconcileTimeoutMs: 25,
        generateId: () => "K-f4-post-timeout",
        now: () => 100,
      })
      expect(sending).toBe(false)
      expect(reconciling).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 45))
      expect(reconciling).toBe(false)

      // Draft was restored with pendingRetry + error banner after timeout.
      const restoredAfterTimeout = draftStore.getCachedDraftState("chat-1")
      expect(restoredAfterTimeout?.draft).toBe("Also update README")
      expect(restoredAfterTimeout?.pendingRetry).toEqual({
        clientRequestId: "K-f4-post-timeout",
        content: "Also update README",
        action: "queue",
      })
      expect(restoredAfterTimeout?.sendError).toBe("Disconnected from the MemoSync host")

      // Mobile reconnects while host turn is still running; snapshot carries q-5 with clientRequestId="K-f4-post-timeout".
      actions.applyIncomingChatSnapshot(
        buildSnapshotRefs(disconnectSocket),
        makeSnapshot({
          queuedMessages: [
            { id: "q-5", content: "Also update README", createdAt: 105, clientRequestId: "K-f4-post-timeout" },
          ],
        }),
      )
      // Restored composer draft, retry key, and error banner MUST be cleared immediately!
      expect(draftStore.getCachedDraftState("chat-1")).toBeNull()

      // --- 2. F-7: Expired slash-command dequeue resilience (double-tap, disconnect before ack, unmount, and host-still-queued case) ---
      const expiredCmd: QueuedChatMessage = {
        id: "q-expired-1",
        rejection: "stale_native_command",
        content: "/review focus on auth token refresh race",
        createdAt: 200,
      }
      let releaseDequeue!: () => void
      const dequeueGate = new Promise<void>((resolve) => {
        releaseDequeue = resolve
      })
      let dequeueCalls = 0
      const slowDisconnectDequeueSocket: import("./chatScreenActions").ChatCommandSocket = {
        command: async (cmd) => {
          if (cmd.type === "message.dequeue") {
            dequeueCalls += 1
            await dequeueGate
            throw new Error("Disconnected from the MemoSync host")
          }
          return undefined as never
        },
      }
      const activeIds = new Set<string>()
      latestSnapshot = makeSnapshot({ queuedMessages: [expiredCmd] })

      // Double-tap "Restore": second call must be ignored while first is in flight!
      const dq1 = actions.performQueuedMessageDequeueAction({
        chatId: "chat-1",
        message: expiredCmd,
        mode: "restore_empty",
        socket: slowDisconnectDequeueSocket,
        getLatestSnapshot: () => latestSnapshot,
        isMounted: () => true,
        onDequeueStart: (id) => activeIds.add(id),
        onDequeueEnd: (id) => activeIds.delete(id),
        onError: (msg) => {
          sendError = msg
        },
      })
      const dq2 = actions.performQueuedMessageDequeueAction({
        chatId: "chat-1",
        message: expiredCmd,
        mode: "restore_empty",
        socket: slowDisconnectDequeueSocket,
        getLatestSnapshot: () => latestSnapshot,
        isMounted: () => true,
        onDequeueStart: (id) => activeIds.add(id),
        onDequeueEnd: (id) => activeIds.delete(id),
        onError: (msg) => {
          sendError = msg
        },
      })
      expect(dequeueCalls).toBe(1)
      expect(activeIds.has("q-expired-1")).toBe(true)
      expect(draftStore.getCachedDraftState("chat-1")?.pendingDequeueRestore).toEqual({
        queuedMessageId: "q-expired-1",
        content: "/review focus on auth token refresh race",
        mode: "restore_empty",
      })

      // Host deleted the row, then socket drops before ack arrives (and app even restarts!).
      releaseDequeue()
      await Promise.all([dq1, dq2])
      expect(activeIds.has("q-expired-1")).toBe(false)
      expect(sendError).toBe("Disconnected from the MemoSync host")
      await draftStore.flushAllDraftWrites()

      // Simulate cold restart / unmount before reconnect snapshot arrives.
      draftStore.setDraftStorageBackendForTesting(makeBackend())
      const reloadedDequeue = await draftStore.loadPersistedDraftState("chat-1")
      expect(reloadedDequeue?.pendingDequeueRestore).toEqual({
        queuedMessageId: "q-expired-1",
        content: "/review focus on auth token refresh race",
        mode: "restore_empty",
      })

      // Reconnect snapshot arrives with queuedMessages: [] -> host deleted row, so restore completes!
      actions.applyIncomingChatSnapshot(buildSnapshotRefs(slowDisconnectDequeueSocket), makeSnapshot({ queuedMessages: [] }))
      const afterReconnectRestore = draftStore.getCachedDraftState("chat-1")
      expect(afterReconnectRestore?.draft).toBe("/review focus on auth token refresh race")
      expect(afterReconnectRestore?.pendingDequeueRestore).toBeUndefined()
      expect(afterReconnectRestore?.sendError).toBeNull()

      // Also verify "replace" mode across disconnect when user confirmed replacing an existing draft:
      draftStore.savePersistedDraftState(
        "chat-1",
        { draft: "Old draft user agreed to replace", pendingRetry: null, sendError: null },
        { immediate: true },
      )
      const expiredReplace: QueuedChatMessage = {
        id: "q-expired-2",
        rejection: "stale_native_command",
        content: "/init",
        createdAt: 210,
      }
      latestSnapshot = makeSnapshot({ queuedMessages: [expiredReplace] })
      await actions.performQueuedMessageDequeueAction({
        chatId: "chat-1",
        message: expiredReplace,
        mode: "replace",
        socket: disconnectSocket,
        getLatestSnapshot: () => latestSnapshot,
        isMounted: () => false, // unmounted before disconnect!
      })
      actions.applyIncomingChatSnapshot(buildSnapshotRefs(disconnectSocket), makeSnapshot({ queuedMessages: [] }))
      expect(draftStore.getCachedDraftState("chat-1")?.draft).toBe("/init")
      expect(draftStore.getCachedDraftState("chat-1")?.pendingDequeueRestore).toBeUndefined()

      // And when reconnect snapshot shows the row is STILL queued on host (never deleted),
      // pendingDequeueRestore clears cleanly without clobbering the user's draft.
      draftStore.savePersistedDraftState("chat-1", { draft: "Keep me", pendingRetry: null, sendError: null }, { immediate: true })
      const stillQueuedExpired: QueuedChatMessage = {
        id: "q-expired-3",
        rejection: "stale_native_command",
        content: "/review keep",
        createdAt: 220,
      }
      const stillQueuedState = reconcilePendingDequeueRestoreAgainstSnapshot(
        {
          draft: "Keep me",
          pendingRetry: null,
          sendError: null,
          pendingDequeueRestore: { queuedMessageId: "q-expired-3", content: "/review keep", mode: "replace" },
        },
        [stillQueuedExpired],
      )
      expect(stillQueuedState.reconciled).toBe(true)
      expect(stillQueuedState.restored).toBe(false)
      expect(stillQueuedState.state.draft).toBe("Keep me")
      expect(stillQueuedState.state.pendingDequeueRestore).toBeUndefined()

      // --- 3. F-10: CommittedChatView sync fast-path vs async gap-backfill ---
      const backfillCalls: ClientCommand[] = []
      const backfillSocket: import("./chatScreenActions").ChatCommandSocket = {
        command: async (cmd) => {
          backfillCalls.push(cmd)
          return {
            messages: [
              { _id: "m1", createdAt: 1, kind: "user_prompt", content: "First" },
              { _id: "m2", createdAt: 2, kind: "assistant_text", text: "Gap bridged" },
            ],
            hasOlder: false,
            olderCursor: null,
          } as never
        },
      }
      historyInitialized = false
      knownEntries = []
      committedViews.length = 0
      const refs = buildSnapshotRefs(backfillSocket)
      actions.applyIncomingChatSnapshot(
        refs,
        makeSnapshot({
          messages: [{ _id: "m1", createdAt: 1, kind: "user_prompt", content: "First" }],
        }),
      )
      expect(committedViews).toHaveLength(1)

      // Gapped snapshot (m1 missing, m3 arrived) -> defers view commit until chat.loadHistory bridges m2!
      actions.applyIncomingChatSnapshot(
        refs,
        makeSnapshot({
          messages: [{ _id: "m3", createdAt: 3, kind: "assistant_text", text: "Latest" }],
          history: { hasOlder: true, olderCursor: "cursor-m3", recentLimit: 200 },
        }),
      )
      expect(committedViews).toHaveLength(1) // NOT split before backfill completes!
      await windowUpdates
      expect(backfillCalls).toHaveLength(1)
      expect(committedViews).toHaveLength(2)
      expect(committedViews[1]!.knownEntries.map((e) => e._id)).toEqual(["m1", "m2", "m3"])
    } finally {
      draftStore.setDraftStorageBackendForTesting()
    }
  })
})
