import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { EventStore } from "./event-store"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import { createStudyParticipantPromptReconciler } from "./study-participant-prompt-recovery"
import { StudyRegistry } from "./study-registry"
import { StudyTelemetryService } from "./study-telemetry"

test("recovers transcript-backed participant prompts after freeze and a real restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memosync-prompt-recovery-"))
  const studyDbPath = join(dataDir, "experiments", "study.sqlite")
  let studyStore: StudyMemoryStore | null = null
  try {
    const eventStore = new EventStore(dataDir)
    await eventStore.initialize()
    const apartment = await eventStore.openProject(join(dataDir, "apartment"), "Apartment")
    const carRental = await eventStore.openProject(join(dataDir, "car-rental"), "Car rental")
    const validChat = await eventStore.createChat(apartment.id)
    const wrongProjectChat = await eventStore.createChat(carRental.id)
    const forkChat = await eventStore.createChat(apartment.id)
    await eventStore.setChatProvider(validChat.id, "claude")
    await eventStore.setChatProvider(wrongProjectChat.id, "claude")
    await eventStore.setChatProvider(forkChat.id, "claude")
    await eventStore.setPendingForkSessionToken(forkChat.id, "copied-session")

    const openedAtMs = Math.max(validChat.createdAt, wrongProjectChat.createdAt, forkChat.createdAt) + 1_000
    const promptAtMs = openedAtMs + 1_000
    const frozenAtMs = openedAtMs + 10_000
    const prompt = {
      _id: "turn-valid",
      kind: "user_prompt",
      createdAt: promptAtMs,
      content: "<provider wrapper>",
      participantContent: "Please remember to use pnpm.",
      attachments: [],
      steered: true,
    } satisfies TranscriptEntry
    await eventStore.appendMessage(validChat.id, prompt)
    await eventStore.appendMessage(validChat.id, {
      _id: "turn-legacy",
      kind: "user_prompt",
      createdAt: promptAtMs + 1,
      content: "Legacy transcript text",
      attachments: [],
    })
    const attachmentOnly = {
      id: "attachment-1",
      kind: "file" as const,
      displayName: "task-note.txt",
      absolutePath: join(dataDir, "apartment", "task-note.txt"),
      relativePath: "task-note.txt",
      contentUrl: "/api/attachments/attachment-1",
      mimeType: "text/plain",
      size: 12,
    }
    await eventStore.appendMessage(validChat.id, {
      _id: "turn-attachment-only",
      kind: "user_prompt",
      createdAt: promptAtMs + 2,
      content: "",
      participantContent: "",
      attachments: [attachmentOnly],
    })
    await eventStore.appendMessage(wrongProjectChat.id, {
      _id: "turn-wrong-project",
      kind: "user_prompt",
      createdAt: promptAtMs + 3,
      content: "Do not attribute this chat.",
      attachments: [],
    })
    await eventStore.appendMessage(forkChat.id, {
      _id: "turn-fork-copy",
      kind: "user_prompt",
      // A fork copies the source entry's original timestamp, which predates
      // the fork chat. The pending token may later be cleared on provider boot.
      createdAt: forkChat.createdAt - 1,
      content: "Copied prompt, not a new participant send.",
      attachments: [],
    })
    await eventStore.setPendingForkSessionToken(forkChat.id, null)
    await eventStore.appendMessage(validChat.id, {
      _id: "turn-outside-window",
      kind: "user_prompt",
      createdAt: frozenAtMs + 1,
      content: "This timestamp is outside the task window.",
      attachments: [],
    })
    await eventStore.deleteChat(validChat.id)
    // Compaction must retain the hidden chat's authoritative lineage even
    // though ordinary UI queries continue to treat it as deleted.
    await eventStore.compact()

    studyStore = new StudyMemoryStore(studyDbPath)
    const beforeCrash = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-prompt-recovery",
      condition: "static",
      activeTask: () => ({ taskId: "038-S1", state: "open" }),
      now: () => new Date(openedAtMs).toISOString(),
    })
    beforeCrash.recordServerStageEntered("session_exposure", "038-S1")
    // Transcript append has completed, while its best-effort telemetry callback
    // has not. Freeze and process loss happen before that timer can retry.
    studyStore.createFreezeSnapshot({
      snapshotId: "freeze-after-missed-prompt",
      taskId: "038-S1",
      frozenAt: new Date(frozenAtMs).toISOString(),
    })
    studyStore.close()
    studyStore = null

    const restartedEvents = new EventStore(dataDir)
    await restartedEvents.initialize()
    expect(restartedEvents.getChat(validChat.id)).toBeNull()
    studyStore = new StudyMemoryStore(studyDbPath)
    const registry = new StudyRegistry(undefined, ["038-S1"], studyStore)
    const telemetry = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-prompt-recovery",
      condition: "static",
      activeTask: () => ({ taskId: "038-S1", state: "frozen" }),
      now: () => new Date(frozenAtMs + 60_000).toISOString(),
    })
    const reconciler = createStudyParticipantPromptReconciler({
      transcript: restartedEvents,
      registry,
      telemetry,
      assignedProjects: new Map([
        ["apartment", { projectId: apartment.id }],
        ["car", { projectId: carRental.id }],
      ]),
    })

    expect(reconciler.reconcile()).toEqual({
      scanned: 6,
      created: 3,
      existing: 0,
      skipped: 3,
    })
    expect(reconciler.reconcile()).toEqual({
      scanned: 6,
      created: 0,
      existing: 3,
      skipped: 3,
    })

    expect(studyStore.listStudyTelemetryEvents().filter((event) => event.kind === "participant_prompt")).toEqual([
      expect.objectContaining({
        eventId: `prompt:P-prompt-recovery:038-S1:${validChat.id}:turn-valid`,
        taskId: "038-S1",
        chatId: validChat.id,
        recordedAt: new Date(promptAtMs).toISOString(),
        payload: expect.objectContaining({
          content: prompt.participantContent,
          contentSource: "participant",
        }),
      }),
      expect.objectContaining({
        eventId: `prompt:P-prompt-recovery:038-S1:${validChat.id}:turn-legacy`,
        payload: expect.objectContaining({
          content: "Legacy transcript text",
          contentSource: "legacy_transcript",
        }),
      }),
      expect.objectContaining({
        eventId: `prompt:P-prompt-recovery:038-S1:${validChat.id}:turn-attachment-only`,
        payload: expect.objectContaining({
          content: "",
          contentSource: "participant",
          attachments: [attachmentOnly],
        }),
      }),
    ])
  } finally {
    studyStore?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
