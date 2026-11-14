import { runMountedRaceSuite as runIsolatedBrowserSuite } from "../client/test-utils/runMountedRaceSuite"

runIsolatedBrowserSuite("remote path preview contract", new URL("./preview-proxy.integration.browser.ts", import.meta.url), { cwd: process.cwd() })
