import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { releasePackageNames, verifyReleaseAssets } from "./release-assets"

const version = "0.46.0"
const installer = `MemoSync-${version}-windows-x64-Setup.exe`
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function releaseFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "memosync-release-"))
  directories.push(directory)
  const packages = releasePackageNames(version)
  const entries = []
  for (const [index, name] of packages.entries()) {
    const bytes = Buffer.alloc(1_000_000 + index, index)
    await writeFile(path.join(directory, name), bytes)
    entries.push({ url: name, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length,
      ...(name.endsWith(".AppImage") ? { blockMapSize: 100 } : {}) })
  }
  for (const [name, files] of [
    ["latest.yml", entries.filter(entry => entry.url === installer)],
    ["latest-linux.yml", entries.filter(entry => entry.url.includes("-linux-"))],
  ] as const) {
    await writeFile(path.join(directory, name), Bun.YAML.stringify({ version, files, path: files[0]!.url, sha512: files[0]!.sha512 }))
  }
  await writeFile(path.join(directory, `${installer}.blockmap`), gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums: ["synthetic"], sizes: [1_000_006] }] })))
  return directory
}

async function changeMetadata(directory: string, filename: string, change: (metadata: any) => void) {
  const metadata = Bun.YAML.parse(await readFile(path.join(directory, filename), "utf8"))
  change(metadata)
  await writeFile(path.join(directory, filename), Bun.YAML.stringify(metadata))
}

describe("desktop release assets", () => {
  test("accepts all native packages and update feeds and checksums every asset", async () => {
    const directory = await releaseFixture()
    const result = await verifyReleaseAssets(directory, version)
    expect(result.files).toHaveLength(11)
    for (const name of result.files) {
      const digest = createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex")
      expect(result.checksums).toContain(`${digest}  ${name}\n`)
    }
  })

  test("refuses missing packages and unsigned macOS update feeds", async () => {
    const directory = await releaseFixture()
    await writeFile(path.join(directory, "latest-mac.yml"), "version: 0.46.0\n")
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("unexpected release assets")
    await rm(path.join(directory, "latest-mac.yml"))
    await rm(path.join(directory, installer))
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Incomplete")
  })

  test.each(["version", "sha512", "size"])("rejects stale metadata %s", async (field) => {
    const directory = await releaseFixture()
    await changeMetadata(directory, "latest.yml", metadata => {
      if (field === "version") metadata.version = "0.45.0"
      else metadata.files[0][field] = field === "size" ? 1 : "wrong-hash"
    })
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Invalid update metadata: latest.yml")
  })

  test("rejects a feed with a missing Debian package or duplicate asset", async () => {
    const directory = await releaseFixture()
    const original = await readFile(path.join(directory, "latest-linux.yml"), "utf8")
    await changeMetadata(directory, "latest-linux.yml", metadata => { metadata.files.pop() })
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Invalid update metadata: latest-linux.yml")
    await writeFile(path.join(directory, "latest-linux.yml"), original)
    await changeMetadata(directory, "latest-linux.yml", metadata => { metadata.files[1] = metadata.files[0] })
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Invalid update metadata: latest-linux.yml")
  })

  test("rejects altered packages even when names and lengths still match", async () => {
    const directory = await releaseFixture()
    const bytes = await readFile(path.join(directory, installer))
    bytes[10] = 255
    await writeFile(path.join(directory, installer), bytes)
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Invalid update metadata: latest.yml")
  })

  test("rejects legacy feed paths that bypass the checked file list", async () => {
    const directory = await releaseFixture()
    await changeMetadata(directory, "latest.yml", metadata => { metadata.path = "https://example.invalid/other.exe" })
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Invalid update metadata: latest.yml")
  })

  test("rejects a missing embedded blockmap size and a corrupt Windows blockmap", async () => {
    const directory = await releaseFixture()
    const original = await readFile(path.join(directory, "latest-linux.yml"), "utf8")
    await changeMetadata(directory, "latest-linux.yml", metadata => {
      delete metadata.files.find((entry: { url: string }) => entry.url.endsWith(".AppImage")).blockMapSize
    })
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow("Invalid update metadata: latest-linux.yml")
    await writeFile(path.join(directory, "latest-linux.yml"), original)
    await writeFile(path.join(directory, `${installer}.blockmap`), "truncated")
    await expect(verifyReleaseAssets(directory, version)).rejects.toThrow()
  })

  test("never emits stable update feeds for prerelease versions", () => {
    expect(() => releasePackageNames("0.47.0-beta.1")).toThrow("stable version")
  })
})
