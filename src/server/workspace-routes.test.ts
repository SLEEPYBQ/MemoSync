import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleWorkspaceRequest } from "./workspace-routes"

let dir: string
let outsideDir: string

const store = {
  listProjects: () => [
    { id: "p-1", title: "MemoSync", localPath: dir, createdAt: 0, updatedAt: 0 },
    { id: "p-2", title: "Kanna", localPath: "/nowhere", createdAt: 0, updatedAt: 0 },
  ],
  listChats: () => [
    { id: "c-1", title: "访问百桥", projectId: "p-1" },
    { id: "c-2", title: "Fix tests", projectId: "p-2" },
  ],
  getProject: (id: string) => store.listProjects().find((p) => p.id === id),
}

function call(path: string, method = "GET"): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, { method })
  return handleWorkspaceRequest(req, new URL(req.url), store)
}

describe("workspace routes", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memv2-ws-"))
    outsideDir = mkdtempSync(join(tmpdir(), "memv2-outside-"))
    writeFileSync(join(dir, "README.md"), "# hi")
    writeFileSync(join(dir, "notes.pdf"), "%PDF-fake")
    mkdirSync(join(dir, "docs"))
    writeFileSync(join(dir, "docs", "PLAN.md"), "plan")
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it("returns null for unrelated paths", async () => {
    expect(await call("/api/memories")).toBeNull()
    expect(await call("/health")).toBeNull()
  })

  it("lists projects as id+title", async () => {
    const res = await call("/api/projects")
    expect(res!.status).toBe(200)
    const { data } = await res!.json()
    expect(data).toEqual([
      { id: "p-1", title: "MemoSync" },
      { id: "p-2", title: "Kanna" },
    ])
  })

  it("lists chats as id+title+projectId", async () => {
    const { data } = await (await call("/api/chats"))!.json()
    expect(data).toEqual([
      { id: "c-1", title: "访问百桥", projectId: "p-1" },
      { id: "c-2", title: "Fix tests", projectId: "p-2" },
    ])
  })

  it("lists project files, directories first", async () => {
    const res = await call("/api/projects/p-1/files")
    expect(res!.status).toBe(200)
    const { data } = await res!.json()
    expect(data.dir).toBe("")
    // localeCompare ordering: case-insensitive alphabetical, like Finder.
    expect(data.entries.map((e: any) => `${e.kind}:${e.name}`)).toEqual([
      "dir:docs",
      "file:notes.pdf",
      "file:README.md",
    ])
    const readme = data.entries.find((e: any) => e.name === "README.md")
    expect(readme.size).toBeGreaterThan(0)
  })

  it("navigates into a subdirectory via ?dir=", async () => {
    const { data } = await (await call("/api/projects/p-1/files?dir=docs"))!.json()
    expect(data.dir).toBe("docs")
    expect(data.entries.map((e: any) => e.name)).toEqual(["PLAN.md"])
  })

  it("rejects path traversal", async () => {
    const res = await call("/api/projects/p-1/files?dir=../../etc")
    expect(res!.status).toBe(400)
  })

  it("rejects a directory symlink that resolves outside the project", async () => {
    writeFileSync(join(outsideDir, "secret.txt"), "outside")
    symlinkSync(outsideDir, join(dir, "linked-outside"))

    const res = await call("/api/projects/p-1/files?dir=linked-outside")

    expect(res!.status).toBe(400)
  })

  it("404s an unknown project and a missing directory", async () => {
    expect((await call("/api/projects/p-404/files"))!.status).toBe(404)
    expect((await call("/api/projects/p-1/files?dir=ghost"))!.status).toBe(404)
  })

  it("rejects non-GET methods on matched paths", async () => {
    expect((await call("/api/projects", "POST"))!.status).toBe(405)
  })

  describe("recursive file index", () => {
    it("lists files recursively with posix-relative paths", async () => {
      const res = await call("/api/projects/p-1/files/index")
      expect(res!.status).toBe(200)
      const { data } = await res!.json()
      expect(data.truncated).toBe(false)
      // localeCompare ordering (case-insensitive), matching the dir listing.
      expect(data.files).toEqual(["docs/PLAN.md", "notes.pdf", "README.md"])
    })

    it("skips ignored directories like node_modules and .git", async () => {
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x")
      mkdirSync(join(dir, ".git"))
      writeFileSync(join(dir, ".git", "HEAD"), "ref")

      const { data } = await (await call("/api/projects/p-1/files/index"))!.json()
      expect(data.files).toEqual(["docs/PLAN.md", "notes.pdf", "README.md"])
    })

    it("404s an unknown project", async () => {
      expect((await call("/api/projects/p-404/files/index"))!.status).toBe(404)
    })
  })

  describe("content search", () => {
    it("finds case-insensitive matches with line numbers", async () => {
      writeFileSync(join(dir, "docs", "guide.md"), "Alpha\nthe QUICK brown fox\nomega")
      const res = await call("/api/projects/p-1/files/search?q=quick")
      expect(res!.status).toBe(200)
      const { data } = await res!.json()
      expect(data.truncated).toBe(false)
      expect(data.results).toEqual([
        { path: "docs/guide.md", line: 2, text: "the QUICK brown fox", col: 4 },
      ])
    })

    it("rejects queries shorter than 2 chars", async () => {
      expect((await call("/api/projects/p-1/files/search?q=a"))!.status).toBe(400)
    })

    it("skips binary files", async () => {
      // "zzqq" surrounded by a NUL byte → binary sniff must exclude the file.
      writeFileSync(join(dir, "blob.bin"), Buffer.from("zzqq\0zzqq", "latin1"))
      const { data } = await (await call("/api/projects/p-1/files/search?q=zzqq"))!.json()
      expect(data.results).toEqual([])
    })
  })

  describe("file ops", () => {
    function op(body: unknown): Promise<Response | null> {
      const req = new Request("http://localhost/api/projects/p-1/files/op", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      return handleWorkspaceRequest(req, new URL(req.url), store)
    }

    it("creates a file, auto-creating parent dirs", async () => {
      const res = await op({ op: "create", path: "a/b/new.ts" })
      expect(res!.status).toBe(200)
      expect(existsSync(join(dir, "a", "b", "new.ts"))).toBe(true)
    })

    it("409s creating an existing file", async () => {
      expect((await op({ op: "create", path: "README.md" }))!.status).toBe(409)
    })

    it("creates a directory", async () => {
      const res = await op({ op: "mkdir", path: "newdir" })
      expect(res!.status).toBe(200)
      expect(existsSync(join(dir, "newdir"))).toBe(true)
    })

    it("renames a file and a directory", async () => {
      expect((await op({ op: "rename", path: "README.md", toPath: "README2.md" }))!.status).toBe(200)
      expect(existsSync(join(dir, "README2.md"))).toBe(true)
      expect(existsSync(join(dir, "README.md"))).toBe(false)

      expect((await op({ op: "rename", path: "docs", toPath: "guides" }))!.status).toBe(200)
      expect(existsSync(join(dir, "guides", "PLAN.md"))).toBe(true)
    })

    it("409s renaming onto an existing target and 404s a missing source", async () => {
      expect((await op({ op: "rename", path: "README.md", toPath: "notes.pdf" }))!.status).toBe(409)
      expect((await op({ op: "rename", path: "ghost.md", toPath: "x.md" }))!.status).toBe(404)
    })

    it("deletes files and directories recursively", async () => {
      expect((await op({ op: "delete", path: "README.md" }))!.status).toBe(200)
      expect(existsSync(join(dir, "README.md"))).toBe(false)
      expect((await op({ op: "delete", path: "docs" }))!.status).toBe(200)
      expect(existsSync(join(dir, "docs"))).toBe(false)
    })

    it("rejects escapes and bad input", async () => {
      expect((await op({ op: "create", path: "../evil.ts" }))!.status).toBe(400)
      expect((await op({ op: "rename", path: "README.md", toPath: "../../evil.md" }))!.status).toBe(400)
      expect((await op({ op: "explode", path: "x" }))!.status).toBe(400)
      expect((await op({ op: "delete" }))!.status).toBe(400)
    })

    it("405s GET on the op route", async () => {
      expect((await call("/api/projects/p-1/files/op"))!.status).toBe(405)
    })

    it("keeps wrong-project reads available but rejects wrong-project writes in study mode", async () => {
      const access = { projectRefusal: () => "Use the assigned apartment project." }
      const readRequest = new Request("http://localhost/api/projects/p-1/files")
      const read = await handleWorkspaceRequest(readRequest, new URL(readRequest.url), store, {
        studyProjectAccess: access,
      })
      const writeRequest = new Request("http://localhost/api/projects/p-1/files/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "delete", path: "README.md" }),
      })
      const write = await handleWorkspaceRequest(writeRequest, new URL(writeRequest.url), store, {
        studyProjectAccess: access,
      })

      expect(read!.status).toBe(200)
      expect(write!.status).toBe(409)
      expect(await write!.json()).toEqual({
        error: { code: "STUDY_PROJECT_LOCKED", message: "Use the assigned apartment project." },
      })
      expect(existsSync(join(dir, "README.md"))).toBe(true)
    })
  })
})

