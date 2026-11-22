import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("desktop update controls", new URL("./DesktopUpdateSection.browser.ts", import.meta.url))
