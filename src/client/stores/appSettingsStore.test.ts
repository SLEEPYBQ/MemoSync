import { afterEach, expect, test } from "bun:test"
import { readAppSettingsSnapshot } from "../../server/app-settings"
import { i18n } from "../i18n"
import { mergeAppSettingsPatch, useAppSettingsStore } from "./appSettingsStore"

afterEach(() => {
  useAppSettingsStore.setState({ settings: null, hydrationStatus: "idle" })
  void i18n.changeLanguage("en")
})

test("memory control survives nested optimistic patches and server rollback", async () => {
  const settings = await readAppSettingsSnapshot(`/tmp/memory-control-settings-absent-${crypto.randomUUID()}`)
  useAppSettingsStore.getState().setFromServer(settings)
  useAppSettingsStore.getState().applyOptimisticPatch({ memory: { control: "auto" } })
  useAppSettingsStore.getState().applyOptimisticPatch({ memory: { learn: false }, memoryPreview: { enabled: false } })
  expect(useAppSettingsStore.getState().settings?.memory).toEqual({ control: "auto", enabled: true, learn: false })
  useAppSettingsStore.getState().setFromServer(settings)
  expect(useAppSettingsStore.getState().settings?.memory.control).toBe("review")
})

test("language survives nested client settings merges", async () => {
  const settings = await readAppSettingsSnapshot(`/tmp/i18n-settings-absent-${crypto.randomUUID()}`)
  const chinese = mergeAppSettingsPatch(settings, { language: "zh-CN" })
  const next = mergeAppSettingsPatch(chinese, { terminal: { scrollbackLines: 2000 }, providerDefaults: { claude: { planMode: true } } })
  expect(next.language).toBe("zh-CN")
  expect(next.terminal.scrollbackLines).toBe(2000)
  expect(next.providerDefaults.codex).toEqual(settings.providerDefaults.codex)
})

test("optimistic updates and server rollback both update the resolved language", async () => {
  const settings = await readAppSettingsSnapshot(`/tmp/i18n-settings-absent-${crypto.randomUUID()}`)
  useAppSettingsStore.getState().setFromServer({ ...settings, language: "en" })
  useAppSettingsStore.getState().applyOptimisticPatch({ language: "zh-CN" })
  expect(i18n.resolvedLanguage).toBe("zh-CN")
  expect(useAppSettingsStore.getState().settings?.language).toBe("zh-CN")
  useAppSettingsStore.getState().setFromServer({ ...settings, language: "en" })
  expect(i18n.resolvedLanguage).toBe("en")
})
