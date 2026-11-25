import { runMountedRaceSuite } from "../test-utils/runMountedRaceSuite"

runMountedRaceSuite("mounted question and git races", new URL("./questionGit.browser.ts", import.meta.url))
