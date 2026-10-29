import { runMountedRaceSuite } from "../test-utils/runMountedRaceSuite"

runMountedRaceSuite("mounted useAppState history races", new URL("./useAppState.browser.ts", import.meta.url))
