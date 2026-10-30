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
import { ALL_SETTINGS_ROWS, SETTINGS_ROWS, SETTINGS_SECTIONS, getSettingsRowHref, resolveSettingsSectionId } from "./registry"

const settings: AppSettingsSnapshot = await readAppSettingsSnapshot("/tmp/memosync-settings-registry-nonexistent/settings.json")
const memoryHtml = (overrides: Partial<AppSettingsSnapshot["memory"]> = {}) => renderToStaticMarkup(<MemoryRouter><MemorySettingsGroups settings={{ ...settings, memory: { ...settings.memory, ...overrides } }} mode="ask" save={() => {}} setMode={() => {}} /></MemoryRouter>)

describe("settings registry and section rendering", () => {
  test("stable unique ids, section order and deep links", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(["general", "appearance", "notifications", "providers", "memory", "skills", "keybindings", "about", ...(SELF_UPDATE_ENABLED ? ["changelog" as const] : [])])
    expect(SETTINGS_SECTIONS.map((section) => section.group)).toEqual(["preferences", "preferences", "preferences", "agents", "agents", "agents", "other", "other", ...(SELF_UPDATE_ENABLED ? ["other" as const] : [])])
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
    const generalState = { appSettings: settings, handleWriteAppSettings: async () => {}, updateSnapshot: null, handleCheckForUpdates: async () => {}, handleInstallUpdate: async () => {} }
    const htmlBySection = {
      general: renderToStaticMarkup(<GeneralSection state={generalState} appVersion="1.0.0" />),
      appearance: renderToStaticMarkup(<GeneralSection state={generalState} appVersion="1.0.0" part="appearance" />),
      notifications: renderToStaticMarkup(<GeneralSection state={generalState} appVersion="1.0.0" part="notifications" />),
      about: renderToStaticMarkup(<GeneralSection state={generalState} appVersion="1.0.0" part="about" />),
      memory: memoryHtml(),
      providers: renderToStaticMarkup(<ProvidersSection state={{ handleWriteAppSettings: async () => {}, availableProviders: PROVIDERS }} defaultExpanded={["claude", "codex", "pi"]} />),
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
  test("engines start collapsed; a deep link opens only the engine holding its row", () => {
    const render = (hash?: string) => renderToStaticMarkup(<ProvidersSection state={{ handleWriteAppSettings: async () => {}, availableProviders: PROVIDERS }} hash={hash} />)
    const collapsed = render()
    for (const id of ["claudeDefaults", "codexDefaults", "piDefaults"]) expect(collapsed).not.toContain(`id="${id}"`)
    expect(collapsed.match(/aria-expanded="false" aria-controls="engine-details-/g)?.length).toBe(3)
    const linked = render("#codexDefaults")
    expect(linked).toContain('id="codexDefaults"')
    expect(linked).not.toContain('id="claudeDefaults"')
    expect(linked).toContain('aria-expanded="true" aria-controls="engine-details-codex"')
  })
  test("memory-off dims and disables dependents with actionable reasons", () => {
    const html = memoryHtml({ enabled: false })
    expect(html).toContain('aria-label="Use Memory"')
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(5)
    expect(html.match(/Turn on Use Memory to change this./g)?.length).toBe(5)
    expect(html).toContain('href="/memory"')
  })
  test("learning-off only disables memory changes, keeping preview usable", () => {
    const html = memoryHtml({ learn: false })
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(1)
    expect(html).toContain("Turn on Learn From Chats to change this.")
  })
  test("control follows the two switches; automatic hides the per-turn review rows", () => {
    const html = memoryHtml({ control: "auto" })
    expect(html.indexOf('id="memoryLearn"')).toBeLessThan(html.indexOf('id="memoryControl"'))
    expect(html).toContain('aria-label="Control"')
    expect(html).toContain("The agent reads the memory index")
    for (const id of ["memoryPreview", "memoryAutoProceed", "memoryChanges"]) expect(html).not.toContain(`id="${id}"`)
    const review = memoryHtml()
    expect(review).toContain("You confirm memory changes")
    for (const id of ["memoryPreview", "memoryAutoProceed", "memoryChanges"]) expect(review).toContain(`id="${id}"`)
    expect(review.match(/aria-disabled="true"/g)).toBeNull()
    for (const keyword of ["automatic", "review each turn", "控制方式", "自动", "每轮确认"]) {
      expect(SETTINGS_ROWS.memoryControl.keywords).toContain(keyword)
    }
  })
})
