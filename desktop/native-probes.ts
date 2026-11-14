import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readSdkInstallation } from "../src/server/model-access/sdk-installation"

const directory = await mkdtemp(path.join(tmpdir(), "memosync-native-probes-"))
try {
  const claude = readSdkInstallation().bundledPaths[0]
  if (!claude) throw new Error("The native Claude probe requires the SDK's optional platform binary")
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true, dependencies: { "opencode-ai": "1.19.5" }, trustedDependencies: ["opencode-ai"] }))
  const install = Bun.spawnSync([process.execPath, "install", "--cwd", directory], { stdout: "inherit", stderr: "inherit" })
  if (!install.success) throw new Error("Could not install isolated OpenCode probe")
  const packageDir = path.join(directory, "node_modules", "opencode-ai")
  const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"))
  const opencode = path.resolve(packageDir, typeof metadata.bin === "string" ? metadata.bin : metadata.bin.opencode)
  const result = Bun.spawnSync([process.execPath, "test", "src/server/host-actions.native.test.ts"], {
    env: { ...process.env, MEMOSYNC_CLAUDE_TEST_BIN: claude, MEMOSYNC_OPENCODE_TEST_BIN: opencode },
    stdout: "inherit", stderr: "inherit",
  })
  if (!result.success) throw new Error("Native host-action probes failed")
} finally { await rm(directory, { recursive: true, force: true }) }
