import { describe, expect, test } from "bun:test"
import {
  getDataDir,
  getDataDirDisplay,
  getDataRootName,
  getKeybindingsFilePath,
  getKeybindingsFilePathDisplay,
  getRuntimeProfile,
} from "./branding"

describe("runtime profile helpers", () => {
  test("defaults to the prod profile when unset", () => {
    expect(getRuntimeProfile({})).toBe("prod")
    expect(getDataRootName({})).toBe(".memosync")
    expect(getDataDir("/tmp/home", {})).toBe("/tmp/home/.memosync/data")
    expect(getDataDirDisplay({})).toBe("~/.memosync/data")
    expect(getKeybindingsFilePath("/tmp/home", {})).toBe("/tmp/home/.memosync/keybindings.json")
    expect(getKeybindingsFilePathDisplay({})).toBe("~/.memosync/keybindings.json")
  })

  test("switches to dev paths for the dev profile", () => {
    const env = { MEMOSYNC_RUNTIME_PROFILE: "dev" }

    expect(getRuntimeProfile(env)).toBe("dev")
    expect(getDataRootName(env)).toBe(".memosync-dev")
    expect(getDataDir("/tmp/home", env)).toBe("/tmp/home/.memosync-dev/data")
    expect(getDataDirDisplay(env)).toBe("~/.memosync-dev/data")
    expect(getKeybindingsFilePath("/tmp/home", env)).toBe("/tmp/home/.memosync-dev/keybindings.json")
    expect(getKeybindingsFilePathDisplay(env)).toBe("~/.memosync-dev/keybindings.json")
  })
})
