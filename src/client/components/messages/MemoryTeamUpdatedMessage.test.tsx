import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryBoardLauncherProvider } from "../../app/memory/MemoryBoardLauncher"
import { MemoryTeamUpdatedMessage } from "./MemoryTeamUpdatedMessage"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "./render-context"

test("team notice shows nonzero counts, citations and a live-only Board link", () => {
  const render = (readonly: boolean) => renderToStaticMarkup(
    <MemoryBoardLauncherProvider onOpenMemoryBoard={() => {}}>
      <TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
        <TranscriptRenderOptionsProvider value={{ readonly }}>
          <MemoryTeamUpdatedMessage message={{ id: "team", kind: "memory_team_updated", timestamp: "2030-01-01T00:00:00.000Z", added: ["M-01"], changed: ["M-02"], removed: ["M-03"], turn: 2 }} />
        </TranscriptRenderOptionsProvider>
      </TranscriptChatContextProvider>
    </MemoryBoardLauncherProvider>,
  )
  expect(render(false)).toContain("Team memory updated · 1 new · 1 changed · 1 removed")
  expect(render(false)).toContain("[M-03]")
  expect(render(false)).toContain(">View</button>")
  expect(render(true)).not.toContain(">View</button>")
})
