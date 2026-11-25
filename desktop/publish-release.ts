import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"
import desktopPkg from "./package.json"
import { verifyReleaseAssets } from "./release-assets"

if (!process.env.GITHUB_SHA || pkg.version !== desktopPkg.version) throw new Error("Release version/commit mismatch")
const version = pkg.version
const directory = path.resolve("release-assets")
const { files, checksums } = await verifyReleaseAssets(directory, version)
await writeFile(path.join(directory, "SHA256SUMS"), checksums)
const notes = path.resolve(`docs/releases/v${version}.md`)
await readFile(notes)
const tag = Bun.spawnSync(["git", "ls-remote", "--tags", "origin", `refs/tags/v${version}`], { stdout: "pipe", stderr: "inherit" })
if (!tag.success) throw new Error("Could not verify release tag availability")
if (tag.stdout.toString().trim()) throw new Error("Release tag already exists; refusing to publish different packages under it")
const result = Bun.spawnSync(["gh", "release", "create", `v${version}`, "--target", process.env.GITHUB_SHA,
  "--title", `MemoSync v${version}`, "--notes-file", notes,
  ...[...files, "SHA256SUMS"].map(file => path.join(directory, file))], { stdout: "inherit", stderr: "inherit" })
if (!result.success) throw new Error("Release publication failed")
