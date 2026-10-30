import { runMountedRaceSuite } from "../../test-utils/runMountedRaceSuite"

runMountedRaceSuite("terminal workspace lazy mounting", new URL("./TerminalWorkspaceShell.browser.ts", import.meta.url))
