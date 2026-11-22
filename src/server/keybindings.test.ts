import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_KEYBINDINGS } from "../shared/types"
import { KeybindingsManager, normalizeKeybindings, readKeybindingsSnapshot } from "./keybindings"

let tempDirs: string[] = []
const TEST_FILE_PATH = "/tmp/kanna-test-keybindings.json"

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-keybindings-"))
  tempDirs.push(dir)
  return path.join(dir, "keybindings.json")
}

describe("normalizeKeybindings", () => {
  test("falls back to defaults for invalid entries", () => {
    const snapshot = normalizeKeybindings({
      toggleEmbeddedTerminal: [],
      toggleRightSidebar: "Ctrl+B",
    }, TEST_FILE_PATH)

    expect(snapshot.bindings).toEqual({ ...DEFAULT_KEYBINDINGS, toggleEmbeddedTerminal: [] })
    expect(snapshot.warning).not.toContain("toggleEmbeddedTerminal")
    expect(snapshot.warning).toContain("toggleRightSidebar")
  })

  test("resets a non-empty array containing only blank entries", () => {
    const snapshot = normalizeKeybindings({ toggleEmbeddedTerminal: ["", " "] }, TEST_FILE_PATH)
    expect(snapshot.bindings.toggleEmbeddedTerminal).toEqual(DEFAULT_KEYBINDINGS.toggleEmbeddedTerminal)
    expect(snapshot.warning).toContain("toggleEmbeddedTerminal did not contain any valid shortcut strings")
  })

  test("accepts an explicit empty array without a warning", () => {
    const snapshot = normalizeKeybindings({ toggleEmbeddedTerminal: [] }, TEST_FILE_PATH)
    expect(snapshot.bindings.toggleEmbeddedTerminal).toEqual([])
    expect(snapshot.warning).toBeNull()
  })

  test("moves an untouched old right-sidebar default off cmd+b", () => {
    const snapshot = normalizeKeybindings({ toggleRightSidebar: ["cmd+b", "ctrl+b"] }, TEST_FILE_PATH)

    expect(snapshot.bindings.toggleLeftSidebar).toEqual(["cmd+b", "ctrl+b"])
    expect(snapshot.bindings.toggleRightSidebar).toEqual(["cmd+alt+b", "ctrl+alt+b"])
    expect(snapshot.warning).toBeNull()
  })

  test("keeps a customised right-sidebar binding", () => {
    const snapshot = normalizeKeybindings({ toggleRightSidebar: ["cmd+b"] }, TEST_FILE_PATH)

    expect(snapshot.bindings.toggleRightSidebar).toEqual(["cmd+b"])
  })

  test("keeps valid shortcut arrays", () => {
    const snapshot = normalizeKeybindings({
      toggleEmbeddedTerminal: [" Cmd+K ", "Ctrl+`"],
      toggleLeftSidebar: ["Cmd+B"],
      toggleRightSidebar: ["Ctrl+Shift+B"],
      openInFinder: ["Cmd+Alt+F"],
      openInEditor: ["Cmd+Shift+O"],
      addSplitTerminal: ["Cmd+Shift+J"],
      jumpToSidebarChat: ["Cmd+Alt"],
      createChatInCurrentProject: ["Cmd+Alt+N"],
      openAddProject: ["Cmd+Alt+O"],
    }, TEST_FILE_PATH)

    expect(snapshot).toEqual({
      bindings: {
        toggleEmbeddedTerminal: ["cmd+k", "ctrl+`"],
        toggleLeftSidebar: ["cmd+b"],
        toggleRightSidebar: ["ctrl+shift+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+shift+j"],
        jumpToSidebarChat: ["cmd+alt"],
        createChatInCurrentProject: ["cmd+alt+n"],
        openAddProject: ["cmd+alt+o"],
      },
      warning: null,
      filePathDisplay: TEST_FILE_PATH,
    })
  })
})

