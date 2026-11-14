import { t } from "../i18n"
import type { MemoryItem } from "./memoriesApi"

export type DriftedFile = { path: string; drift: "changed" | "missing" | "line_removed" }

export function driftedFileRefs(item: MemoryItem) {
  return (item.fileRefs ?? []).filter((ref): ref is typeof ref & DriftedFile => ref.drift !== null)
}

export function fileBasename(path: string): string {
  return path.split("/").at(-1) || path
}

export function fileDriftSummary(refs: readonly DriftedFile[]): string | null {
  if (!refs.length) return null
  const paths = [...new Set(refs.map(ref => ref.path))]
  if (paths.length > 1) return t("memory:fileDriftSeveral", { count: paths.length })
  const ref = refs.find(value => value.drift === "line_removed") ?? refs[0]!
  const name = fileBasename(ref.path)
  return t(ref.drift === "line_removed" ? "memory:fileDriftLineRemoved" : ref.drift === "missing" ? "memory:fileDriftMissing" : "memory:fileDriftChanged", { name })
}

export function fileDriftLabel(item: MemoryItem): string | null {
  const summary = fileDriftSummary(driftedFileRefs(item))
  return summary ? t("memory:fileCheckLabel", { summary }) : null
}
