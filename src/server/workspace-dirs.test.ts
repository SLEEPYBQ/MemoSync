import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { listWorkspaceDirectories } from "./workspace-dirs"

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "memv2-dirs-"))
  mkdirSync(path.join(root, "projects", "shop"), { recursive: true })
  mkdirSync(path.join(root, "projects", "blog"), { recursive: true })
  mkdirSync(path.join(root, ".hidden"), { recursive: true })
  mkdirSync(path.join(root, "node_modules"), { recursive: true })
  return root
}

describe("listWorkspaceDirectories", () => {
  test("lists visible directories sorted, hiding dotfiles and node_modules", () => {
    const root = fixtureRoot()
    const snapshot = listWorkspaceDirectories(undefined, root)
    expect(snapshot.path).toBe(path.resolve(root))
    expect(snapshot.parent).toBeNull()
    expect(snapshot.dirs.map((d) => d.name)).toEqual(["projects"])
  })

  test("descends into subdirectories and reports a parent", () => {
    const root = fixtureRoot()
    const snapshot = listWorkspaceDirectories(path.join(root, "projects"), root)
    expect(snapshot.parent).toBe(path.resolve(root))
    expect(snapshot.dirs.map((d) => d.name)).toEqual(["blog", "shop"])
  })

  test("~ expands to the workspace root", () => {
    const root = fixtureRoot()
    const snapshot = listWorkspaceDirectories("~/projects", root)
    expect(snapshot.path).toBe(path.resolve(root, "projects"))
  })

  test("escape attempts clamp back to the root", () => {
    const root = fixtureRoot()
    for (const attempt of ["/etc", path.join(root, ".."), "../../.."]) {
      expect(listWorkspaceDirectories(attempt, root).path).toBe(path.resolve(root))
    }
  })

  test("unreadable paths fall back to the root instead of erroring", () => {
    const root = fixtureRoot()
    const snapshot = listWorkspaceDirectories(path.join(root, "projects", "missing"), root)
    expect(snapshot.path).toBe(path.resolve(root))
  })
})