describe("readKeybindingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot).toEqual({
      bindings: DEFAULT_KEYBINDINGS,
      warning: null,
      filePathDisplay: filePath,
    })
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings).toEqual(DEFAULT_KEYBINDINGS)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("files from before the Ctrl+Alt defaults", () => {
  test("take the new default where the old ⌘-only default was untouched", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({
      jumpToSidebarChat: ["cmd+alt"],
      createChatInCurrentProject: ["Cmd+Alt+N"],
      openAddProject: ["cmd+shift+p"],
      toggleEmbeddedTerminal: ["cmd+k"],
    }))
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings.jumpToSidebarChat).toEqual(DEFAULT_KEYBINDINGS.jumpToSidebarChat)
    expect(snapshot.bindings.createChatInCurrentProject).toEqual(DEFAULT_KEYBINDINGS.createChatInCurrentProject)
    expect(snapshot.bindings.openAddProject).toEqual(["cmd+shift+p"])
    expect(snapshot.bindings.toggleEmbeddedTerminal).toEqual(["cmd+k"])
    expect(snapshot.warning).toBeNull()
  })

  test("leave a version 2 file alone", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({ version: 2, jumpToSidebarChat: ["cmd+alt"] }))
    expect((await readKeybindingsSnapshot(filePath)).bindings.jumpToSidebarChat).toEqual(["cmd+alt"])
  })

  test("does not upgrade explicit legacy defaults when effective bindings are already occupied", async () => {
    const filePath = await createTempFilePath()
    const contents = JSON.stringify({
      jumpToSidebarChat: ["cmd+alt"],
      createChatInCurrentProject: [" Cmd+Alt+N "],
      openAddProject: ["option+control+n"],
      toggleEmbeddedTerminal: ["ctrl+alt+3"],
    })
    await Bun.write(filePath, contents)
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings.jumpToSidebarChat).toEqual(["cmd+alt"])
    expect(snapshot.bindings.createChatInCurrentProject).toEqual(["cmd+alt+n"])
    expect(snapshot.bindings.openAddProject).toEqual(["option+control+n"])
    expect(snapshot.warning).toBeNull()
    expect(await Bun.file(filePath).text()).toBe(contents)
  })

  test("does not add conflicting Ctrl+Alt defaults for missing legacy actions", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({
      openAddProject: ["option+control+n"],
      toggleEmbeddedTerminal: ["ctrl+alt+3"],
    }))
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings.jumpToSidebarChat).toEqual(["cmd+alt"])
    expect(snapshot.bindings.createChatInCurrentProject).toEqual(["cmd+alt+n"])
    expect(snapshot.bindings.openAddProject).toEqual(["option+control+n"])
    expect(snapshot.warning).toBeNull()
  })

  test("upgrades absent and untouched legacy actions when alternatives are free", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({
      createChatInCurrentProject: ["cmd+alt+n"],
      toggleEmbeddedTerminal: ["ctrl+shift+3"],
    }))
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings.jumpToSidebarChat).toEqual(DEFAULT_KEYBINDINGS.jumpToSidebarChat)
    expect(snapshot.bindings.createChatInCurrentProject).toEqual(DEFAULT_KEYBINDINGS.createChatInCurrentProject)
    expect(snapshot.bindings.openAddProject).toEqual(DEFAULT_KEYBINDINGS.openAddProject)
  })

  test("preserves the old open-project shortcut when its new alternative is occupied", async () => {
    const filePath = await createTempFilePath()
    for (const openAddProject of [undefined, ["cmd+alt+o"]]) {
      await Bun.write(filePath, JSON.stringify({
        openAddProject,
        createChatInCurrentProject: ["option+control+o"],
      }))
      const snapshot = await readKeybindingsSnapshot(filePath)
      expect(snapshot.bindings.openAddProject).toEqual(["cmd+alt+o"])
      expect(snapshot.bindings.createChatInCurrentProject).toEqual(["option+control+o"])
      expect(snapshot.warning).toBeNull()
    }
  })

  test("does not reserve the hidden editor shortcut or jump digit zero", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({
      openInEditor: ["ctrl+alt+n"],
      toggleEmbeddedTerminal: ["ctrl+alt+0"],
    }))
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings.createChatInCurrentProject).toEqual(DEFAULT_KEYBINDINGS.createChatInCurrentProject)
    expect(snapshot.bindings.jumpToSidebarChat).toEqual(DEFAULT_KEYBINDINGS.jumpToSidebarChat)
    expect(snapshot.bindings.openInEditor).toEqual(["ctrl+alt+n"])
  })

  test("preserves malformed and unassigned actions and normalization warnings", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({
      jumpToSidebarChat: ["", " "],
      createChatInCurrentProject: ["cmd+alt+n", null],
      openAddProject: [],
    }))
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings.jumpToSidebarChat).toEqual(DEFAULT_KEYBINDINGS.jumpToSidebarChat)
    expect(snapshot.bindings.createChatInCurrentProject).toEqual(["cmd+alt+n"])
    expect(snapshot.bindings.openAddProject).toEqual([])
    expect(snapshot.warning).toContain("jumpToSidebarChat did not contain any valid shortcut strings")

    await Bun.write(filePath, JSON.stringify({ createChatInCurrentProject: "cmd+alt+n" }))
    const invalid = await readKeybindingsSnapshot(filePath)
    expect(invalid.bindings.createChatInCurrentProject).toEqual(DEFAULT_KEYBINDINGS.createChatInCurrentProject)
    expect(invalid.warning).toContain("createChatInCurrentProject must be an array")
  })

  test("does not upgrade version 2 or invalid top-level files", async () => {
    const filePath = await createTempFilePath()
    await Bun.write(filePath, JSON.stringify({ version: 2, openAddProject: ["ctrl+alt+n"] }))
    const versioned = await readKeybindingsSnapshot(filePath)
    expect(versioned.bindings.createChatInCurrentProject).toEqual(DEFAULT_KEYBINDINGS.createChatInCurrentProject)
    expect(versioned.bindings.openAddProject).toEqual(["ctrl+alt+n"])
    for (const value of [null, []]) {
      await Bun.write(filePath, JSON.stringify(value))
      const invalid = await readKeybindingsSnapshot(filePath)
      expect(invalid.bindings).toEqual(DEFAULT_KEYBINDINGS)
      expect(invalid.warning).toContain("must contain a JSON object")
    }
  })
})

