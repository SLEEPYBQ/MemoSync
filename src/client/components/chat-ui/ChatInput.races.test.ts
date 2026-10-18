import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("mounted ChatInput submission races", new URL("./ChatInput.browser.ts", import.meta.url))
