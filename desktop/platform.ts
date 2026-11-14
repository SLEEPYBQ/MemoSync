export const REQUIRED_BUN_VERSION = "1.4.4"

/** Stage the runtime on the same OS/architecture as the Electron package. */
export function desktopTarget(platform: string = process.platform, arch: string = process.arch) {
  if (!((platform === "darwin" && ["arm64", "x64"].includes(arch))
    || (["win32", "linux"].includes(platform) && arch === "x64"))) {
    throw new Error(`Unsupported desktop target: ${platform}/${arch}`)
  }
  return {
    platform, arch,
    bunName: platform === "win32" ? "bun.exe" : "bun",
    builderFlag: platform === "darwin" ? "--mac" : platform === "win32" ? "--win" : "--linux",
  }
}

export function verifyNativeTarget(expectedPlatform?: string, expectedArch?: string) {
  const target = desktopTarget()
  if (expectedPlatform && expectedPlatform !== target.platform)
    throw new Error(`Native build platform mismatch: expected ${expectedPlatform}, got ${target.platform}`)
  if (expectedArch && expectedArch !== target.arch)
    throw new Error(`Native build architecture mismatch: expected ${expectedArch}, got ${target.arch}`)
  if (Bun.version !== REQUIRED_BUN_VERSION)
    throw new Error(`MemoSync packaging requires Bun ${REQUIRED_BUN_VERSION}, got ${Bun.version}`)
  return target
}
