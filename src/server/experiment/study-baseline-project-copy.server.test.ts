import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { StudyRawTlxActivityResponse } from "../../shared/studyScales"
import { MemoryService } from "../memory"
import { createSummaryService } from "../memory/summary"
import { startMemoSyncServer } from "../server"
import { snapshotStudyWorkspace } from "../study-workspace-snapshot"
import {
  CANONICAL_FULLSTACK_STARTER_FINGERPRINT,
  STUDY_WORKSPACE_PROVENANCE_DIR,
} from "../study-workspace-provenance"
import { StudyMemoryStore } from "./study-memory-store"

const roots: string[] = []
const servers: Array<{ stop: () => Promise<void> }> = []
const ENV_KEYS = [
  "EXPERIMENT_CONDITION",
  "PARTICIPANT_ID",
  "STUDY_PROJECTS",
  "STUDY_TASK_ORDER",
  "DEEPSEEK_API_KEY",
] as const
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

function rawTlx(activity: "monitoring" | "control"): StudyRawTlxActivityResponse {
  return {
    instrument: "raw_tlx",
    instrumentVersion: 1,
    activity,
    ratings: {
      mentalDemand: 40,
      physicalDemand: 5,
      temporalDemand: 35,
      performance: 25,
      effort: 45,
      frustration: 15,
    },
  }
}

function recordCompletedSession(store: StudyMemoryStore, taskId: string, snapshotId: string): void {
  store.createFreezeSnapshot({
    taskId,
    snapshotId,
    frozenAt: "2026-08-19T08:00:00.000Z",
  })
  store.recordQuestionnaireSubmission({
    submissionId: `quiz-${taskId}`,
    snapshotId,
    submittedAt: "2026-08-19T08:01:00.000Z",
    questionnaireVersion: 2,
    answers: [],
  })
  store.recordRawTlxSubmission({
    submissionId: `monitoring-${taskId}`,
    snapshotId,
    submittedAt: "2026-08-19T08:02:00.000Z",
    response: rawTlx("monitoring"),
  })
  store.recordRawTlxSubmission({
    submissionId: `control-${taskId}`,
    completionId: `completion-${taskId}`,
    snapshotId,
    submittedAt: "2026-08-19T08:03:00.000Z",
    response: rawTlx("control"),
  })
}

async function makeStudyProject(root: string, slug: "apartment" | "car"): Promise<string> {
  const workspace = path.join(root, slug)
  await mkdir(workspace, { recursive: true })
  const provenanceDir = path.join(root, STUDY_WORKSPACE_PROVENANCE_DIR)
  await mkdir(provenanceDir, { recursive: true })
  await writeFile(path.join(provenanceDir, `${slug}.json`), `${JSON.stringify({
    schemaVersion: 1,
    kind: "memosync.fullstack-bench-starter",
    projectId: slug,
    initializedAt: "2026-08-19T07:00:00.000Z",
    starter: CANONICAL_FULLSTACK_STARTER_FINGERPRINT,
  })}\n`)
  return workspace
}

async function postRawTlx(baseUrl: string, taskId: string, snapshotId: string, activity: "monitoring" | "control") {
  return fetch(`${baseUrl}/api/study/raw-tlx`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    body: JSON.stringify({ taskId, snapshotId, response: rawTlx(activity) }),
  })
}

async function completeParticipantAdmission(baseUrl: string): Promise<void> {
  const requests: Array<{ method: "PUT" | "POST"; path: string; body: Record<string, unknown> }> = [
    {
      method: "PUT",
      path: "/api/study/onboarding/information",
      body: {
        prolificId: "project-copy-production-fixture",
        age: 30,
        gender: "Prefer not to say",
        agentMemoryExperience: "None",
        agentUseFrequency: "Never",
        agentTools: ["None"],
      },
    },
    { method: "POST", path: "/api/study/onboarding/consent", body: { consented: true } },
    { method: "POST", path: "/api/study/onboarding/briefing", body: {} },
    { method: "POST", path: "/api/study/guide-complete", body: {} },
  ]

  for (const request of requests) {
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
      },
      body: JSON.stringify(request.body),
    })
    expect(response.status, `${request.method} ${request.path}: ${await response.text()}`).toBe(200)
  }
}

