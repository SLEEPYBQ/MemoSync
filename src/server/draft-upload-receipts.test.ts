import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { getProjectUploadDir } from "./paths"
import { DraftUploadReceipts, persistProjectUpload, type DraftUploadWrite } from "./uploads"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "memosync-draft-receipt-")))
  dirs.push(dir)
  const receipts = new DraftUploadReceipts(), draftWrites: DraftUploadWrite[] = []
  const fileName = "sample.bin", physicalPath = path.join(getProjectUploadDir(dir), fileName)
  const bytes = Buffer.alloc(256 * 1024 + 3, 0x61)
  bytes[bytes.length - 1] = 0xfe
  return {
    physicalPath, bytes, draftWrites,
    persist: () => persistProjectUpload({
      projectId: "draft", localPath: dir, fileName, bytes, tracking: { receipts, draftWrites },
    }),
    abandon: () => {
      const ticket = receipts.publish(draftWrites[0]!)
      return receipts.discard(receipts.take("draft", fileName, ticket)!)
    },
  }
}

test("a receipt for unchanged binary contents removes the original file on the native filesystem", async () => {
  const f = await fixture()
  await f.persist()
  expect((await fs.readFile(f.physicalPath)).equals(f.bytes)).toBe(true)
  expect(await f.abandon()).toBe(true)
  expect(await Bun.file(f.physicalPath).exists()).toBe(false)
})

test("a same-length, same-inode edit after the write but before arming is not the uploaded content", async () => {
  const f = await fixture()
  const open = fs.open
  const seam = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === f.physicalPath && args[1] === "wx") {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        const editor = await open(f.physicalPath, "r+")
        try { await editor.write(Buffer.from([0xff]), 0, 1, f.bytes.length - 1) }
        finally { await editor.close() }
      }
    }
    return handle
  })
  try { await f.persist() } finally { seam.mockRestore() }
  const edited = Buffer.from(f.bytes)
  edited[edited.length - 1] = 0xff
  expect((await fs.readFile(f.physicalPath)).equals(edited)).toBe(true)
  expect(await f.abandon()).toBe(false)
  expect((await fs.readFile(f.physicalPath)).equals(edited)).toBe(true)
})

test("a version change during verification cannot arm a receipt even when all expected bytes matched", async () => {
  const f = await fixture()
  let appended = false
  const open = fs.open
  const seam = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === f.physicalPath && args[1] !== "wx") {
      handle.read = new Proxy(handle.read, {
        async apply(read, reader, args) {
          const chunk = await Reflect.apply(read, reader, args)
          if (!appended) {
            appended = true
            await fs.appendFile(f.physicalPath, "local footer")
          }
          return chunk
        },
      })
    }
    return handle
  })
  try { await f.persist() } finally { seam.mockRestore() }
  expect(appended).toBe(true)
  expect(f.draftWrites[0]!.version).toBeUndefined()
  expect(await f.abandon()).toBe(false)
  expect((await fs.readFile(f.physicalPath)).equals(Buffer.concat([f.bytes, Buffer.from("local footer")]))).toBe(true)
})

test("a new native file at the same name is not owned by the old receipt", async () => {
  const f = await fixture()
  await f.persist()
  // Keep the old inode alive and reuse only its name and contents.
  await fs.rename(f.physicalPath, `${f.physicalPath}.bak`)
  await fs.writeFile(f.physicalPath, f.bytes)
  expect(await f.abandon()).toBe(false)
  expect((await fs.readFile(f.physicalPath)).equals(f.bytes)).toBe(true)
})
