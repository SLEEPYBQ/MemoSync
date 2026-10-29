import { formatNumber, t, useI18n } from "../../i18n"
import { ExternalLink, Loader2, Search, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import type {
  InstalledSkillSummary,
  InstalledSkillsSnapshot,
  SkillInstallResult,
  SkillSearchResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../../../shared/types"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import { SETTINGS_LIST_CARD_CLASS, SettingsActionButton } from "./shared"

function formatInstallCount(count: number) {
  return t("settings:installCount", { count, countFormatted: formatNumber(Math.max(0, count), { notation: "compact", maximumFractionDigits: 1 }) })
}

function SkillErrorBlock({ message }: { message: string }) {
  useI18n()
  return (
    <pre
      className="max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive"
    >
      {message}
    </pre>
  )
}

function InstalledSkillCard({
  skill,
  uninstalling,
  onUninstall,
}: {
  skill: InstalledSkillSummary
  uninstalling: boolean
  onUninstall: () => void
}) {
  useI18n()
  const href = skill.source ? `https://skills.sh/${skill.source}/${skill.name}` : null

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
        <div className="truncate text-xs text-muted-foreground">{skill.source || t("settings:unknownSource")}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={t("settings:viewValue0OnSkillsSh", { v0: skill.name })}
            className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}
        <button
          type="button"
          aria-label={t("settings:uninstallValue0", { v0: skill.name })}
          disabled={uninstalling}
          onClick={onUninstall}
          className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
        >
          {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

function SkillResultCard({
  skill,
  installing,
  installed,
  message,
  onInstall,
}: {
  skill: SkillSearchResult
  installing: boolean
  installed: boolean
  message?: string
  onInstall: () => void
}) {
  useI18n()
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.source} · {formatInstallCount(skill.installs)}
        </div>
        {installed && message ? <div className="mt-1 truncate text-xs text-primary">{message}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`https://skills.sh/${skill.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label={t("settings:viewValue0OnSkillsSh", { v0: skill.name })}
          className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <SettingsActionButton disabled={installing || installed} onClick={onInstall}>
          {installing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {installed ? t("settings:installed") : installing ? t("settings:installing") : t("settings:get")}
        </SettingsActionButton>
      </div>
    </div>
  )
}

export function SkillsSection({ state }: { state: Pick<AppState, "connectionStatus" | "socket"> }) {
  useI18n()
  const socket = state.socket
  const connectionStatus = state.connectionStatus
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillSummary[]>([])
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(() => new Set())
  const [installedLoading, setInstalledLoading] = useState(false)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [uninstallingSkillId, setUninstallingSkillId] = useState<string | null>(null)
  const [installMessages, setInstallMessages] = useState<Record<string, string>>({})

  async function loadInstalledSkills() {
    if (connectionStatus !== "connected") {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(null)
      setInstalledLoading(false)
      return
    }

    try {
      setInstalledLoading(true)
      setInstalledError(null)
      const snapshot = await socket.command<InstalledSkillsSnapshot>({ type: "skills.listInstalled" })
      setInstalledSkills(snapshot.skills)
      setInstalledSkillIds(new Set(snapshot.skills.map((skill) => skill.name)))
    } catch (error) {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(error instanceof Error ? error.message : t("settings:unableToReadInstalledSkills"))
    } finally {
      setInstalledLoading(false)
    }
  }

  useEffect(() => {
    void loadInstalledSkills()
  }, [connectionStatus, socket])

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      setResults([])
      setSearchError(null)
      setSearchLoading(false)
      return
    }

    if (connectionStatus !== "connected") {
      setResults([])
      setSearchLoading(false)
      setSearchError(t("settings:backendConnectionRequired"))
      return
    }

    let cancelled = false
    setSearchLoading(true)
    setSearchError(null)

    const timeout = window.setTimeout(() => {
      void socket
        .command<SkillSearchSnapshot>({
          type: "skills.search",
          query: normalizedQuery,
          limit: 100,
        })
        .then((snapshot) => {
          if (cancelled) return
          setResults(snapshot.skills)
        })
        .catch((error) => {
          if (cancelled) return
          setResults([])
          setSearchError(error instanceof Error ? error.message : t("settings:unableToSearchSkills"))
        })
        .finally(() => {
          if (cancelled) return
          setSearchLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [connectionStatus, query, socket])

  async function installSkill(skill: SkillSearchResult) {
    if (connectionStatus !== "connected") {
      setOperationError(t("settings:backendConnectionRequired"))
      return
    }

    try {
      setInstallingSkillId(skill.id)
      setOperationError(null)
      setInstallMessages((current) => {
        const next = { ...current }
        delete next[skill.id]
        return next
      })
      await socket.command<SkillInstallResult>({
        type: "skills.install",
        source: skill.source,
        skillId: skill.skillId,
      })
      setInstalledSkillIds((current) => new Set(current).add(skill.skillId))
      setInstallMessages((current) => ({
        ...current,
        [skill.id]: t("settings:installedGlobally"),
      }))
      void loadInstalledSkills()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : t("settings:installFailed"))
    } finally {
      setInstallingSkillId(null)
    }
  }

  async function uninstallSkill(skill: InstalledSkillSummary) {
    if (connectionStatus !== "connected") {
      setOperationError(t("settings:backendConnectionRequired"))
      return
    }

    try {
      setUninstallingSkillId(skill.name)
      setOperationError(null)
      await socket.command<SkillUninstallResult>({
        type: "skills.uninstall",
        skillId: skill.name,
      })
      setInstalledSkills((current) => current.filter((installedSkill) => installedSkill.name !== skill.name))
      setInstalledSkillIds((current) => {
        const next = new Set(current)
        next.delete(skill.name)
        return next
      })
      setInstallMessages((current) => {
        const next = { ...current }
        for (const key of Object.keys(next)) {
          if (key.endsWith(`/${skill.name}`) || key === skill.name) {
            delete next[key]
          }
        }
        return next
      })
      void loadInstalledSkills()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : t("settings:uninstallFailed"))
    } finally {
      setUninstallingSkillId(null)
    }
  }

  return (
    <div className="space-y-8">
      {operationError ? <SkillErrorBlock message={operationError} /> : null}
      <section
        id={SETTINGS_ROWS.installedSkills.id}
        data-settings-row
        className="space-y-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">{t("settings:installed")}</div>
          {installedLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
        </div>
        {installedError ? <div className="text-xs text-destructive">{installedError}</div> : null}
        {installedSkills.length > 0 ? (
          <div className={SETTINGS_LIST_CARD_CLASS}>
            {installedSkills.map((skill) => (
              <InstalledSkillCard
                key={`${skill.source}/${skill.name}`}
                skill={skill}
                uninstalling={uninstallingSkillId === skill.name}
                onUninstall={() => {
                  void uninstallSkill(skill)
                }}
              />
            ))}
          </div>
        ) : !installedLoading ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t("settings:noGlobalSkillsInstalled")}</div>
        ) : null}
      </section>

      {(
        <section
          id={SETTINGS_ROWS.discoverSkills.id}
          data-settings-row
          className="space-y-2"
        >
          <div className="text-sm font-medium text-foreground">{t("settings:discover")}</div>
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card/30 px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings:searchSkills")}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <button
                type="button"
                aria-label={t("settings:clearSkillsSearch")}
                onClick={() => setQuery("")}
                className="touch-manipulation inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {searchLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
          </div>
          {searchError ? <div className="text-xs text-destructive">{searchError}</div> : null}
          <div className={SETTINGS_LIST_CARD_CLASS}>
            {results.map((skill) => (
              <SkillResultCard
                key={skill.id}
                skill={skill}
                installing={installingSkillId === skill.id}
                installed={installedSkillIds.has(skill.skillId)}
                message={installMessages[skill.id]}
                onInstall={() => {
                  void installSkill(skill)
                }}
              />
            ))}
          </div>
          {!searchLoading && !searchError && query.trim().length >= 2 && results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t("settings:noSkillsFound")}</div>
          ) : null}
        </section>
      )}
    </div>
  )
}
