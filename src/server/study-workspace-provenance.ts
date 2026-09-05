import { lstatSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export interface StudyWorkspaceTemplateFingerprint {
  fileCount: number
  totalBytes: number
  aggregateSha256: string
}

export const CANONICAL_FULLSTACK_STARTER_FINGERPRINT: StudyWorkspaceTemplateFingerprint = {
  fileCount: 43,
  totalBytes: 72_305,
  aggregateSha256: "96982157b7b420ad7a0c4c7958e07b656d6c999fc7364c441f74a345f6c8a11a",
}

export const STUDY_WORKSPACE_PROVENANCE_FILE = ".memosync-study-workspace.json"
export const STUDY_WORKSPACE_PROVENANCE_DIR = ".memosync-study-provenance"

export function hasCanonicalFullStackStarterFingerprint(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const fingerprint = value as Record<string, unknown>
  const expected = CANONICAL_FULLSTACK_STARTER_FINGERPRINT
  return fingerprint.fileCount === expected.fileCount
    && fingerprint.totalBytes === expected.totalBytes
    && fingerprint.aggregateSha256 === expected.aggregateSha256
}

export function assertValidStudyWorkspaceProvenance(provenancePath: string, projectId: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(provenancePath, "utf8"))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Study workspace provenance is unreadable at ${provenancePath}: ${detail}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Study workspace provenance is invalid at ${provenancePath}`)
  }
  const provenance = parsed as Record<string, unknown>
  if (
    provenance.schemaVersion !== 1
    || provenance.kind !== "memosync.fullstack-bench-starter"
    || provenance.projectId !== projectId
    || typeof provenance.initializedAt !== "string"
    || !hasCanonicalFullStackStarterFingerprint(provenance.starter)
  ) {
    throw new Error(`Study workspace provenance is invalid at ${provenancePath}`)
  }
}

/** Fail-closed readiness probe shared by server boot and provisioning tests. */
export function studyWorkspaceStarterReady(localPath: string, projectId: string): boolean {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(projectId) || projectId.includes("..")) return false
    const target = resolve(localPath)
    if (basename(target) !== projectId) return false
    const info = lstatSync(target)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    assertValidStudyWorkspaceProvenance(
      join(dirname(target), STUDY_WORKSPACE_PROVENANCE_DIR, `${projectId}.json`),
      projectId,
    )
    return true
  } catch {
    return false
  }
}
