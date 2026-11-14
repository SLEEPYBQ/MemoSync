import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"
import desktopPkg from "./package.json"

if (!process.env.GITHUB_SHA || pkg.version !== desktopPkg.version) throw new Error("Release version/commit mismatch")
const version = pkg.version
const expected = [
  ...["arm64", "x64"].flatMap(arch => ["dmg", "zip"].map(ext => `MemoSync-${version}-macos-${arch}.${ext}`)),
  `MemoSync-${version}-windows-x64-Setup.exe`, `MemoSync-${version}-windows-x64.zip`,
  `MemoSync-${version}-linux-x64.AppImage`, `MemoSync-${version}-linux-x64.deb`,
].sort()
const directory = path.resolve("release-assets")
const files = (await readdir(directory)).sort()
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`Incomplete or unexpected release assets: ${files.join(", ")}`)
const checksums: string[] = []
for (const file of files) {
  const bytes = await readFile(path.join(directory, file))
  if (bytes.length < 1_000_000) throw new Error(`Unexpectedly small desktop package: ${file}`)
  checksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`)
}
await writeFile(path.join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`)
const notes = path.resolve(`docs/releases/v${version}.md`)
await readFile(notes)
const tag = Bun.spawnSync(["git", "ls-remote", "--tags", "origin", `refs/tags/v${version}`], { stdout: "pipe", stderr: "inherit" })
if (!tag.success) throw new Error("Could not verify release tag availability")
if (tag.stdout.toString().trim()) throw new Error("Release tag already exists; refusing to publish different packages under it")
const result = Bun.spawnSync(["gh", "release", "create", `v${version}`, "--target", process.env.GITHUB_SHA,
  "--title", `MemoSync v${version}`, "--notes-file", notes,
  ...[...files, "SHA256SUMS"].map(file => path.join(directory, file))], { stdout: "inherit", stderr: "inherit" })
if (!result.success) throw new Error("Release publication failed")