describe("static-arm memory file (baseline B2)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memv2-ws-memfile-"))
    outsideDir = mkdtempSync(join(tmpdir(), "memv2-outside-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    delete process.env.EXPERIMENT_CONDITION
  })

  const memCall = (
    method: string,
    body?: unknown,
    options?: Parameters<typeof handleWorkspaceRequest>[3],
  ) => {
    const req = new Request("http://localhost/api/projects/p-1/memory-file", {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return handleWorkspaceRequest(req, new URL(req.url), store, options)
  }

  it("is exclusive to the static condition (404 elsewhere)", async () => {
    process.env.EXPERIMENT_CONDITION = "memosync"
    expect((await memCall("GET"))!.status).toBe(404)
  })

  it("static condition: round-trips content with an mtime CAS that rejects a raced save", async () => {
    process.env.EXPERIMENT_CONDITION = "static"

    // Missing file reads as empty, exists:false.
    const empty = (await (await memCall("GET"))!.json()) as { data: { content: string; exists: boolean } }
    expect(empty.data.exists).toBe(false)
    expect(empty.data.content).toBe("")

    // First save (no base token) creates the file.
    const put = (await (await memCall("PUT", { content: "# Memory\n\n- prefers bun\n" }))!.json()) as {
      data: { mtimeMs: number }
    }
    expect(put.data.mtimeMs).toBeGreaterThan(0)

    const got = (await (await memCall("GET"))!.json()) as { data: { content: string; mtimeMs: number; exists: boolean } }
    expect(got.data.exists).toBe(true)
    expect(got.data.content).toContain("prefers bun")

    // The agent writes the file directly (its normal file tools)…
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- prefers bun\n- deploys via staging\n")
    // Same-tick writes can share an mtime — force the clock forward the way a
    // real seconds-later agent edit would land.
    const { utimesSync } = await import("node:fs")
    utimesSync(join(dir, "MEMORY.md"), new Date(), new Date(Date.now() + 2000))
    // …so a save based on the OLD mtime must 409 instead of clobbering.
    const raced = await memCall("PUT", { content: "user version", baseMtimeMs: got.data.mtimeMs })
    expect(raced!.status).toBe(409)
    const after = (await (await memCall("GET"))!.json()) as { data: { content: string } }
    expect(after.data.content).toContain("staging")
  })

  it("logs one participant direct edit with its edit duration after a changed Static save", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    const events: unknown[] = []

    const response = await memCall("PUT", {
      content: "# Memory\n\n- prefers bun\n",
      sessionId: "c-1",
      editDurationMs: 1_250,
      eventId: "control:static-edit:success",
    }, {
      experimentLogger: { event: (event) => { events.push(event); return { durableCreated: true } } },
      getActiveStudyTaskId: () => "038-S1",
    })

    expect(response!.status).toBe(200)
    expect(events).toEqual([
      expect.objectContaining({
        type: "study.control_operation",
        operationId: "control:static-edit:success",
        taskId: "038-S1",
        chatId: "c-1",
        surface: "static_memory",
        action: "edit",
        controlType: "static_edit",
        phase: "attempted",
        payload: { projectId: "p-1", path: "MEMORY.md", durationMs: 1_250 },
      }),
      expect.objectContaining({ phase: "completed" }),
    ])
  })

  it("leaves Static memory untouched when durable edit telemetry fails", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    const response = await memCall("PUT", {
      content: "# Memory\n\n- prefers bun\n",
      sessionId: "c-1",
      editDurationMs: 1_250,
      eventId: "control:static-edit:fail",
    }, {
      experimentLogger: { event: () => { throw new Error("study.sqlite unavailable") } },
      getActiveStudyTaskId: () => "038-S1",
    })

    expect(response!.status).toBe(500)
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false)
  })

  it("records a failed Static edit, never completed, when the file write fails", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    mkdirSync(join(dir, "MEMORY.md"))
    const events: Array<Record<string, unknown>> = []

    const response = await memCall("PUT", {
      content: "# Memory\n\n- prefers bun\n",
      sessionId: "c-1",
      editDurationMs: 1_250,
      eventId: "control:static-edit:write-failure",
    }, {
      experimentLogger: {
        event: (event) => {
          events.push(event as Record<string, unknown>)
          return { durableCreated: true }
        },
      },
      getActiveStudyTaskId: () => "038-S1",
    })

    expect(response!.status).toBe(500)
    expect(events.map((event) => event.phase)).toEqual(["attempted", "failed"])
  })

  it("does not count a Static save when the participant leaves the Markdown unchanged", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\n- prefers bun\n")
    const events: unknown[] = []

    const response = await memCall("PUT", {
      content: "# Memory\n\n- prefers bun\n",
      sessionId: "c-1",
      editDurationMs: 900,
    }, {
      experimentLogger: { event: (event) => void events.push(event) },
    })

    expect(response!.status).toBe(200)
    expect(events).toEqual([])
  })

  it("rejects a Static memory save after freeze admission", async () => {
    process.env.EXPERIMENT_CONDITION = "static"

    const response = await memCall("PUT", { content: "must not be saved" }, {
      beginStudyMemoryMutation: () => null,
    })

    expect(response!.status).toBe(409)
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false)
  })

  it("rejects a Static memory save to the wrong project while keeping its read available", async () => {
    process.env.EXPERIMENT_CONDITION = "static"
    const access = { projectRefusal: () => "Use the assigned apartment project." }

    expect((await memCall("GET", undefined, { studyProjectAccess: access }))!.status).toBe(200)
    const response = await memCall("PUT", { content: "# wrong project\n" }, {
      studyProjectAccess: access,
    })

    expect(response!.status).toBe(409)
    expect(await response!.json()).toEqual({
      error: { code: "STUDY_PROJECT_LOCKED", message: "Use the assigned apartment project." },
    })
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false)
  })
})
