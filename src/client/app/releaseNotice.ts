import { readLocalUiPreference, writeLocalUiPreference } from "../lib/localUiPreferences"
import { useCallback, useState } from "react"
import type { ReleaseNoticeSnapshot } from "../../shared/types"

export const DISMISSED_RELEASE_STORAGE_KEY = "memosync:dismissed-release"

export interface ReleaseNoticeView {
  version: string
  url: string
}

/** The release to point at, or null. A dismissed version stays hidden until a newer one ships. */
export function getReleaseNotice(
  snapshot: ReleaseNoticeSnapshot | null | undefined,
  dismissedVersion: string | null = null,
): ReleaseNoticeView | null {
  if (!snapshot?.latestVersion || !snapshot.releaseUrl) return null
  if (snapshot.latestVersion === dismissedVersion) return null
  return { version: snapshot.latestVersion, url: snapshot.releaseUrl }
}

export function useDismissedRelease() {
  const [dismissedVersion, setDismissedVersion] = useState(() => readLocalUiPreference(DISMISSED_RELEASE_STORAGE_KEY))
  const dismiss = useCallback((version: string) => {
    setDismissedVersion(version)
    writeLocalUiPreference(DISMISSED_RELEASE_STORAGE_KEY, version)
  }, [])
  return { dismissedVersion, dismiss }
}
