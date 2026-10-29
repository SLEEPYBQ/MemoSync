import { t, useI18n, getLocale } from "../../i18n"
import { DownloadCloud } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import type { UpdateSnapshot } from "../../../shared/types"
import { markdownComponents } from "../../components/messages/shared"
import { cn } from "../../lib/utils"
import { SettingsActionButton, SettingsBadge, SettingsNotice, SettingsPlaceholder } from "./shared"

// Point this at your fork's releases endpoint before enabling SELF_UPDATE_ENABLED.
const GITHUB_RELEASES_URL = "https://api.github.com/repos/OWNER/MemoSync/releases"
const CHANGELOG_CACHE_TTL_MS = 5 * 60 * 1000

export type GithubRelease = {
  id: number
  name: string | null
  tag_name: string
  html_url: string
  published_at: string | null
  body: string | null
  prerelease: boolean
  draft: boolean
}

export type ChangelogStatus = "idle" | "loading" | "success" | "error"

type ChangelogCache = {
  expiresAt: number
  releases: GithubRelease[]
}

type FetchReleases = (input: string, init?: RequestInit) => Promise<Response>

let changelogCache: ChangelogCache | null = null
export function resetSettingsPageChangelogCache() {
  changelogCache = null
}

export async function fetchGithubReleases(fetchImpl: FetchReleases = fetch): Promise<GithubRelease[]> {
  const response = await fetchImpl(GITHUB_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  })
  if (!response.ok) {
    throw new Error(t("settings:githubReleasesRequestFailedWithStatusValue0", { v0: response.status }))
  }

  const payload = await response.json() as GithubRelease[]
  return payload.filter((release) => !release.draft)
}

export function getCachedChangelog() {
  if (!changelogCache) return null
  if (Date.now() >= changelogCache.expiresAt) {
    changelogCache = null
    return null
  }
  return changelogCache.releases
}

export function setCachedChangelog(releases: GithubRelease[]) {
  changelogCache = {
    releases,
    expiresAt: Date.now() + CHANGELOG_CACHE_TTL_MS,
  }
}

export async function loadChangelog(options?: { force?: boolean; fetchImpl?: FetchReleases }) {
  const cached = options?.force ? null : getCachedChangelog()
  if (cached) {
    return cached
  }

  const releases = await fetchGithubReleases(options?.fetchImpl)
  setCachedChangelog(releases)
  return releases
}

export function formatPublishedDate(value: string | null) {
  if (!value) return t("settings:unpublished")

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return t("settings:unknownDate")

  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed)
}

function GitHubIcon({ className }: { className?: string }) {
  useI18n()
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.649.5.5 5.649.5 12A11.5 11.5 0 0 0 8.36 22.04c.575.106.785-.25.785-.556 0-.274-.01-1-.015-1.962-3.181.691-3.853-1.532-3.853-1.532-.52-1.322-1.27-1.674-1.27-1.674-1.038-.71.08-.695.08-.695 1.148.08 1.752 1.178 1.752 1.178 1.02 1.748 2.676 1.243 3.328.95.103-.738.399-1.243.725-1.53-2.54-.289-5.211-1.27-5.211-5.65 0-1.248.446-2.27 1.177-3.07-.118-.288-.51-1.45.112-3.024 0 0 .96-.307 3.145 1.173A10.91 10.91 0 0 1 12 6.03c.973.004 1.954.132 2.87.387 2.182-1.48 3.14-1.173 3.14-1.173.625 1.573.233 2.736.115 3.024.734.8 1.175 1.822 1.175 3.07 0 4.39-2.676 5.358-5.224 5.642.41.353.776 1.05.776 2.117 0 1.528-.014 2.761-.014 3.136 0 .309.207.668.79.555A11.502 11.502 0 0 0 23.5 12C23.5 5.649 18.351.5 12 .5Z" />
    </svg>
  )
}

