import { runMountedRaceSuite } from "../test-utils/runMountedRaceSuite"
runMountedRaceSuite("model access mounted UI and screenshots", new URL("./modelAccess.browser.ts", import.meta.url))
