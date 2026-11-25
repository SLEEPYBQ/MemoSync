import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"

export function releasePackageNames(version: string): string[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Desktop releases require a stable version")
  return [
    ...["arm64", "x64"].flatMap(arch => ["dmg", "zip"].map(ext => `MemoSync-${version}-macos-${arch}.${ext}`)),
    `MemoSync-${version}-windows-x64-Setup.exe`, `MemoSync-${version}-windows-x64.zip`,
    `MemoSync-${version}-linux-x64.AppImage`, `MemoSync-${version}-linux-x64.deb`,
  ].sort()
}

type FileDigest = { size: number; sha256: string; sha512: string }

async function digestFile(file: string): Promise<FileDigest> {
  const sha256 = createHash("sha256")
  const sha512 = createHash("sha512")
  let size = 0
  for await (const chunk of createReadStream(file)) {
    size += chunk.length
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function verifyUpdateMetadata(value: unknown, name: string, version: string, expected: string[], digests: Map<string, FileDigest>) {
  const fail = () => { throw new Error(`Invalid update metadata: ${name}`) }
  if (!record(value) || value.version !== version || !Array.isArray(value.files)) return fail()
  const entries = value.files
  if (entries.length !== expected.length) return fail()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!record(entry) || typeof entry.url !== "string" || !expected.includes(entry.url) || seen.has(entry.url)) return fail()
    seen.add(entry.url)
    const actual = digests.get(entry.url)!
    if (entry.sha512 !== actual.sha512 || entry.size !== actual.size) return fail()
    if (entry.url.endsWith(".AppImage") && (!Number.isSafeInteger(entry.blockMapSize)
      || (entry.blockMapSize as number) <= 0 || (entry.blockMapSize as number) >= actual.size - 4)) return fail()
  }
  if (typeof value.path !== "string" || !seen.has(value.path) || value.sha512 !== digests.get(value.path)?.sha512) return fail()
}

/** Match the outputs of electron-builder 26: NSIS has a sidecar blockmap;
 * AppImage embeds its map and shares latest-linux.yml with the Debian package.
 * macOS feeds are intentionally excluded until we ship consistently signed apps. */
export async function verifyReleaseAssets(directory: string, version: string) {
  const packages = releasePackageNames(version)
  const installer = `MemoSync-${version}-windows-x64-Setup.exe`
  const blockmap = `${installer}.blockmap`
  const expected = [...packages, blockmap, "latest.yml", "latest-linux.yml"].sort()
  const files = (await readdir(directory)).sort()
  if (JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error(`Incomplete or unexpected release assets: ${files.join(", ")}`)

  const digests = new Map<string, FileDigest>()
  for (const file of files) {
    const filePath = path.join(directory, file)
    const stat = await lstat(filePath)
    if (!stat.isFile()) throw new Error(`Not a release asset file: ${file}`)
    if (packages.includes(file) && stat.size < 1_000_000) throw new Error(`Unexpectedly small desktop package: ${file}`)
    if (!packages.includes(file) && (stat.size === 0 || stat.size > 10_000_000)) throw new Error(`Invalid update sidecar: ${file}`)
    digests.set(file, await digestFile(filePath))
  }

  for (const [name, assets] of [
    ["latest.yml", [installer]],
    ["latest-linux.yml", [`MemoSync-${version}-linux-x64.AppImage`, `MemoSync-${version}-linux-x64.deb`]],
  ] as const) {
    const metadata = Bun.YAML.parse(await readFile(path.join(directory, name), "utf8"))
    verifyUpdateMetadata(metadata, name, version, [...assets], digests)
  }

  // A missing/truncated blockmap would make every Windows differential download fail.
  const map = JSON.parse(gunzipSync(await readFile(path.join(directory, blockmap)), { maxOutputLength: 10_000_000 }).toString("utf8"))
  if (!record(map) || map.version !== "2" || !Array.isArray(map.files) || map.files.length === 0)
    throw new Error(`Invalid update blockmap: ${blockmap}`)

  return {
    files,
    checksums: `${files.map(file => `${digests.get(file)!.sha256}  ${file}`).join("\n")}\n`,
  }
}
