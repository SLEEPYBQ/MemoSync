import { describe, expect, test } from "bun:test"
import { buildClaudeSystemAppend } from "./agent"

describe("participant-visible Browser guidance", () => {
  test("tells Claude how the participant actually opens and refreshes an app", () => {
    const guide = buildClaudeSystemAppend("")

    expect(guide).toContain("## Showing web apps in the participant's Browser panel")
    expect(guide).toContain("frontend port 3000 and backend port 3001")
    expect(guide).toContain("starts and stops that server automatically for every study condition")
    expect(guide).toContain("do not use `npm run dev`")
    expect(guide).toContain("Do not run a production build")
    expect(guide).toContain("Tests, lint, and `tsc --noEmit` remain available")
    expect(guide).toContain("rely on the managed server's hot reload")
    expect(guide).toContain("Use preview_status")
    expect(guide).toContain("use preview_restart")
    expect(guide).toContain("project-specific PostgreSQL database")
    expect(guide).toContain("Do not tell the participant to open `http://localhost:<port>`")
    expect(guide).toContain("press **Home** if needed")
    expect(guide).toContain("click the green server card belonging to the current project")
    expect(guide).toContain("relative URLs such as `/api`")
    expect(guide).toContain("configure the frontend dev server to proxy")
    expect(guide).toContain("Container-local success does not prove")
    expect(guide).toContain("press the Browser panel's **Refresh** button")
    expect(guide).toContain("If the participant reports a blank page")
    expect(guide).not.toContain("the preview updates on its own")
  })

  test("uses the identical blinding-safe Browser prefix with every condition's memory representation", () => {
    const guide = buildClaudeSystemAppend("")
    const conditionBlocks = [
      "<memory-system>MemoSync versioned pool</memory-system>",
      "# Unified Auto Memory\n- Complete current block",
      "# Static Markdown Memory\n- Complete current files",
    ]

    for (const memoryBlock of conditionBlocks) {
      expect(buildClaudeSystemAppend(memoryBlock)).toBe(`${guide}\n\n${memoryBlock}`)
    }

    expect(guide).not.toContain("MemoSync")
    expect(guide).not.toContain("Auto Memory")
    expect(guide).not.toContain("Static Markdown")
  })
})
