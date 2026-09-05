import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStudyPromptGate } from "./study-prompt-gate"
import { createStudyOpeningAttachmentSnapshotStore } from "./study-opening-attachments"
import { StudyRegistry } from "./study-registry"
import { STUDY_BRIEFS } from "./study-briefs"
import { briefReceiptKey, guideReceiptKey } from "./study-ui-receipts"

describe("study prompt project admission", () => {
  const projects = new Map([
    ["project-apartment", { id: "project-apartment", localPath: "/workspace/apartment" }],
    ["project-car", { id: "project-car", localPath: "/workspace/car" }],
    ["project-spoof", { id: "project-spoof", localPath: "/tmp/unregistered/apartment" }],
  ])
  const chats = new Map([
    ["chat-apartment", { id: "chat-apartment", projectId: "project-apartment", createdAt: 100 }],
    ["chat-old-fork", {
      id: "chat-old-fork",
      projectId: "project-apartment",
      createdAt: 100,
      pendingForkSessionToken: "claude-session-from-s1",
    }],
    ["chat-car", { id: "chat-car", projectId: "project-car", createdAt: 100 }],
    ["chat-spoof", { id: "chat-spoof", projectId: "project-spoof", createdAt: 100 }],
  ])

  function gate(
    receipts = new Set([guideReceiptKey(), briefReceiptKey("038-S1")]),
    allowVerbatimInstruction = false,
    boardPromptRefusal?: (taskId: string) => string | null,
  ) {
    return createStudyPromptGate({
      registry: new StudyRegistry(undefined, ["038-S1"]),
      assignedProjects: new Map([["apartment", {
        projectId: "project-apartment",
        localPath: "/workspace/apartment",
        starterReady: true,
      }]]),
      store: {
        getChat: (id) => chats.get(id) ?? null,
        getProject: (id) => projects.get(id) ?? null,
      },
      onboarding: { isBriefingComplete: () => true },
      uiReceipts: { has: (key) => receipts.has(key) },
      allowVerbatimInstruction,
      boardPromptRefusal,
    })
  }

  function gateForProject(localPath: string) {
    return createStudyPromptGate({
      registry: new StudyRegistry(undefined, ["038-S1"]),
      assignedProjects: new Map([["apartment", {
        projectId: "project-apartment",
        localPath,
        starterReady: true,
      }]]),
      store: {
        getChat: (id) => id === "chat-apartment"
          ? { projectId: "project-apartment", createdAt: 100 }
          : null,
        getProject: (id) => id === "project-apartment" ? { localPath } : null,
      },
      onboarding: { isBriefingComplete: () => true },
      uiReceipts: { has: () => true },
    })
  }

  test("checks existing chats and new-chat project ids", () => {
    expect(gate()({ chatId: "chat-apartment", content: "build it" })).toBeNull()
    expect(gate()({ chatId: "chat-car", content: "build it" })).toContain("Apartment rentals")
    expect(gate()({ projectId: "project-apartment", content: "build it" })).toBeNull()
    expect(gate()({ projectId: "project-car", content: "build it" })).toContain("Apartment rentals")
  })

  test("rejects a legacy study fork before its inherited Claude session can start", () => {
    expect(gate()({ chatId: "chat-old-fork", content: "continue with S2" })).toContain("new chat")
  })

  test("fails closed when the requested project cannot be resolved", () => {
    expect(gate()({ chatId: "missing", content: "build it" })).toContain("assigned project")
    expect(gate()({ content: "build it" })).toContain("assigned project")
  })

  test("rejects a same-basename directory that is not the registered canonical project", () => {
    expect(gate()({ chatId: "chat-spoof", content: "build it" })).toContain("task brief")
  })

  test("requires the current guide and active-task brief receipts before prompt admission", () => {
    expect(gate(new Set())({ chatId: "chat-apartment", content: "build it" })).toContain("study guide")
    expect(gate(new Set([guideReceiptKey()]))({ chatId: "chat-apartment", content: "build it" })).toContain("task brief")
  })

  test("requires the durable briefing before a Guide-complete participant can send a prompt", () => {
    const promptGate = createStudyPromptGate({
      registry: new StudyRegistry(undefined, ["038-S1"]),
      assignedProjects: new Map([["apartment", {
        projectId: "project-apartment",
        localPath: "/workspace/apartment",
        starterReady: true,
      }]]),
      store: {
        getChat: (id) => chats.get(id) ?? null,
        getProject: (id) => projects.get(id) ?? null,
      },
      onboarding: { isBriefingComplete: () => false },
      uiReceipts: { has: () => true },
    })

    expect(promptGate({ chatId: "chat-apartment", content: "build it" })).toContain("briefing")
  })

  test("applies the blocking Board authority to every prompt-producing channel", () => {
    const promptGate = gate(undefined, false, () => "Review the Memory Board before sending a prompt.")

    for (const channel of ["chat.send", "message.enqueue", "message.steer", "queue.dispatch"] as const) {
      expect(promptGate({ chatId: "chat-apartment", channel, content: "build it" })).toBe(
        "Review the Memory Board before sending a prompt.",
      )
    }
  })

  test("opening preparation bypasses only the Board receipt and still rejects copied instructions", () => {
    const promptGate = gate(undefined, false, () => "Review the Memory Board before sending a prompt.")

    expect(promptGate({
      chatId: "chat-apartment",
      channel: "chat.send",
      content: "Please build a useful apartment search in my own words.",
      openingReviewId: "opening-review-1",
      openingBoardPreparation: true,
    })).toBeNull()
    expect(promptGate({
      chatId: "chat-apartment",
      channel: "chat.send",
      content: STUDY_BRIEFS["038-S1"]![1]!,
      openingReviewId: "opening-review-1",
      openingBoardPreparation: true,
    })).toContain("own words")
    expect(promptGate({
      chatId: "chat-apartment",
      channel: "chat.send",
      content: "Please follow the attached task.",
      attachments: [{
        absolutePath: "/workspace/apartment/instructions.pdf",
        mimeType: "application/pdf",
        size: 100,
      }],
      openingReviewId: "opening-review-1",
      openingBoardPreparation: true,
    })).toContain("plain-text files")
  })

  test("rejects near-verbatim instructions and records metrics without raw prompt text", () => {
    const recorded: unknown[] = []
    const promptGate = createStudyPromptGate({
      registry: new StudyRegistry(undefined, ["038-S1"]),
      assignedProjects: new Map([["apartment", {
        projectId: "project-apartment",
        localPath: "/workspace/apartment",
        starterReady: true,
      }]]),
      store: {
        getChat: (id) => chats.get(id) ?? null,
        getProject: (id) => projects.get(id) ?? null,
      },
      onboarding: { isBriefingComplete: () => true },
      uiReceipts: { has: () => true },
      recordInstructionGuardViolation: (event) => recorded.push(event),
    })
    const copied = STUDY_BRIEFS["038-S1"]![1]!

    expect(promptGate({ chatId: "chat-apartment", channel: "chat.send", content: copied })).toContain("own words")
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      taskId: "038-S1",
      chatId: "chat-apartment",
      channel: "chat.send",
      reason: "near_verbatim",
      ruleVersion: "token-lcs-v1",
    })
    expect(JSON.stringify(recorded)).not.toContain(copied)
  })

  test("lets an explicitly marked internal QA allocation send the official instruction verbatim", () => {
    const copied = STUDY_BRIEFS["038-S1"]![1]!

    expect(gate(undefined, true)({
      chatId: "chat-apartment",
      channel: "chat.send",
      content: copied,
    })).toBeNull()

    // The QA exception skips only overlap scoring. It does not bypass the
    // guide/brief receipt or project/lifecycle authority.
    expect(gate(new Set(), true)({ chatId: "chat-apartment", content: copied })).toContain("study guide")
    expect(gate(undefined, true)({ chatId: "chat-car", content: copied })).toContain("Apartment rentals")
  })

  test("allows an own-words request in the assigned project", () => {
    expect(gate()({
      chatId: "chat-apartment",
      channel: "chat.send",
      content: "Please build a useful apartment discovery UI with search and filters.",
    })).toBeNull()
  })

  test("fails closed before overlap analysis for an unreasonably large prompt", () => {
    expect(gate()({
      chatId: "chat-apartment",
      channel: "chat.send",
      content: "x".repeat(1_000_001),
    })).toContain("too long to verify")
  })

  test("also rejects copied instructions hidden in a text attachment", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-guard-attachment-"))
    const file = join(dir, "notes.txt")
    writeFileSync(file, STUDY_BRIEFS["038-S1"]![0]!)
    try {
      expect(gateForProject(dir)({
        chatId: "chat-apartment",
        channel: "chat.send",
        content: "Please read the attached task.",
        attachments: [{ absolutePath: file, mimeType: "text/plain", size: 100 }],
      })).toContain("own words")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("opening admission preserves an attachment-only prompt from the exact bytes it inspected", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-opening-admission-"))
    const project = join(dir, "project")
    const file = join(project, "notes.txt")
    const snapshots = createStudyOpeningAttachmentSnapshotStore(join(dir, "server-data", "opening-attachments"))
    mkdirSync(project, { recursive: true })
    writeFileSync(file, "original notes", { flag: "wx" })
    try {
      const promptGate = createStudyPromptGate({
        registry: new StudyRegistry(undefined, ["038-S1"]),
        assignedProjects: new Map([["apartment", {
          projectId: "project-apartment",
          localPath: project,
          starterReady: true,
        }]]),
        store: {
          getChat: () => ({ projectId: "project-apartment", createdAt: 100 }),
          getProject: () => ({ localPath: project }),
        },
        onboarding: { isBriefingComplete: () => true },
        uiReceipts: { has: () => true },
        openingAttachmentSnapshots: snapshots,
      })
      const original = {
        id: "attachment-only",
        kind: "file" as const,
        displayName: "notes.txt",
        absolutePath: file,
        relativePath: "./.memosync/uploads/notes.txt",
        contentUrl: "/api/projects/project-apartment/uploads/notes.txt/content",
        mimeType: "text/plain",
        size: 14,
      }
      const admitted = promptGate.admitOpening!({
        chatId: "chat-apartment",
        channel: "chat.send",
        content: "",
        attachments: [original],
        openingReviewId: "opening-review-attachment-only",
        openingBoardPreparation: true,
      })
      expect(admitted.refusal).toBeNull()
      expect(admitted.attachmentSnapshots).toHaveLength(1)

      writeFileSync(file, "replaced notes")
      const verified = snapshots.verify(admitted.attachmentSnapshots!)
      expect(verified.ok).toBe(true)
      if (!verified.ok) throw new Error(verified.error)
      expect(readFileSync(verified.attachments[0]!.absolutePath, "utf8")).toBe("original notes")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects every non-text study attachment with actionable copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-guard-binary-"))
    const image = join(dir, "instructions.png")
    const pdf = join(dir, "instructions.pdf")
    const disguisedText = join(dir, "instructions.txt")
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(pdf, "%PDF-1.7\n")
    writeFileSync(disguisedText, "plain bytes with a non-text declared MIME")
    try {
      for (const attachment of [
        { absolutePath: image, mimeType: "image/png" },
        { absolutePath: pdf, mimeType: "application/pdf" },
        { absolutePath: image, mimeType: "text/plain" },
        { absolutePath: pdf, mimeType: "text/plain" },
        { absolutePath: disguisedText, mimeType: "application/pdf" },
      ]) {
        expect(gateForProject(dir)({
          chatId: "chat-apartment",
          content: "Please follow this attachment.",
          attachments: [attachment],
        })).toBe("Study prompts can only include plain-text files that the instruction guard can inspect. Remove the image, PDF, archive, or other non-text attachment and try again.")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects a text attachment outside the canonical assigned project", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-guard-outside-"))
    const file = join(dir, "notes.txt")
    writeFileSync(file, "benign notes")
    try {
      expect(gate()({
        chatId: "chat-apartment",
        content: "Please read the attached notes.",
        attachments: [{ absolutePath: file, mimeType: "text/plain", size: 12 }],
      })).toContain("could not be checked")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects symlink and FIFO attachments inside the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-guard-special-"))
    const regular = join(dir, "regular.txt")
    const link = join(dir, "link.txt")
    const fifo = join(dir, "pipe.txt")
    writeFileSync(regular, "benign notes")
    symlinkSync(regular, link)
    const mkfifo = Bun.spawnSync(["mkfifo", fifo])
    expect(mkfifo.exitCode).toBe(0)
    try {
      for (const absolutePath of [link, fifo]) {
        expect(gateForProject(dir)({
          chatId: "chat-apartment",
          content: "Please inspect the attachment.",
          attachments: [{ absolutePath, mimeType: "text/plain" }],
        })).toContain("could not be checked")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("bounds attachment count, aggregate bytes, and combined text", () => {
    const dir = mkdtempSync(join(tmpdir(), "study-guard-limits-"))
    const small = join(dir, "small.txt")
    const tooMuchText = join(dir, "too-much.txt")
    const tooManyBytes = join(dir, "too-many.bin")
    writeFileSync(small, "notes")
    writeFileSync(tooMuchText, "x".repeat(1_000_001))
    writeFileSync(tooManyBytes, "")
    truncateSync(tooManyBytes, 200 * 1024 * 1024 + 1)
    try {
      const promptGate = gateForProject(dir)
      expect(promptGate({
        chatId: "chat-apartment",
        content: "Review these notes.",
        attachments: Array.from({ length: 51 }, () => ({ absolutePath: small, mimeType: "text/plain" })),
      })).toContain("could not be checked")
      expect(promptGate({
        chatId: "chat-apartment",
        content: "Review these notes.",
        attachments: [{ absolutePath: tooMuchText, mimeType: "text/plain" }],
      })).toContain("could not be checked")
      expect(promptGate({
        chatId: "chat-apartment",
        content: "Review this file.",
        attachments: [{ absolutePath: tooManyBytes, mimeType: "application/octet-stream" }],
      })).toContain("non-text attachment")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
