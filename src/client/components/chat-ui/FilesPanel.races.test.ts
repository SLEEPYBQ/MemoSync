import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("mounted FilesPanel draft races", new URL("./FilesPanel.browser.ts", import.meta.url))
