import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("file drift UI screenshots", new URL("./FileDrift.browser.ts", import.meta.url))
