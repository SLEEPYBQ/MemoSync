import { afterEach,beforeEach,describe,expect,it } from "bun:test";
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventStore } from "./event-store";
import { handleProjectFileContent } from "./server";

let dir: string

const store = {
  getProject: (id: string) => (id === "p-1" ? { id: "p-1", title: "T", localPath: dir } : undefined),
} as unknown as EventStore

function call(relPath: string, init?: RequestInit): Promise<Response | null> {
  const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content`
  const req = new Request(url, init)
  return handleProjectFileContent(req, new URL(req.url), store)
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
