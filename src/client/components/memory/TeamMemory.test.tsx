import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("team memory UI and screenshots", new URL("./TeamMemory.browser.ts", import.meta.url))
