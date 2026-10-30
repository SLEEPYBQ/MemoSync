import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { readAppSettingsSnapshot } from "../../../server/app-settings"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import { PROVIDERS, type AppSettingsSnapshot } from "../../../shared/types"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { GeneralSection } from "./GeneralSection"
import { KeybindingsSection } from "./KeybindingsSection"
import { MemorySettingsGroups } from "./MemorySection"
import { ProvidersSection } from "./ProvidersSection"
import { SkillsSection } from "./SkillsSection"
import { ALL_SETTINGS_ROWS, SETTINGS_SECTIONS, getSettingsRowHref, resolveSettingsSectionId } from "./registry"

const settings: AppSettingsSnapshot = await readAppSettingsSnapshot("/tmp/memosync-settings-registry-nonexistent/settings.json")
const memoryHtml = (overrides: { enabled?: boolean; learn?: boolean } = {}) => renderToStaticMarkup(<MemoryRouter><MemorySettingsGroups settings={{ ...settings, memory: { enabled: overrides.enabled ?? true, learn: overrides.learn ?? true } }} mode="ask" save={() => {}} setMode={() => {}} /></MemoryRouter>)

describe("settings registry and section rendering", () => {
  test("stable unique ids, section order and deep links", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(["general", "memory", "providers", "skills", "keybindings", ...(SELF_UPDATE_ENABLED ? ["changelog" as const] : [])])
    expect(new Set(ALL_SETTINGS_ROWS.map((row) => row.id)).size).toBe(ALL_SETTINGS_ROWS.length)
    expect(resolveSettingsSectionId("memory")).toBe("memory")
    for (const row of ALL_SETTINGS_ROWS) {
      expect(SETTINGS_SECTIONS.some((section) => section.id === row.sectionId)).toBe(true)
      expect(getSettingsRowHref(row)).toBe(`/settings/${row.sectionId}#${row.id}`)
    }
  })
  test("every available row definition is rendered in its registered section", () => {
    // React SSR reads Zustand getInitialState rather than the live browser state.
    const initial = useTerminalPreferencesStore.getInitialState()
    const previousPreset = initial.editorPreset
    initial.editorPreset = "custom"
    const htmlBySection = {
      general: renderToStaticMarkup(<GeneralSection state={{ appSettings: settings, handleWriteAppSettings: async () => {}, updateSnapshot: null, handleCheckForUpdates: async () => {}, handleInstallUpdate: async () => {} }} appVersion="1.0.0" />),
      memory: memoryHtml(),
      providers: renderToStaticMarkup(<ProvidersSection state={{ handleWriteAppSettings: async () => {}, availableProviders: PROVIDERS }} />),
      skills: renderToStaticMarkup(<SkillsSection state={{ connectionStatus: "connected", socket: { command: async () => ({ skills: [] }) } as never }} />),
      keybindings: renderToStaticMarkup(<KeybindingsSection state={{ keybindings: null, socket: { command: async () => ({}) } as never }} />),
      changelog: "",
    }
    initial.editorPreset = previousPreset
    for (const row of ALL_SETTINGS_ROWS) {
      if (row.id === "applicationUpdate" && !SELF_UPDATE_ENABLED) continue
      expect(htmlBySection[row.sectionId]).toContain(`id="${row.id}"`)
      for (const [sectionId, html] of Object.entries(htmlBySection)) {
        if (sectionId !== row.sectionId) expect(html).not.toContain(`id="${row.id}"`)
      }
    }
    expect(htmlBySection.general).not.toContain("Memory Preview")
    expect(htmlBySection.providers).toContain('data-engine="codex"')
  })
  test("memory-off dims and disables dependents with actionable reasons", () => {
    const html = memoryHtml({ enabled: false })
    expect(html).toContain('aria-label="Use Memory"')
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(4)
    expect(html.match(/Turn on Use Memory to change this./g)?.length).toBe(4)
    expect(html).toContain('href="/memory"')
  })
  test("learning-off only disables memory changes, keeping preview usable", () => {
    const html = memoryHtml({ learn: false })
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(1)
    expect(html).toContain("Turn on Learn From Chats to change this.")
  })
})
