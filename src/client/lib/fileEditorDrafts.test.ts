import { describe, expect, test } from "bun:test"
import { fileEditorDrafts, type FileBuffer } from "./fileEditorDrafts"

function buffer(original: string, current: string): FileBuffer {
  return {
    kind: "text", status: "ready", original, current, revision: '"base"',
    incarnation: {}, saving: false, saveError: null, justSaved: false, mdMode: "source",
  }
}

function open(store: ReturnType<typeof fileEditorDrafts>, path: string, value: FileBuffer) {
  store.setTabs([path])
  store.setActive(path)
  store.setBuffers(new Map([[path, value]]))
}

describe("project file editor drafts", () => {
  test("retains dirty tabs across unmount and isolates projects while evicting clean tabs", () => {
    const a = fileEditorDrafts("draft-test-a")
    const b = fileEditorDrafts("draft-test-b")
    const releaseA = a.mount()
    const releaseB = b.mount()
    const dirty = buffer("base a", "edited a")
    open(a, "one.ts", dirty)
    a.setTabs(["one.ts", "clean.ts"])
    a.setBuffers(current => new Map(current).set("clean.ts", buffer("clean", "clean")))
    open(b, "one.ts", buffer("base b", "edited b"))
    const snapshot = a.getSnapshot()
    expect(a.getSnapshot()).toBe(snapshot)
    releaseA()
    const restored = fileEditorDrafts("draft-test-a")
    expect(restored).toBe(a)
    expect(restored.getSnapshot().tabs).toEqual(["one.ts"])
    expect(restored.getSnapshot().active).toBe("one.ts")
    expect(restored.getSnapshot().buffers.get("one.ts")).toEqual(dirty)
    expect(b.getSnapshot().buffers.get("one.ts")?.current).toBe("edited b")
    const remount = restored.mount()
    restored.setBuffers(new Map())
    b.setBuffers(new Map())
    remount()
    releaseB()
  })

  test("a save settling after remount preserves newer edits and ignores a discarded incarnation", () => {
    const store = fileEditorDrafts("draft-test-save")
    const release = store.mount()
    const first = buffer("base", "sent")
    first.saving = true
    open(store, "x.ts", first)
    release()
    const restored = fileEditorDrafts("draft-test-save")
    const releaseAgain = restored.mount()
    restored.patch("x.ts", first.incarnation, { current: "new typing" })
    store.patch("x.ts", first.incarnation, { saving: false, original: "sent", revision: '"saved"' })
    expect(restored.getSnapshot().buffers.get("x.ts")).toMatchObject({
      original: "sent", current: "new typing", revision: '"saved"', saving: false,
    })
    releaseAgain()
    const releaseThird = restored.mount()
    expect(restored.getSnapshot().buffers.get("x.ts")?.current).toBe("new typing")
    restored.setBuffers(new Map())
    const replacement = buffer("disk", "replacement edits")
    restored.setBuffers(new Map([["x.ts", replacement]]))
    store.patch("x.ts", first.incarnation, { original: "stale", saving: false })
    expect(restored.getSnapshot().buffers.get("x.ts")).toEqual(replacement)
    restored.setBuffers(new Map())
    releaseThird()
  })

  test("a completed save after unmount evicts its now-clean draft", () => {
    const store = fileEditorDrafts("draft-test-clean-save")
    const release = store.mount()
    const value = buffer("base", "sent")
    value.saving = true
    open(store, "x.ts", value)
    release()
    store.patch("x.ts", value.incarnation, { saving: false, original: "sent", revision: '"saved"' })
    expect(store.getSnapshot().buffers.size).toBe(0)
    expect(fileEditorDrafts("draft-test-clean-save").getSnapshot().buffers.size).toBe(0)
  })

  test("a folder rename cannot claim an unmounted destination with an in-flight descendant", async () => {
    const store = fileEditorDrafts("draft-rename-folder-destination")
    const release = store.mount()
    const saving = { ...buffer("base", "base"), saving: true }
    open(store, "archive/deep/file.txt", saving)
    release()
    const unexpectedMove = () => { throw new Error("A collision must not reach the filesystem") }
    expect(await store.rename("incoming", "archive", unexpectedMove)).toEqual({ status: "open", path: "archive/deep/file.txt" })
    expect(await store.rename("incoming", "Archive", unexpectedMove)).toEqual({ status: "open", path: "archive/deep/file.txt" })
    expect(await store.rename("archive", "elsewhere", unexpectedMove)).toEqual({ status: "busy" })
    expect(store.getSnapshot().buffers.get("archive/deep/file.txt")).toEqual(saving)
    store.clear()
  })

  test("the project owns a pending rename until it settles, including across a failed request", async () => {
    const store = fileEditorDrafts("draft-rename-folder-source")
    const release = store.mount()
    const draft = buffer("base", "first")
    open(store, "src/note.txt", draft)
    const gate = Promise.withResolvers<boolean>()
    const move = store.rename("src", "dest", () => gate.promise)
    expect(store.isRenaming("dest/note.txt")).toBe(true)
    expect(store.isRenaming("DEST/note.txt")).toBe(true)
    expect(store.isRenaming("src/note.txt")).toBe(true)
    expect(store.isRenaming("destination/note.txt")).toBe(false)
    store.patch("src/note.txt", draft.incarnation, { current: "typed during rename" })
    release()
    gate.resolve(false)
    expect(await move).toEqual({ status: "failed" })
    expect(store.isRenaming("src/note.txt")).toBe(false)
    expect(store.getSnapshot().active).toBe("src/note.txt")
    expect(await store.rename("src", "dest", async () => true)).toEqual({ status: "renamed" })
    expect(store.getSnapshot().tabs).toEqual(["dest/note.txt"])
    expect(store.getSnapshot().active).toBe("dest/note.txt")
    expect(store.getSnapshot().buffers.get("dest/note.txt")?.current).toBe("typed during rename")
    store.clear()
  })

  test("an open source can follow its own case-only rename without claiming a separate destination tab", async () => {
    const store = fileEditorDrafts("draft-rename-source-case")
    const release = store.mount()
    const draft = buffer("base", "edit")
    open(store, "notes/a.txt", draft)
    expect(await store.rename("notes", "Notes", async () => true)).toEqual({ status: "renamed" })
    expect(store.getSnapshot().active).toBe("Notes/a.txt")
    expect(store.getSnapshot().buffers.get("Notes/a.txt")).toEqual(draft)
    store.clear()
    release()
  })

  test("an empty unmount and remount keeps the same project owner", () => {
    const store = fileEditorDrafts("draft-test-strict")
    const first = store.mount()
    first()
    const second = store.mount()
    open(store, "x.ts", buffer("base", "edit"))
    expect(fileEditorDrafts("draft-test-strict")).toBe(store)
    second()
    expect(fileEditorDrafts("draft-test-strict").getSnapshot().buffers.get("x.ts")?.current).toBe("edit")
    const discard = store.mount()
    store.setBuffers(new Map())
    discard()
  })

  test("one unload guard stays installed until the last project is discarded", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
    const fakeWindow = new EventTarget()
    Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true })
    const a = fileEditorDrafts("draft-test-guard-a")
    const b = fileEditorDrafts("draft-test-guard-b")
    const releaseA = a.mount()
    const releaseB = b.mount()
    try {
      open(a, "a", buffer("base", "edit a"))
      open(b, "b", buffer("base", "edit b"))
      releaseA()
      releaseB()
      const first = new Event("beforeunload", { cancelable: true })
      fakeWindow.dispatchEvent(first)
      expect(first.defaultPrevented).toBe(true)
      const remountA = a.mount()
      a.setBuffers(new Map())
      remountA()
      const second = new Event("beforeunload", { cancelable: true })
      fakeWindow.dispatchEvent(second)
      expect(second.defaultPrevented).toBe(true)
      const remountB = b.mount()
      b.setBuffers(new Map())
      remountB()
      const last = new Event("beforeunload", { cancelable: true })
      fakeWindow.dispatchEvent(last)
      expect(last.defaultPrevented).toBe(false)
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
