import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleProjectFileContent } from "./server"
import type { EventStore } from "./event-store"

let dir: string

const store = {
  getProject: (id: string) => (id === "p-1" ? { id: "p-1", title: "T", localPath: dir } : undefined),
} as unknown as EventStore

function call(relPath: string, init?: RequestInit): Promise<Response | null> {
  const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
  const req = new Request(url, init)
  return handleProjectFileContent(req, new URL(req.url), store)
}

function blockedCall(relPath: string, init?: RequestInit): Promise<Response | null> {
  const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
  const req = new Request(url, init)
  return handleProjectFileContent(req, new URL(req.url), store, {
    beginStudyMemoryMutation: () => null,
  })
}

describe("project file content route", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memv2-content-"))
    writeFileSync(join(dir, "hello.ts"), "export const x = 1\n")
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "app.tsx"), "<App />\n")
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.EXPERIMENT_CONDITION
  })

  it("GET returns the file body", async () => {
    const res = await call("hello.ts")
    expect(res!.status).toBe(200)
    expect(await res!.text()).toBe("export const x = 1\n")
  })

  it("PUT overwrites an existing file", async () => {
    const res = await call("src/app.tsx", { method: "PUT", body: "<Other />\n" })
    expect(res!.status).toBe(200)
    const { data } = await res!.json()
    expect(data.saved).toBe(true)
    expect(readFileSync(join(dir, "src", "app.tsx"), "utf8")).toBe("<Other />\n")
  })

  it("PUT preserves non-ASCII content byte-for-byte", async () => {
    const body = "// 中文注释 ✓\nconst s = \"emoji 🎉\"\n"
    const res = await call("hello.ts", { method: "PUT", body })
    expect(res!.status).toBe(200)
    expect(readFileSync(join(dir, "hello.ts"), "utf8")).toBe(body)
  })

  it("logs a participant edit to an injected Static memory Markdown file", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    mkdirSync(join(dir, "memory"))
    writeFileSync(join(dir, "memory", "preferences.md"), "- use npm\n")
    const events: unknown[] = []
    const relPath = "memory/preferences.md"
    const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
    const req = new Request(url, {
      method: "PUT",
      headers: {
        "x-memosync-session-id": "chat-1",
        "x-memosync-edit-duration-ms": "2400",
        "x-memosync-event-id": "control:static-edit:file-success",
      },
      body: "- use bun\n",
    })

    const res = await handleProjectFileContent(req, new URL(req.url), store, {
      experimentLogger: { event: (event) => { events.push(event); return { durableCreated: true } } },
      getActiveStudyTaskId: () => "038-S1",
    })

    expect(res!.status).toBe(200)
    expect(events).toEqual([
      expect.objectContaining({
        type: "study.control_operation",
        operationId: "control:static-edit:file-success",
        taskId: "038-S1",
        chatId: "chat-1",
        surface: "static_memory",
        action: "edit",
        controlType: "static_edit",
        phase: "attempted",
        payload: { projectId: "p-1", path: "memory/preferences.md", durationMs: 2_400 },
      }),
      expect.objectContaining({ phase: "completed" }),
    ])
  })

  it("logs a participant edit to nested memory Markdown using the shared Static path contract", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    mkdirSync(join(dir, "memory", "team"), { recursive: true })
    writeFileSync(join(dir, "memory", "team", "preferences.md"), "- use npm\n")
    const events: unknown[] = []
    const relPath = "memory/team/preferences.md"
    const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
    const req = new Request(url, {
      method: "PUT",
      headers: {
        "x-memosync-event-id": "control:static-edit:nested",
        "x-memosync-session-id": "chat-1",
      },
      body: "- use bun\n",
    })

    const res = await handleProjectFileContent(req, new URL(req.url), store, {
      experimentLogger: { event: (event) => { events.push(event); return { durableCreated: true } } },
      getActiveStudyTaskId: () => "038-S1",
    })

    expect(res!.status).toBe(200)
    expect(events).toEqual([
      expect.objectContaining({
        type: "study.control_operation",
        operationId: "control:static-edit:nested",
        phase: "attempted",
        payload: expect.objectContaining({ path: relPath }),
      }),
      expect.objectContaining({ phase: "completed" }),
    ])
  })

  it("rejects an unnormalized Static memory save instead of recording its normalized target", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    mkdirSync(join(dir, "memory"))
    const target = join(dir, "memory", "preferences.md")
    writeFileSync(target, "- use npm\n")
    const events: unknown[] = []
    const relPath = "memory/team/../preferences.md"
    const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
    const req = new Request(url, {
      method: "PUT",
      headers: { "x-memosync-event-id": "control:static-edit:traversal" },
      body: "- use bun\n",
    })

    const res = await handleProjectFileContent(req, new URL(req.url), store, {
      experimentLogger: { event: (event) => { events.push(event); return { durableCreated: true } } },
      getActiveStudyTaskId: () => "038-S1",
    })

    expect(res!.status).toBe(400)
    expect(events).toEqual([])
    expect(readFileSync(target, "utf8")).toBe("- use npm\n")
  })

  it("does not write Static Markdown when durable edit telemetry fails", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    mkdirSync(join(dir, "memory"))
    const filePath = join(dir, "memory", "preferences.md")
    writeFileSync(filePath, "- use npm\n")
    const relPath = "memory/preferences.md"
    const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
    const req = new Request(url, {
      method: "PUT",
      headers: { "x-memosync-event-id": "control:static-edit:fail" },
      body: "- use bun\n",
    })

    const response = await handleProjectFileContent(req, new URL(req.url), store, {
      experimentLogger: { event: () => { throw new Error("study.sqlite unavailable") } },
      getActiveStudyTaskId: () => "038-S1",
    })
    expect(response!.status).toBe(500)
    expect(readFileSync(filePath, "utf8")).toBe("- use npm\n")
  })

  it("does not count an ordinary project-file save as Static memory control", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    const events: unknown[] = []
    const url = "http://localhost/api/projects/p-1/files/hello.ts/content"
    const req = new Request(url, {
      method: "PUT",
      headers: {
        "x-memosync-session-id": "chat-1",
        "x-memosync-edit-duration-ms": "800",
      },
      body: "export const x = 2\n",
    })

    const res = await handleProjectFileContent(req, new URL(req.url), store, {
      experimentLogger: { event: (event) => void events.push(event) },
    })

    expect(res!.status).toBe(200)
    expect(events).toEqual([])
  })

  it("PUT cannot bypass an active study freeze through the Files editor", async () => {
    const before = readFileSync(join(dir, "hello.ts"), "utf8")
    const res = await blockedCall("hello.ts", { method: "PUT", body: "changed during freeze" })

    expect(res!.status).toBe(409)
    expect(readFileSync(join(dir, "hello.ts"), "utf8")).toBe(before)
  })

  it("allows wrong-project inspection but rejects wrong-project file saves in study mode", async () => {
    const access = { projectRefusal: () => "Use the assigned apartment project." }
    const url = "http://localhost/api/projects/p-1/files/hello.ts/content"
    const readRequest = new Request(url)
    const read = await handleProjectFileContent(readRequest, new URL(readRequest.url), store, {
      studyProjectAccess: access,
    })
    const writeRequest = new Request(url, { method: "PUT", body: "changed" })
    const write = await handleProjectFileContent(writeRequest, new URL(writeRequest.url), store, {
      studyProjectAccess: access,
    })

    expect(read!.status).toBe(200)
    expect(write!.status).toBe(409)
    expect(await write!.json()).toEqual({
      error: { code: "STUDY_PROJECT_LOCKED", message: "Use the assigned apartment project." },
    })
    expect(readFileSync(join(dir, "hello.ts"), "utf8")).toBe("export const x = 1\n")
  })

  it("PUT rejects files that do not exist (no create)", async () => {
    const res = await call("new-file.ts", { method: "PUT", body: "x" })
    expect(res!.status).toBe(404)
  })

  it("PUT rejects paths escaping the project root", async () => {
    const res = await call("../outside.ts", { method: "PUT", body: "x" })
    expect([400, 404]).toContain(res!.status)
  })

  it("rejects other methods", async () => {
    const res = await call("hello.ts", { method: "DELETE" })
    expect(res!.status).toBe(405)
    expect(res!.headers.get("Allow")).toBe("GET, PUT")
  })
})