describe("KeybindingsManager", () => {
  test("creates the keybindings file with defaults during initialization", async () => {
    const filePath = await createTempFilePath()
    const manager = new KeybindingsManager(filePath)

    await manager.initialize()

    expect(await Bun.file(filePath).json()).toEqual({ version: 2, ...DEFAULT_KEYBINDINGS })
    manager.dispose()
  })

  test("writes normalized bindings to disk", async () => {
    const filePath = await createTempFilePath()
    const manager = new KeybindingsManager(filePath)

    await manager.initialize()
    const snapshot = await manager.write({
      toggleEmbeddedTerminal: ["Cmd+K"],
      toggleLeftSidebar: ["Cmd+B"],
      toggleRightSidebar: ["Ctrl+Shift+B"],
      openInFinder: ["Cmd+Alt+F"],
      openInEditor: ["Cmd+Shift+O"],
      addSplitTerminal: ["Cmd+Shift+J"],
      jumpToSidebarChat: ["Cmd+Alt"],
      createChatInCurrentProject: ["Cmd+Alt+N"],
      openAddProject: ["Cmd+Alt+O"],
    })

    expect(snapshot).toEqual({
      bindings: {
        toggleEmbeddedTerminal: ["cmd+k"],
        toggleLeftSidebar: ["cmd+b"],
        toggleRightSidebar: ["ctrl+shift+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+shift+j"],
        jumpToSidebarChat: ["cmd+alt"],
        createChatInCurrentProject: ["cmd+alt+n"],
        openAddProject: ["cmd+alt+o"],
      },
      warning: null,
      filePathDisplay: filePath,
    })
    expect(JSON.parse(await Bun.file(filePath).text())).toEqual({ version: 2, ...snapshot.bindings })
    await manager.reload()
    expect(manager.getSnapshot().bindings.jumpToSidebarChat).toEqual(["cmd+alt"])
    expect(manager.getSnapshot().bindings.createChatInCurrentProject).toEqual(["cmd+alt+n"])

    manager.dispose()
  })

  test("persists an unassigned action across reload", async () => {
    const filePath = await createTempFilePath()
    const manager = new KeybindingsManager(filePath)
    await manager.initialize()
    const written = await manager.write({ toggleEmbeddedTerminal: [] })
    expect(written.bindings.toggleEmbeddedTerminal).toEqual([])
    expect(written.warning).toBeNull()
    await manager.reload()
    expect(manager.getSnapshot().bindings.toggleEmbeddedTerminal).toEqual([])
    expect(manager.getSnapshot().warning).toBeNull()
    expect((await Bun.file(filePath).json()).toggleEmbeddedTerminal).toEqual([])
    manager.dispose()
  })

  test("uses the runtime profile for the default keybindings path", () => {
    const previous = process.env.MEMOSYNC_RUNTIME_PROFILE
    process.env.MEMOSYNC_RUNTIME_PROFILE = "dev"

    const manager = new KeybindingsManager()

    expect(manager.filePath).toEndWith("/.memosync-dev/keybindings.json")

    if (previous === undefined) {
      delete process.env.MEMOSYNC_RUNTIME_PROFILE
    } else {
      process.env.MEMOSYNC_RUNTIME_PROFILE = previous
    }
  })
})