export function ChangelogSection({
  status,
  releases,
  error,
  onRetry,
  updateSnapshot,
  currentVersion,
  onInstallUpdate,
  onCheckForUpdates,
}: {
  status: ChangelogStatus
  releases: GithubRelease[]
  error: string | null
  onRetry: () => void
  updateSnapshot: UpdateSnapshot | null
  currentVersion: string
  onInstallUpdate: () => void
  onCheckForUpdates: () => void
}) {
  useI18n()
  const latestVersion = updateSnapshot?.latestVersion ?? releases[0]?.tag_name ?? t("common:unknown")
  const currentVersionLabel = updateSnapshot?.currentVersion ?? currentVersion
  const isChecking = updateSnapshot?.status === "checking"
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const canInstallUpdate = updateSnapshot?.updateAvailable === true
  const normalizedLatestVersion = latestVersion.replace(/^v/i, "")
  const normalizedCurrentVersion = currentVersionLabel.replace(/^v/i, "")

  return (
    <div className="space-y-4">
      {status === "loading" || status === "idle" ? (
        <SettingsPlaceholder loading>{t("settings:loadingReleaseNotes")}</SettingsPlaceholder>
      ) : null}

      {status === "error" ? (
        <SettingsNotice>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="font-medium">{t("settings:couldNotLoadChangelog")}</div>
              <div className="mt-0.5 text-muted-foreground">
                {error ?? t("settings:unableToLoadChangelog")}
              </div>
            </div>
            <SettingsActionButton onClick={onRetry}>{t("common:retry")}</SettingsActionButton>
          </div>
        </SettingsNotice>
      ) : null}

      {status === "success" && releases.length === 0 ? (
        <SettingsPlaceholder>
          {t("settings:githubDidNotReturnAnyPublishedReleasesForThisRepository")}</SettingsPlaceholder>
      ) : null}

      {SELF_UPDATE_ENABLED && !canInstallUpdate && status === "success" ? (
        <div className="flex justify-end">
          <SettingsActionButton
            onClick={onCheckForUpdates}
            disabled={isChecking || isUpdating}
          >
            {isChecking ? "Checking…" : t("settings:checkForUpdates")}
          </SettingsActionButton>
        </div>
      ) : null}

      {status === "success" && releases.length > 0 ? (
        releases.map((release) => {
          const normalizedTag = release.tag_name.replace(/^v/i, "")
          const isLatestRelease = normalizedTag === normalizedLatestVersion
          const isCurrentRelease = normalizedTag === normalizedCurrentVersion

          return (
            <article
              key={release.id}
              className={cn(
                "rounded-2xl border border-border px-4 py-4",
                isLatestRelease ? "bg-muted" : "bg-card/40"
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h3 className="text-base font-semibold tracking-[-0.2px] text-foreground">
                    {release.name?.trim() || release.tag_name}
                  </h3>
                  <span className="text-sm text-muted-foreground">{formatPublishedDate(release.published_at)}</span>
                  {isCurrentRelease ? <SettingsBadge>{t("settings:current")}</SettingsBadge> : null}
                  {release.prerelease ? <SettingsBadge>{t("settings:prerelease")}</SettingsBadge> : null}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={release.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("settings:viewReleaseOnGitHub")}
                    className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <GitHubIcon className="h-4 w-4" />
                  </a>

                  {SELF_UPDATE_ENABLED && isLatestRelease && canInstallUpdate ? (
                    <SettingsActionButton
                      prominent
                      onClick={onInstallUpdate}
                      disabled={isUpdating}
                      icon={<DownloadCloud />}
                    >
                      {isUpdating ? "Updating…" : t("common:update")}
                    </SettingsActionButton>
                  ) : null}
                </div>
              </div>

              {release.body?.trim() ? (
                <div className="prose prose-sm mt-4 max-w-none text-foreground dark:prose-invert">
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {release.body}
                  </Markdown>
                </div>
              ) : (
                <div className="mt-4 text-sm text-muted-foreground">{t("settings:noReleaseNotesWereProvided")}</div>
              )}
            </article>
          )
        })
      ) : null}
    </div>
  )
}
