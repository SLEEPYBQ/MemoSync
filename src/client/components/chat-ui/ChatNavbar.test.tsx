import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatNavbar } from "./ChatNavbar"
import { TooltipProvider } from "../ui/tooltip"

describe("ChatNavbar", () => {
  test("gives the terminal toggle an accessible name and pressed state", () => {
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(ChatNavbar, {
        sidebarCollapsed: false,
        onOpenSidebar: () => {},
        onExpandSidebar: () => {},
        onNewChat: () => {},
        localPath: "/tmp/project",
        embeddedTerminalVisible: true,
        onToggleEmbeddedTerminal: () => {},
      })),
    )

    expect(html).toContain('aria-label="Toggle terminal"')
    expect(html).toContain('aria-pressed="true"')
  })
})