async function makeWritable(target: string): Promise<void> {
  const info = await lstat(target)
  if (info.isSymbolicLink()) return
  if (!info.isDirectory()) {
    await chmod(target, 0o600)
    return
  }
  await chmod(target, 0o700)
  for (const entry of await readdir(target)) await makeWritable(path.join(target, entry))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => {})))
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) {
    try {
      await makeWritable(root)
    } catch {
      // A failed server boot may leave no immutable snapshot tree.
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe("study baseline Project Copy production composition", () => {
  test("Static Control TLX unlocks the next project only after the frozen Markdown copy is ready", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-static-copy-server-"))
    roots.push(root)
    const dataDir = path.join(root, "data")
    const apartment = await makeStudyProject(root, "apartment")
    const car = await makeStudyProject(root, "car")
    await writeFile(path.join(apartment, "MEMORY.md"), "# Memory\n- Confirm cancellation before leaving the booking page.\n")
    const workspaceSnapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: apartment,
      taskId: "038-S2",
      snapshotId: "snapshot-static-server",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    await mkdir(path.join(dataDir, "experiments"), { recursive: true })
    const setupStore = new StudyMemoryStore(path.join(dataDir, "experiments", "study.sqlite"))
    recordCompletedSession(setupStore, "038-S1", "snapshot-038-s1-complete")
    setupStore.createFreezeSnapshot({
      taskId: "038-S2",
      snapshotId: workspaceSnapshot.snapshotId,
      frozenAt: workspaceSnapshot.frozenAt,
      workspaceSnapshot,
    })
    setupStore.recordQuestionnaireSubmission({
      submissionId: "quiz-038-S2",
      snapshotId: workspaceSnapshot.snapshotId,
      submittedAt: "2026-08-19T09:01:00.000Z",
      questionnaireVersion: 2,
      answers: [],
    })
    setupStore.close()

    process.env.EXPERIMENT_CONDITION = "static"
    process.env.PARTICIPANT_ID = "QA-STATIC-PROJECT-COPY-READY"
    process.env.STUDY_TASK_ORDER = "038-S1,038-S2,098-S1,098-S2"
    process.env.STUDY_PROJECTS = JSON.stringify([
      { localPath: apartment, title: "Apartment rentals" },
      { localPath: car, title: "Car rentals" },
    ])
    const server = await startMemoSyncServer({
      dataDir,
      port: 0,
      strictPort: true,
      discoverProjects: () => [],
    })
    servers.push(server)
    const baseUrl = `http://127.0.0.1:${server.port}`
    await completeParticipantAdmission(baseUrl)

    const monitoring = await postRawTlx(baseUrl, "038-S2", workspaceSnapshot.snapshotId, "monitoring")
    expect(monitoring.status).toBe(200)
    const control = await postRawTlx(baseUrl, "038-S2", workspaceSnapshot.snapshotId, "control")
    expect(control.status).toBe(200)

    expect(await readFile(path.join(car, "MEMORY.md"), "utf8"))
      .toBe("# Memory\n- Confirm cancellation before leaving the booking page.\n")
    const evidence = new StudyMemoryStore(path.join(dataDir, "experiments", "study.sqlite"))
    expect(evidence.getBaselineProjectCopyTransition("038-S2", "098-S1")).toMatchObject({
      status: "ready",
      condition: "static",
      sourceSnapshotId: workspaceSnapshot.snapshotId,
    })
    evidence.close()
  })

  test("a failed Static destination admission returns 503 and leaves the next project locked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-static-copy-server-"))
    roots.push(root)
    const dataDir = path.join(root, "data")
    const apartment = await makeStudyProject(root, "apartment")
    const car = path.join(root, "car")
    await mkdir(car, { recursive: true })
    await writeFile(path.join(apartment, "MEMORY.md"), "# Memory\n- Source must not unlock an unready target.\n")
    const workspaceSnapshot = await snapshotStudyWorkspace({
      dataDir,
      sourceDir: apartment,
      taskId: "038-S2",
      snapshotId: "snapshot-static-unready-target",
      project: { slug: "apartment", title: "Apartment rentals" },
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    await mkdir(path.join(dataDir, "experiments"), { recursive: true })
    const setupStore = new StudyMemoryStore(path.join(dataDir, "experiments", "study.sqlite"))
    recordCompletedSession(setupStore, "038-S1", "snapshot-038-s1-complete")
    setupStore.createFreezeSnapshot({
      taskId: "038-S2",
      snapshotId: workspaceSnapshot.snapshotId,
      frozenAt: workspaceSnapshot.frozenAt,
      workspaceSnapshot,
    })
    setupStore.recordQuestionnaireSubmission({
      submissionId: "quiz-038-S2",
      snapshotId: workspaceSnapshot.snapshotId,
      submittedAt: "2026-08-19T09:01:00.000Z",
      questionnaireVersion: 2,
      answers: [],
    })
    setupStore.close()

    process.env.EXPERIMENT_CONDITION = "static"
    process.env.PARTICIPANT_ID = "QA-STATIC-PROJECT-COPY-UNREADY"
    process.env.STUDY_TASK_ORDER = "038-S1,038-S2,098-S1,098-S2"
    process.env.STUDY_PROJECTS = JSON.stringify([
      { localPath: apartment, title: "Apartment rentals" },
      { localPath: car, title: "Car rentals" },
    ])
    const server = await startMemoSyncServer({
      dataDir,
      port: 0,
      strictPort: true,
      discoverProjects: () => [],
    })
    servers.push(server)
    const baseUrl = `http://127.0.0.1:${server.port}`
    await completeParticipantAdmission(baseUrl)

    expect((await postRawTlx(baseUrl, "038-S2", workspaceSnapshot.snapshotId, "monitoring")).status).toBe(200)
    const control = await postRawTlx(baseUrl, "038-S2", workspaceSnapshot.snapshotId, "control")
    expect(control.status).toBe(503)
    expect(await control.json()).toMatchObject({
      error: { message: expect.stringMatching(/target project is not ready.*car/i) },
    })
    const progress = await fetch(`${baseUrl}/api/study/progress`, { headers: { Origin: baseUrl } })
    const progressBody = await progress.json() as {
      data: { activeTaskId: string | null; tasks: Array<{ id: string; status: string }> }
    }
    expect(progressBody.data.activeTaskId).toBe("038-S2")
    expect(progressBody.data.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "038-S2", status: "active" }),
      expect.objectContaining({ id: "098-S1", status: "locked" }),
    ]))

    const evidence = new StudyMemoryStore(path.join(dataDir, "experiments", "study.sqlite"))
    expect(evidence.getRawTlxSubmission(workspaceSnapshot.snapshotId, "control")).toBeNull()
    expect(evidence.getSessionCompletion("038-S2")).toBeNull()
    expect(evidence.getBaselineProjectCopyTransition("038-S2", "098-S1")?.status).toBe("preparing")
    evidence.close()
  })

  test("Auto Control TLX copies the complete source project block in the reverse project order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-auto-copy-server-"))
    roots.push(root)
    const dataDir = path.join(root, "data")
    const apartment = await makeStudyProject(root, "apartment")
    const car = await makeStudyProject(root, "car")
    await mkdir(path.join(dataDir, "experiments"), { recursive: true })
    const setupStore = new StudyMemoryStore(path.join(dataDir, "experiments", "study.sqlite"))
    recordCompletedSession(setupStore, "098-S1", "snapshot-098-s1-complete")
    setupStore.createFreezeSnapshot({
      taskId: "098-S2",
      snapshotId: "snapshot-auto-server",
      frozenAt: "2026-08-19T09:00:00.000Z",
    })
    setupStore.recordQuestionnaireSubmission({
      submissionId: "quiz-098-S2",
      snapshotId: "snapshot-auto-server",
      submittedAt: "2026-08-19T09:01:00.000Z",
      questionnaireVersion: 2,
      answers: [],
    })
    setupStore.close()

    process.env.EXPERIMENT_CONDITION = "auto"
    process.env.PARTICIPANT_ID = "QA-AUTO-PROJECT-COPY-READY"
    process.env.STUDY_TASK_ORDER = "098-S1,098-S2,038-S1,038-S2"
    process.env.STUDY_PROJECTS = JSON.stringify([
      { localPath: apartment, title: "Apartment rentals" },
      { localPath: car, title: "Car rentals" },
    ])
    // The production composition requires the summary service. Its source
    // projection is prepared locally below, so this key is never sent out.
    process.env.DEEPSEEK_API_KEY = "test-no-network"
    const server = await startMemoSyncServer({
      dataDir,
      port: 0,
      strictPort: true,
      discoverProjects: () => [],
    })
    servers.push(server)
    const projects = server.store.listProjects()
    const sourceProjectId = projects.find((project) => project.localPath === car)?.id
    const targetProjectId = projects.find((project) => project.localPath === apartment)?.id
    expect(sourceProjectId).toBeTruthy()
    expect(targetProjectId).toBeTruthy()

    const memory = new MemoryService({
      dbPath: path.join(dataDir, "memory.sqlite"),
      dataDir: path.join(dataDir, "test-memory-projection"),
    })
    try {
      memory.store.create({
        content: "Car checkout requires a confirmation step",
        scope: "project",
        projectId: sourceProjectId!,
        type: "constraint",
      }, { actor: "agent" })
      await createSummaryService({
        memory,
        callJson: async () => ({ summary: "## Constraints\nCar checkout requires confirmation." }),
      }).refresh(sourceProjectId!)

      const baseUrl = `http://127.0.0.1:${server.port}`
      await completeParticipantAdmission(baseUrl)
      const monitoring = await postRawTlx(baseUrl, "098-S2", "snapshot-auto-server", "monitoring")
      expect(monitoring.status).toBe(200)
      const control = await postRawTlx(baseUrl, "098-S2", "snapshot-auto-server", "control")
      expect(control.status).toBe(200)

      expect(memory.autoProjectMemories(targetProjectId!).map((item) => item.content)).toEqual([
        "Car checkout requires a confirmation step",
      ])
      const evidence = new StudyMemoryStore(path.join(dataDir, "experiments", "study.sqlite"))
      expect(evidence.getBaselineProjectCopyTransition("098-S2", "038-S1")).toMatchObject({
        status: "ready",
        condition: "auto",
        sourceSnapshotId: "snapshot-auto-server",
      })
      evidence.close()
    } finally {
      memory.close()
    }
  })
})
