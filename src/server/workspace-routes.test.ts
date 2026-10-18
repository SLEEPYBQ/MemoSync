import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkspaceRequest } from "./workspace-routes";

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

describe("retired memory-file endpoint", () => {
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

  it("returns 404 for retired GET and PUT endpoints", async () => {
    process.env.EXPERIMENT_CONDITION = "memosync"
    expect((await memCall("GET"))!.status).toBe(404)
    expect((await memCall("PUT", { content: "unavailable" }))!.status).toBe(404)
  })
})
