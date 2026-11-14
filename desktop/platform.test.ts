import { expect, test } from "bun:test"
import { desktopTarget, verifyNativeTarget } from "./platform"

test("packages only native supported targets and rejects cross-platform runtime staging", () => {
  expect(desktopTarget("win32", "x64").bunName).toBe("bun.exe")
  expect(desktopTarget("linux", "x64").builderFlag).toBe("--linux")
  expect(desktopTarget("darwin", "x64").arch).toBe("x64")
  expect(desktopTarget("darwin", "arm64").arch).toBe("arm64")
  expect(() => desktopTarget("win32", "ia32")).toThrow("Unsupported")
  expect(() => verifyNativeTarget(process.platform === "win32" ? "linux" : "win32")).toThrow("platform mismatch")
  expect(() => verifyNativeTarget(process.platform, process.arch === "x64" ? "arm64" : "x64")).toThrow("architecture mismatch")
})
