import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { PROVIDERS, type LocalProjectsSnapshot } from "../../shared/types"
import { resolveConditionPolicy, type ExperimentConditionName } from "../../server/experiment/condition"
import { LandingProjectMenu, LocalDevContent } from "./LocalDev"

const emptySnapshot: LocalProjectsSnapshot = {
  machine: {
    id: "local",
    displayName: "Study workspace",
    platform: "linux",
  },
  projects: [],
}

function renderEmptyLanding(condition: ExperimentConditionName | "") {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(LocalDevContent, {
      connectionStatus: "connected",
      ready: true,
      snapshot: emptySnapshot,
      commandError: null,
      newProjectOpen: false,
      onNewProjectOpenChange: () => undefined,
      onCreateProject: async () => undefined,
      onSend: async () => undefined,
      availableProviders: PROVIDERS,
      projectIdByPath: {},
      conditionPolicy: resolveConditionPolicy(condition),
    }),
  ))
}

function projectPickerOpeningTag(html: string) {
  const labelOffset = html.indexOf("No project yet")
  expect(labelOffset).toBeGreaterThan(-1)
  const buttonOffset = html.lastIndexOf("<button", labelOffset)
  return html.slice(buttonOffset, html.indexOf(">", buttonOffset) + 1)
}

describe("LocalDev project picker", () => {
  for (const condition of ["auto", "static", "memosync"] as const) {
    test(`${condition} removes project creation and switching from the study landing page`, () => {
      const html = renderEmptyLanding(condition)

      expect(html).toContain("Open the active task assignment to begin")
      expect(html).toContain("Open current assignment")
      expect(html).not.toContain("Add project")
      expect(html).not.toContain("No project yet")
      expect(html).not.toContain("<textarea")
    })
  }

  test("keeps the normal project picker actionable outside the study", () => {
    const html = renderEmptyLanding("")

    expect(projectPickerOpeningTag(html)).not.toContain("disabled")
    expect(html).toContain("Add a project")
  })

  test("lists every project and keeps Add project as the final menu action", () => {
    const html = renderToStaticMarkup(createElement(LandingProjectMenu, {
      projectPaths: ["/root/MemoSync/car", "/root/MemoSync/apartment"],
      selectedPath: "/root/MemoSync/car",
      onPickPath: () => undefined,
      onAddProject: () => undefined,
    }))

    expect(html).toContain("car")
    expect(html).toContain("/root/MemoSync/car")
    expect(html).toContain("apartment")
    expect(html).toContain("/root/MemoSync/apartment")
    expect(html.indexOf("apartment")).toBeLessThan(html.indexOf("Add project…"))
  })
})
