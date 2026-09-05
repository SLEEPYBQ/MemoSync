import { expect, test } from "bun:test"
import { resolveConditionPolicy } from "./experiment/condition"
import { createStudyAuditAdmission, createStudyEnforceAdmission, createStudyWorkingMemoryAdmission } from "./server"
import { createStudyPromptGate } from "./study-prompt-gate"
import { StudyRegistry } from "./study-registry"

const projects = new Map([
  ["project-apartment", { localPath: "/workspace/apartment" }],
  ["project-car", { localPath: "/workspace/car" }],
])

const chats = new Map([
  ["chat-active", { projectId: "project-apartment", createdAt: 2_000, provider: "claude" as const }],
  ["chat-codex", { projectId: "project-apartment", createdAt: 2_000, provider: "codex" as const }],
  ["chat-old", { projectId: "project-apartment", createdAt: 100, provider: "claude" as const }],
  ["chat-wrong-task", { projectId: "project-car", createdAt: 2_000, provider: "claude" as const }],
])

const store = {
  getChat: (chatId: string) => chats.get(chatId) ?? null,
  getProject: (projectId: string) => projects.get(projectId) ?? null,
  getMessages: (_chatId: string) => [],
}

function studyAdmission(registry: StudyRegistry) {
  const studyPromptGate = createStudyPromptGate({
    registry,
    store,
    assignedProjects: new Map([
      ["apartment" as const, {
        projectId: "project-apartment",
        localPath: "/workspace/apartment",
        starterReady: true,
      }],
      ["car" as const, {
        projectId: "project-car",
        localPath: "/workspace/car",
        starterReady: true,
      }],
    ]),
    onboarding: { isBriefingComplete: () => true },
    uiReceipts: { has: () => true },
  })
  return createStudyEnforceAdmission({
    policy: resolveConditionPolicy("memosync"),
    store,
    studyPromptGate,
  })!
}

test("Enforce rejects a Codex chat even when its study task and session are active", () => {
  const admission = studyAdmission(new StudyRegistry(undefined, ["038-S1"]))

  expect(admission("chat-codex")).toContain("Claude")
})

test("Enforce accepts only a Claude chat in the active study task window", () => {
  const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"])
  registry.noteSessionComplete("038-S1", new Date(1_000).toISOString())
  const admission = studyAdmission(registry)

  expect(admission("chat-active")).toBeNull()
  expect(admission("chat-old")).toContain("completed session")
  expect(admission("chat-wrong-task")).toContain("Apartment rentals")
  expect(admission("missing")).toContain("active study chat")
})

test("Enforce exposes no admission callback outside the MemoSync study condition", () => {
  const studyPromptGate = createStudyPromptGate({
    registry: new StudyRegistry(undefined, ["038-S1"]),
    store,
    assignedProjects: new Map([["apartment", {
      projectId: "project-apartment",
      localPath: "/workspace/apartment",
      starterReady: true,
    }]]),
    onboarding: { isBriefingComplete: () => true },
    uiReceipts: { has: () => true },
  })

  expect(createStudyEnforceAdmission({
    policy: resolveConditionPolicy("auto"),
    store,
    studyPromptGate,
  })).toBeUndefined()
  expect(createStudyEnforceAdmission({
    policy: resolveConditionPolicy("static"),
    store,
    studyPromptGate,
  })).toBeUndefined()
  expect(createStudyEnforceAdmission({
    policy: { ...resolveConditionPolicy("memosync"), studyMode: false },
    store,
    studyPromptGate,
  })).toBeUndefined()
})

test("active Working Memory admission trusts only the server-held preview pool", () => {
  const registry = new StudyRegistry(undefined, ["038-S1"])
  const studyPromptGate = createStudyPromptGate({
    registry,
    store,
    assignedProjects: new Map([["apartment", {
      projectId: "project-apartment",
      localPath: "/workspace/apartment",
      starterReady: true,
    }]]),
    onboarding: { isBriefingComplete: () => true },
    uiReceipts: { has: () => true },
  })
  const admission = createStudyWorkingMemoryAdmission({
    policy: resolveConditionPolicy("memosync"),
    store,
    studyPromptGate,
    getPendingPreview: () => ({ previewId: "preview-1", published: true, memoryIds: ["M-01"] }),
  })!

  expect(admission({ chatId: "chat-active", previewId: "preview-1", memoryId: "M-01" })).toBeNull()
  expect(admission({ chatId: "chat-active", previewId: "preview-1", memoryId: "M-global" })).toContain("current Working Memory pool")
})

test("Audit admission binds both chat and memory to the active task Visible Memory Pool", () => {
  const registry = new StudyRegistry(undefined, ["038-S1"])
  const studyPromptGate = createStudyPromptGate({
    registry,
    store,
    assignedProjects: new Map([["apartment", {
      projectId: "project-apartment",
      localPath: "/workspace/apartment",
      starterReady: true,
    }]]),
    onboarding: { isBriefingComplete: () => true },
    uiReceipts: { has: () => true },
  })
  const admission = createStudyAuditAdmission({
    policy: resolveConditionPolicy("memosync"),
    store,
    studyPromptGate,
    isMemoryVisible: (chatId, memoryId) => chatId === "chat-active" && memoryId === "M-visible",
  })!

  expect(admission({ chatId: "chat-active", memoryId: "M-visible" })).toBeNull()
  expect(admission({ chatId: "chat-active", memoryId: "M-global" })).toContain("Visible Memory Pool")
  expect(admission({ chatId: "chat-wrong-task", memoryId: "M-visible" })).toContain("Apartment rentals")
  expect(admission({ chatId: "chat-codex", memoryId: "M-visible" })).toContain("Claude")
})
