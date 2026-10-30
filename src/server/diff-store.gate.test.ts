import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile, rename, utimes, symlink, unlink } from "node:fs/promises"
import { DiffStore } from "./diff-store"

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status) throw new Error(error)
  return out.trim()
}

test("diff poll gate skips unchanged repos but observes dirty edits, atomic saves, symlinks, refs, config and worktrees", async () => {
  const dir = await mkdtemp("/tmp/memosync-diff-gate-")
  const worktree = `${dir}-worktree`
  const store = new DiffStore(dir)
  try {
    await git(dir, "init", "-b", "main")
    await git(dir, "config", "user.name", "Test")
    await git(dir, "config", "user.email", "test@example.com")
    await writeFile(`${dir}/file.txt`, "base\n")
    await symlink("file.txt", `${dir}/link`)
    await git(dir, "add", ".")
    await git(dir, "commit", "-m", "base")
    await store.refreshSnapshot("project", dir)
    expect(await store.refreshSnapshot("project", dir)).toBe(false)
    expect(store.lastRefreshSkipped).toBe(true)
    const freshEquals = async (id = "project", cwd = dir) => {
      const fresh = new DiffStore(dir)
      await fresh.refreshSnapshot(id, cwd)
      expect(store.getProjectSnapshot(id)).toEqual(fresh.getProjectSnapshot(id))
    }
    await writeFile(`${dir}/file.txt`, "dirty\n")
    expect(await store.refreshSnapshot("project", dir)).toBe(true)
    await store.refreshSnapshot("project", dir)
    expect(store.lastRefreshSkipped).toBe(true)
    await writeFile(`${dir}/replacement`, "other\n")
    await utimes(`${dir}/replacement`, new Date(0), new Date(0))
    await rename(`${dir}/replacement`, `${dir}/file.txt`)
    expect(await store.refreshSnapshot("project", dir)).toBe(true)
    await freshEquals()
    await unlink(`${dir}/link`)
    await symlink("missing-target", `${dir}/link`)
    expect(await store.refreshSnapshot("project", dir)).toBe(true)
    await freshEquals()
    await git(dir, "add", ".")
    await git(dir, "commit", "-m", "update")
    await git(dir, "tag", "nested/tag")
    await git(dir, "config", "remote.origin.url", "https://github.com/example/changed.git")
    expect(await store.refreshSnapshot("project", dir)).toBe(true)
    await freshEquals()
    await git(dir, "worktree", "add", "-b", "feature/nested", worktree)
    await store.refreshSnapshot("worktree", worktree)
    await store.refreshSnapshot("worktree", worktree)
    expect(store.lastRefreshSkipped).toBe(true)
    await git(dir, "tag", "shared-tag")
    await store.refreshSnapshot("worktree", worktree)
    expect(store.lastRefreshSkipped).toBe(false)
    await freshEquals("worktree", worktree)
    await mkdir(`${dir}/nested`)
    await git(`${dir}/nested`, "init")
    await writeFile(`${dir}/nested/file.txt`, "nested content")
    await store.refreshSnapshot("project", dir)
    await store.refreshSnapshot("project", dir)
    expect(store.lastRefreshSkipped).toBe(false)
  } finally { await rm(worktree, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }) }
}, 30_000)
