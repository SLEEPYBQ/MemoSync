import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"
import type { AppSettingsSnapshot } from "../shared/types"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
  tempDirs.push(dir)
  return path.join(dir, "settings.json")
}

function expectedSettingsSnapshot(filePath: string, overrides: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    browserSettingsMigrated: false,
    theme: "system",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    chatBrowserNotificationPreference: "never",
    language: "system",
    submitWhileRunning: "queue",
    terminal: {
      scrollbackLines: 1_000,
      minColumnWidth: 450,
    },
    editor: {
      preset: "cursor",
      commandTemplate: "cursor {path}",
    },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: "deepseek-v4-flash",
        modelOptions: {
          reasoningEffort: "high",
          contextWindow: "1m",
        },
        planMode: false,
      },
      codex: {
        model: "gpt-5.5",
        modelOptions: {
          reasoningEffort: "high",
          fastMode: false,
        },
        planMode: false,
      },
      pi: {
        model: "anthropic/claude-sonnet-4-6",
        modelOptions: {
          reasoningEffort: "medium",
        },
        planMode: false,
      },
    },
    memory: {
      control: "review",
      enabled: true,
      learn: true,
    },
    memoryPreview: {
      enabled: true,
      autoProceedWhenEmpty: true,
    },
    warning: null,
    filePathDisplay: filePath,
    ...overrides,
  }
}

describe("memory control settings", () => {
  test("legacy and invalid control values normalise to review without changing the switches", async () => {
    const filePath = await createTempFilePath()
    for (const control of [undefined, "invalid", false]) {
      await writeFile(filePath, JSON.stringify({ memory: { control, enabled: false, learn: false } }))
      expect((await readAppSettingsSnapshot(filePath)).memory).toEqual({ control: "review", enabled: false, learn: false })
    }
  })

  test("control persists through patches, reload and normalised migration", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)
    try {
      await manager.initialize()
      expect(JSON.parse(await readFile(filePath, "utf8")).memory.control).toBe("review")
      await manager.writePatch({ memory: { control: "auto" } })
      await manager.writePatch({ memory: { learn: false } })
      await manager.reload()
      expect(manager.getSnapshot().memory).toEqual({ control: "auto", enabled: true, learn: false })
      expect((await readAppSettingsSnapshot(filePath)).memory.control).toBe("auto")
      await manager.writePatch({ memory: { control: "review" } })
      expect(manager.getSnapshot().memory).toEqual({ control: "review", enabled: true, learn: false })
    } finally {
      manager.dispose()
    }
  })
})

describe("memoryPreview settings", () => {
  test("defaults to enabled + auto-proceed-when-empty", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.memoryPreview).toEqual({ enabled: true, autoProceedWhenEmpty: true })
  })

  test("patch persists and round-trips through the file", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)
    await manager.initialize()
    const snapshot = await manager.writePatch({ memoryPreview: { enabled: false } })
    expect(snapshot.memoryPreview).toEqual({ enabled: false, autoProceedWhenEmpty: true })
    const onDisk = JSON.parse(await readFile(filePath, "utf8"))
    expect(onDisk.memoryPreview).toEqual({ enabled: false, autoProceedWhenEmpty: true })
    manager.dispose()
    expect((await readAppSettingsSnapshot(filePath)).memoryPreview.enabled).toBe(false)
  })

  test("non-boolean values reset to defaults", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, JSON.stringify({ memoryPreview: { enabled: "nope", autoProceedWhenEmpty: 3 } }))
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.memoryPreview).toEqual({ enabled: true, autoProceedWhenEmpty: true })
  })
})

describe("readAppSettingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)

    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath))
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("AppSettingsManager", () => {
  test("creates a settings file with normalized defaults", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()

    expect(manager.getSnapshot()).toEqual(expectedSettingsSnapshot(filePath))

    manager.dispose()
  })

  test("patches expanded settings", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()

    const snapshot = await manager.writePatch({
      theme: "dark",
      chatSoundId: "glass",
      terminal: { scrollbackLines: 2_500 },
      editor: { preset: "vscode" },
      providerDefaults: {
        codex: {
          modelOptions: { reasoningEffort: "high", fastMode: true },
        },
      },
    })
    const nextPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      theme: string
      chatSoundId: string
      terminal: { scrollbackLines: number; minColumnWidth: number }
      editor: { preset: string; commandTemplate: string }
      providerDefaults: { codex: { modelOptions: { fastMode: boolean } } }
    }

    expect(snapshot.theme).toBe("dark")
    expect(snapshot.chatSoundId).toBe("glass")
    expect(snapshot.terminal.scrollbackLines).toBe(2_500)
    expect(snapshot.terminal.minColumnWidth).toBe(450)
    expect(snapshot.editor.preset).toBe("vscode")
    expect(snapshot.editor.commandTemplate).toBe("cursor {path}")
    expect(snapshot.providerDefaults.codex.modelOptions.fastMode).toBe(true)
    expect(nextPayload.theme).toBe("dark")
    expect(nextPayload.chatSoundId).toBe("glass")

    manager.dispose()
  })
})

describe("language preference", () => {
  test("defaults and invalid file values normalize to system", async () => {
    const filePath = await createTempFilePath()
    expect((await readAppSettingsSnapshot(filePath)).language).toBe("system")
    for (const language of ["fr", "zh", null, 7]) {
      await writeFile(filePath, JSON.stringify({ language }))
      expect((await readAppSettingsSnapshot(filePath)).language).toBe("system")
    }
  })
  test("persists explicit languages and merges unrelated patches", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)
    await manager.initialize()
    try {
      for (const language of ["zh-CN", "en", "system"] as const) {
        expect((await manager.writePatch({ language })).language).toBe(language)
        expect((await manager.writePatch({ theme: "dark" })).language).toBe(language)
        expect((await readAppSettingsSnapshot(filePath)).language).toBe(language)
        expect(JSON.parse(await readFile(filePath, "utf8")).language).toBe(language)
      }
    } finally { manager.dispose() }
  })
})
