import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * Directory listing for the Add Project path picker. The app runs in a
 * container ("the workspace machine"), so a bare text field reads like a
 * local-computer path and confuses participants (pilot feedback 2026-08-11)
 * — the picker browses the REMOTE filesystem instead.
 *
 * Containment: requests never escape `root` (the workspace home). Hidden
 * directories and node_modules are noise for project selection and are
 * skipped. Unreadable paths clamp back to the root rather than erroring.
 */
export interface WorkspaceDirsSnapshot {
  root: string
  path: string
  /** null at the root — the picker hides its ".." entry there. */
  parent: string | null
  dirs: Array<{ name: string; path: string }>
}

const SKIPPED_NAMES = new Set(["node_modules", "__pycache__"])

function expandHome(value: string, root: string): string {
  if (value === "~") return root
  if (value.startsWith("~/")) return path.join(root, value.slice(2))
  return value
}

export function listWorkspaceDirectories(requestedPath?: string, root: string = homedir()): WorkspaceDirsSnapshot {
  const resolvedRoot = path.resolve(root)
  const requested = requestedPath?.trim()
    ? path.resolve(expandHome(requestedPath.trim(), resolvedRoot))
    : resolvedRoot
  const contained =
    requested === resolvedRoot || requested.startsWith(resolvedRoot + path.sep) ? requested : resolvedRoot

  let target = contained
  let names: string[]
  try {
    names = readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_NAMES.has(entry.name))
      .map((entry) => entry.name)
  } catch {
    target = resolvedRoot
    try {
      names = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_NAMES.has(entry.name))
        .map((entry) => entry.name)
    } catch {
      names = []
    }
  }

  names.sort((a, b) => a.localeCompare(b))
  return {
    root: resolvedRoot,
    path: target,
    parent: target === resolvedRoot ? null : path.dirname(target),
    dirs: names.map((name) => ({ name, path: path.join(target, name) })),
  }
}
