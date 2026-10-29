import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import { readAppSettingsSnapshot } from "../../../server/app-settings"
import type { AppSettingsSnapshot } from "../../../shared/types"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { type ConditionPolicy } from "../../lib/conditionApi"
import { GeneralSection } from "./GeneralSection"
import { MemorySettingsGroups } from "./MemorySection"
import { ProvidersSection } from "./ProvidersSection"
import { KeybindingsSection } from "./KeybindingsSection"
import { SkillsSection } from "./SkillsSection"
import { ALL_SETTINGS_ROWS, SETTINGS_ROWS, SETTINGS_SECTIONS, getSettingsRowHref, resolveSettingsSectionId } from "./registry"

const settings: AppSettingsSnapshot = await readAppSettingsSnapshot("/tmp/memosync-settings-registry-nonexistent/settings.json")
const policy: ConditionPolicy = { condition: "memosync", capture: "review", preview: true, trace: true, boardVisible: true, boardWritable: true, bringIn: true, injection: "skills", memoryTools: true, studyMode: false }
const memoryHtml = (overrides: { enabled?: boolean; learn?: boolean; studyMode?: boolean; preview?: boolean; boardVisible?: boolean } = {}) => renderToStaticMarkup(<MemoryRouter><MemorySettingsGroups settings={{ ...settings, memory: { enabled: overrides.enabled ?? true, learn: overrides.learn ?? true } }} policy={{ ...policy, studyMode: overrides.studyMode ?? false, preview: overrides.preview ?? true, boardVisible: overrides.boardVisible ?? true }} mode="ask" save={() => {}} setMode={() => {}} /></MemoryRouter>)

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
      providers: renderToStaticMarkup(<ProvidersSection state={{ handleWriteAppSettings: async () => {} }} />),
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
    expect(htmlBySection.providers).not.toContain(">Codex<")
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
  test("study policy hides personal switches and controls preview and board access", () => {
    const html = memoryHtml({ studyMode: true, enabled: false, learn: false, preview: false, boardVisible: false })
    expect(html).not.toContain(`id="${SETTINGS_ROWS.memoryEnabled.id}"`)
    expect(html).not.toContain(`id="${SETTINGS_ROWS.memoryLearn.id}"`)
    expect(html).not.toContain(`id="${SETTINGS_ROWS.memoryPreview.id}"`)
    expect(html).not.toContain("Turn on Use Memory")
    expect(html).not.toContain('href="/memory"')
    expect(html).toContain("Ask First")
  })
})
