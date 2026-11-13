import { runMountedRaceSuite as runIsolatedBrowserSuite } from "../client/test-utils/runMountedRaceSuite"

runIsolatedBrowserSuite("opens the real standalone export offline with image and text previews, retaining HTTP fallback", new URL("./standalone-export.integration.browser.ts", import.meta.url), { cwd: process.cwd() })
