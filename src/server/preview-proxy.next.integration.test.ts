import { test } from "bun:test"
import { runMountedRaceSuite as runIsolatedBrowserSuite } from "../client/test-utils/runMountedRaceSuite"

if (process.env.NEXT_PREVIEW_E2E === "1") {
  runIsolatedBrowserSuite("Next 15 App Router through the public preview path", new URL("./preview-proxy.next.integration.browser.ts", import.meta.url), { timeoutMs: 180_000, cwd: process.cwd() })
} else {
  test.skip("Next 15 App Router through the public preview path (NEXT_PREVIEW_E2E=1)", () => {})
}
