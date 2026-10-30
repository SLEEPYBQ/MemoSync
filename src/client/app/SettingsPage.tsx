import { translateUiText } from "../i18n/uiText"
import { t, useI18n } from "../i18n"
import { useEffect, useMemo, useState } from "react"
import { Info, Loader2, LogOut, Menu, Search, X } from "lucide-react"
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom"
import { getKeybindingsFilePathDisplay, SDK_CLIENT_APP, SELF_UPDATE_ENABLED } from "../../shared/branding"
import { getResolvedKeybindings } from "../lib/keybindings"
import { cn } from "../lib/utils"
import { useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import type { AppState } from "./useAppState"
import { ALL_SETTINGS_ROWS, SETTINGS_NAV_GROUPS, SETTINGS_ROWS, SETTINGS_SECTIONS as sidebarItems, getSettingsRowHref, resolveSettingsSectionId } from "./settings/registry"
import { GeneralSection } from "./settings/GeneralSection"
import { MemorySection } from "./settings/MemorySection"
import { ProvidersSection } from "./settings/ProvidersSection"
import { KeybindingsSection } from "./settings/KeybindingsSection"
import { SkillsSection } from "./settings/SkillsSection"
import {
  ChangelogSection,
  loadChangelog,
  resetSettingsPageChangelogCache,
  type ChangelogStatus,
  type GithubRelease,
} from "./settings/ChangelogSection"
import { getKeybindingsSubtitle, SettingsActionButton, SettingsGroup, SettingsGroups, SettingsRow } from "./settings/shared"
import { useSettingsRowHashScroll } from "./settings/useSettingsRowHashScroll"

export { resolveSettingsSectionId } from "./settings/registry"
export {
  ChangelogSection,
  fetchGithubReleases,
  formatPublishedDate,
  getCachedChangelog,
  loadChangelog,
  resetSettingsPageChangelogCache,
  setCachedChangelog,
} from "./settings/ChangelogSection"
export { SkillsSection } from "./settings/SkillsSection"
export { getKeybindingsSubtitle, shouldPreviewChatSoundChange } from "./settings/shared"

/** The command template row exists only for the custom editor; send other presets to the picker that enables it. */
function searchTarget(row: (typeof ALL_SETTINGS_ROWS)[number]) {
  return row.id === SETTINGS_ROWS.editorCommandTemplate.id && useTerminalPreferencesStore.getState().editorPreset !== "custom"
    ? SETTINGS_ROWS.defaultEditor
    : row
}

export function SettingsPage() {
  const activeLanguage = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const { sectionId } = useParams<{ sectionId: string }>()
  const state = useOutletContext<AppState>()
  const [changelogStatus, setChangelogStatus] = useState<ChangelogStatus>("idle")
  const [signingOut, setSigningOut] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [releases, setReleases] = useState<GithubRelease[]>([])
  const [changelogError, setChangelogError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const selectedPage = resolveSettingsSectionId(sectionId) ?? "general"
  const isConnecting = state.connectionStatus === "connecting" || !state.localProjectsReady
  const machineName = state.localProjects?.machine.displayName ?? t("common:unavailable")
  const projectCount = state.localProjects?.projects.length ?? 0
  const appVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const keybindingsFilePathDisplay = resolvedKeybindings.filePathDisplay || getKeybindingsFilePathDisplay()
  useSettingsRowHashScroll(location.hash, !isConnecting, selectedPage)
  useEffect(() => {
    if (!sectionId) return
    if (resolveSettingsSectionId(sectionId)) return
    navigate("/settings/general", { replace: true })
  }, [navigate, sectionId])

  useEffect(() => {
    let cancelled = false

    void fetch("/auth/status", {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) return { enabled: false }
        return (await response.json()) as { enabled?: boolean }
      })
      .then((payload) => {
        if (cancelled) return
        setAuthEnabled(payload.enabled === true)
      })
      .catch(() => {
        if (cancelled) return
        setAuthEnabled(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!SELF_UPDATE_ENABLED || selectedPage !== "changelog" || isConnecting) return

    let cancelled = false
    setChangelogStatus("loading")
    setChangelogError(null)

    void loadChangelog()
      .then((nextReleases) => {
        if (cancelled) return
        setReleases(nextReleases)
        setChangelogStatus("success")
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setChangelogError(error instanceof Error ? error.message : t("settings:unableToLoadChangelog"))
        setChangelogStatus("error")
      })

    return () => {
      cancelled = true
    }
  }, [isConnecting, selectedPage])

  function retryChangelog() {
    if (!SELF_UPDATE_ENABLED) return
    resetSettingsPageChangelogCache()
    setChangelogStatus("loading")
    setChangelogError(null)

    void loadChangelog({ force: true })
      .then((nextReleases) => {
        setReleases(nextReleases)
        setChangelogStatus("success")
      })
      .catch((error: unknown) => {
        setChangelogError(error instanceof Error ? error.message : t("settings:unableToLoadChangelog"))
        setChangelogStatus("error")
      })
  }

  const selectedSection = sidebarItems.find((item) => item.id === selectedPage) ?? sidebarItems[0]
  const selectedSectionSubtitle =
    selectedPage === "keybindings" ? getKeybindingsSubtitle(keybindingsFilePathDisplay) : selectedSection.subtitle
  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return ALL_SETTINGS_ROWS.filter((row) =>
      [row.title, row.description, ...(row.keywords ?? [])].some((text) => text.toLowerCase().includes(needle)),
    ).slice(0, 12)
    // Labels are getters over the active language; recompute when it changes.
  }, [query, activeLanguage])

  async function handleSidebarSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      await state.handleSignOut()
    } finally {
      setSigningOut(false)
    }
  }

  const navItemClass = (active: boolean) => cn(
    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors [&_svg]:size-[15px] [&_svg]:shrink-0",
    active
      ? "bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]"
      : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]",
  )

  return (
    <div className="relative flex h-full flex-1 min-w-0 bg-background">
      <div className="flex min-w-0 flex-1">
        {/* Settings navigation: its own column against a hairline, so the
            space between it and the centred content reads as layout, not a gap. */}
        <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border/60 md:flex">
          <div className="px-3 pb-2 pt-3">
            <div className="px-2.5 pb-3 text-[15px] font-semibold tracking-[-0.01em] text-foreground">{t("common:settings")}</div>
            <label className="flex h-8 items-center gap-2 rounded-lg bg-black/[0.045] px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-focus/40 dark:bg-white/[0.07]">
              <Search className="size-3.5 shrink-0" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") setQuery("") }}
                placeholder={t("settings:searchSettings")}
                aria-label={t("settings:searchSettings")}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              {query ? (
                <button type="button" aria-label={t("common:close")} onClick={() => setQuery("")} className="cursor-pointer text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              ) : null}
            </label>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {query.trim() ? (
              searchResults.length ? (
                <div className="space-y-0.5 pt-2">
                  {searchResults.map((row) => {
                    const section = sidebarItems.find((item) => item.id === row.sectionId)
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => { setQuery(""); navigate(getSettingsRowHref(searchTarget(row))) }}
                        className="flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      >
                        <span className="text-[13px] text-foreground">{row.title}</span>
                        <span className="text-[11.5px] text-muted-foreground">{section?.label}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="px-2.5 pt-3 text-[12.5px] text-muted-foreground">{t("settings:noSettingsMatch", { query: query.trim() })}</div>
              )
            ) : (
              SETTINGS_NAV_GROUPS.map((group) => {
                const items = sidebarItems.filter((item) => item.group === group.id)
                if (!items.length) return null
                return (
                  <div key={group.id} className="pt-4 first:pt-2">
                    <div className="px-2.5 pb-1 text-[11.5px] font-medium text-muted-foreground/75">{group.label}</div>
                    <div className="space-y-px">
                      {items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={item.id === selectedPage ? "page" : undefined}
                          onClick={() => navigate(`/settings/${item.id}`)}
                          className={navItemClass(item.id === selectedPage)}
                        >
                          <item.icon />
                          <span className="truncate">{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })
            )}
          </nav>
          {authEnabled ? (
            <div className="border-t border-border/60 px-3 py-3">
              <button
                type="button"
                onClick={() => { void handleSidebarSignOut() }}
                disabled={signingOut}
                className={cn(navItemClass(false), "disabled:cursor-not-allowed disabled:opacity-50")}
              >
                <LogOut />
                <span>{signingOut ? t("settings:signingOut") : t("settings:signOut")}</span>
              </button>
            </div>
          ) : null}
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="border-b border-border py-2 md:hidden">
            <div className="overflow-x-auto pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex min-w-max items-center gap-2">
                <div className=" sticky left-0 bg-gradient-to-r from-background via-background/80 to-transparent px-2  py-1">
                  <button
                    type="button"
                    onClick={state.openSidebar}
                    className="flex shrink-0 items-center p-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    aria-label={t("settings:openSidebar")}
                    title={t("settings:openSidebar")}
                  >
                    <Menu className="h-4 w-4 shrink-0" />
                  </button>
                </div>
                {sidebarItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => navigate(`/settings/${item.id}`)}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      item.id === selectedPage
                        ? "border-transparent bg-muted font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                ))}
                {authEnabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSidebarSignOut()
                    }}
                    disabled={signingOut}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{signingOut ? t("settings:signingOut") : t("settings:signOut")}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="w-full px-5 pb-24 pt-8 md:px-10 md:pt-14">
            {isConnecting ? (
              <div
                className="flex min-h-[240px] items-center justify-center rounded-2xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground"
              >
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t("settings:loadingMachineSettings")}</span>
                </div>
              </div>
            ) : (
              <div className="@container mx-auto max-w-[760px]">
                <div className="px-1 pb-8">
                  <div className="flex min-h-[34px] items-center justify-between gap-4">
                    <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-foreground">
                      {selectedSection.label}
                    </h1>
                    {selectedPage === "general" && SELF_UPDATE_ENABLED ? (
                      <SettingsActionButton onClick={() => navigate("/settings/changelog")}>
                        {t("settings:checkForUpdates")}</SettingsActionButton>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">{selectedSectionSubtitle}</p>
                </div>

                {selectedPage === "general" || selectedPage === "appearance" || selectedPage === "notifications" ? (
                  <GeneralSection state={state} appVersion={appVersion} part={selectedPage} />
                ) : selectedPage === "about" ? (
                  <SettingsGroups>
                    {SELF_UPDATE_ENABLED ? <GeneralSection state={state} appVersion={appVersion} part="about" /> : null}
                    <SettingsGroup>
                      <SettingsRow title={t("settings:aboutVersion")} description={null}>
                        <span className="font-mono text-[13px] tabular-nums text-muted-foreground">{appVersion}</span>
                      </SettingsRow>
                      <SettingsRow title={t("settings:aboutMachine")} description={null}>
                        <span className="text-[13px] text-muted-foreground">{machineName}</span>
                      </SettingsRow>
                      <SettingsRow title={t("settings:aboutServer")} description={null}>
                        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                          <span className={cn("size-1.5 rounded-full", state.connectionStatus === "connected" ? "bg-success" : state.connectionStatus === "connecting" ? "bg-cand-dot" : "bg-destructive")} />
                          {t(({ connecting: "settings:connectingLabel", connected: "settings:connectedLabel", disconnected: "settings:disconnectedLabel" } as const)[state.connectionStatus])}
                        </span>
                      </SettingsRow>
                      <SettingsRow title={t("settings:aboutProjects")} description={null}>
                        <span className="text-[13px] tabular-nums text-muted-foreground">{projectCount}</span>
                      </SettingsRow>
                    </SettingsGroup>
                    <p className="px-1 text-[12.5px] text-muted-foreground">{t("settings:aboutLicense")}</p>
                  </SettingsGroups>
                ) : selectedPage === "memory" ? (
                  <MemorySection state={state} />
                ) : selectedPage === "providers" ? (
                  <ProvidersSection state={state} hash={location.hash} />
                ) : selectedPage === "keybindings" ? (
                  <KeybindingsSection state={state} />
                ) : selectedPage === "skills" ? (
                  <SkillsSection state={state} />
                ) : (
                  <ChangelogSection
                    status={changelogStatus}
                    releases={releases}
                    error={translateUiText(changelogError)}
                    onRetry={retryChangelog}
                    updateSnapshot={state.updateSnapshot}
                    currentVersion={appVersion}
                    onInstallUpdate={() => {
                      void state.handleInstallUpdate()
                    }}
                    onCheckForUpdates={() => {
                      void state.handleCheckForUpdates({ force: true })
                    }}
                  />
                )}
              </div>
            )}

            {state.commandError ? (
              <div
                className="mx-auto mt-4 flex max-w-4xl items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{state.commandError}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

    </div>
  )
}
