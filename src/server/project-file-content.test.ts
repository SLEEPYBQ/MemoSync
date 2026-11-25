import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventStore } from "./event-store";
import { handleProjectFileContent } from "./server";

let dir: string

const store = {
  getProject: (id: string) => (id === "p-1" ? { id: "p-1", title: "T", localPath: dir } : undefined),
} as unknown as EventStore

function call(relPath: string, init?: RequestInit, editor = false): Promise<Response | null> {
  const url = `http://localhost/api/projects/p-1/files/${encodeURIComponent(relPath)}/content${editor ? "?editor=1" : ""}`
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
    expect(res!.headers.get("etag")).toBeNull()
    expect(res!.body).not.toBeNull()
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

  it("compares exact bytes despite equal size and mtime, then supports successive saves", async () => {
    const file = join(dir, "hello.ts")
    const fixedTime = new Date("2024-01-01T00:00:00.000Z")
    utimesSync(file, fixedTime, fixedTime)
    const first = await call("hello.ts", undefined, true)
    const original = await first!.text()
    const initialTag = first!.headers.get("etag")!
    expect(initialTag).toBe(`"${createHash("sha256").update(original).digest("hex")}"`)
    const before = statSync(file)
    const external = original.replace("1", "2")
    expect(Buffer.byteLength(external)).toBe(Buffer.byteLength(original))
    writeFileSync(file, external)
    utimesSync(file, before.atime, before.mtime)
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs)
    const conflict = await call("hello.ts", { method: "PUT", headers: { "If-Match": initialTag }, body: "my edits" }, true)
    expect(conflict!.status).toBe(412)
    expect(readFileSync(file, "utf8")).toBe(external)
    const reloaded = await call("hello.ts", undefined, true)
    const updatedTag = reloaded!.headers.get("etag")!
    expect(updatedTag).not.toBe(initialTag)
    expect(await reloaded!.text()).toBe(external)
    const saved = await call("hello.ts", { method: "PUT", headers: { "If-Match": updatedTag }, body: "my edits" }, true)
    expect(saved!.status).toBe(200)
    const savedTag = saved!.headers.get("etag")!
    expect(savedTag).toBe(`"${createHash("sha256").update("my edits").digest("hex")}"`)
    const savedAgain = await call("hello.ts", { method: "PUT", headers: { "If-Match": savedTag }, body: "more edits" }, true)
    expect(savedAgain!.status).toBe(200)
    expect(readFileSync(file, "utf8")).toBe("more edits")
  })

  it("requires a revision for editor PUTs and rejects stale concurrent writers", async () => {
    const missing = await call("hello.ts", { method: "PUT", body: "unconditional" }, true)
    expect(missing!.status).toBe(428)
    const read = await call("hello.ts", undefined, true)
    const tag = read!.headers.get("etag")!
    const [one, two] = await Promise.all([
      call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body: "first" }, true),
      call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body: "second" }, true),
    ])
    expect([one!.status, two!.status].sort()).toEqual([200, 412])
    const final = await call("hello.ts", undefined, true)
    expect(final!.headers.get("etag")).toBe((one!.status === 200 ? one : two)!.headers.get("etag"))
    expect(["first", "second"]).toContain(await final!.text())
  })

  it("truncates the old trailing bytes when editor content shrinks", async () => {
    const read = await call("hello.ts", undefined, true)
    const tag = read!.headers.get("etag")!
    const saved = await call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body: "x" }, true)
    expect(saved!.status).toBe(200)
    expect(readFileSync(join(dir, "hello.ts"), "utf8")).toBe("x")
    expect(saved!.headers.get("etag")).toBe(`"${createHash("sha256").update("x").digest("hex")}"`)
  })

  it("serializes concurrent editor saves through two hard links to the same file", async () => {
    const names = ["hello.ts", "alias.ts"]
    writeFileSync(join(dir, names[0]), "synthetic line\n".repeat(65_536))
    linkSync(join(dir, names[0]), join(dir, names[1]))
    const reads = await Promise.all(names.map(name => call(name, undefined, true)))
    const tags = reads.map(res => res!.headers.get("etag")!)
    expect(tags[0]).toBe(tags[1])
    const writes = await Promise.all(names.map((name, i) =>
      call(name, { method: "PUT", headers: { "If-Match": tags[i] }, body: `edit via ${name}` }, true)))
    expect(writes.map(res => res!.status).sort()).toEqual([200, 412])
    const winner = names[writes.findIndex(res => res!.status === 200)]
    for (const name of names) expect(readFileSync(join(dir, name), "utf8")).toBe(`edit via ${winner}`)
  })

  it("reports an oversized external edit as a conflict", async () => {
    const read = await call("hello.ts", undefined, true)
    const tag = read!.headers.get("etag")!
    const large = Buffer.alloc(10 * 1024 * 1024 + 1, 120)
    writeFileSync(join(dir, "hello.ts"), large)
    const saved = await call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body: "small" }, true)
    expect(saved!.status).toBe(412)
    expect(readFileSync(join(dir, "hello.ts"))).toEqual(large)
  })

  it("does not recreate a deleted file or overwrite a replacement", async () => {
    const read = await call("hello.ts", undefined, true)
    const tag = read!.headers.get("etag")!
    const file = join(dir, "hello.ts")
    unlinkSync(file)
    const missing = await call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body: "edit" }, true)
    expect(missing!.status).toBe(404)
    writeFileSync(file, "replacement")
    const replaced = await call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body: "edit" }, true)
    expect(replaced!.status).toBe(412)
    expect(readFileSync(file, "utf8")).toBe("replacement")
  })

  it("rechecks the file after awaiting the request body", async () => {
    const read = await call("hello.ts", undefined, true)
    const tag = read!.headers.get("etag")!
    let release!: () => void
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        started()
        return new Promise<void>(resolve => {
          release = () => {
            controller.enqueue(new TextEncoder().encode("my edits"))
            controller.close()
            resolve()
          }
        })
      },
    }, { highWaterMark: 0 })
    const pending = call("hello.ts", { method: "PUT", headers: { "If-Match": tag }, body }, true)
    await reading
    const file = join(dir, "hello.ts")
    unlinkSync(file)
    writeFileSync(file, "replacement")
    release()
    const result = await pending
    expect([404, 412]).toContain(result!.status)
    expect(readFileSync(file, "utf8")).toBe("replacement")
  })

  it("bounds editor snapshots while leaving ordinary GET streaming", async () => {
    writeFileSync(join(dir, "large.txt"), Buffer.alloc(10 * 1024 * 1024 + 1, 97))
    const editor = await call("large.txt", undefined, true)
    expect(editor!.status).toBe(413)
    const ordinary = await call("large.txt")
    expect(ordinary!.status).toBe(200)
    expect(ordinary!.headers.get("etag")).toBeNull()
    expect(ordinary!.body).not.toBeNull()
  })
})
