import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryBoardLauncherProvider } from "../../app/memory/MemoryBoardLauncher"
import { MemoryExpiredMessage } from "./MemoryExpiredMessage"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "./render-context"

test("expiry receipt shows citations and omits live board controls in readonly", () => {
  const render = (readonly: boolean) => renderToStaticMarkup(
    <MemoryBoardLauncherProvider onOpenMemoryBoard={() => {}}>
      <TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
        <TranscriptRenderOptionsProvider value={{ readonly }}>
          <MemoryExpiredMessage message={{ id: "receipt", kind: "memory_expired", timestamp: "2030-01-01T00:00:00.000Z", ids: ["M-01", "M-02"], turn: 2 }} />
        </TranscriptRenderOptionsProvider>
      </TranscriptChatContextProvider>
    </MemoryBoardLauncherProvider>,
  )
  const live = render(false)
  expect(live).toContain("2 memories expired since your last turn")
  expect(live).toContain("[M-01]")
  expect(live).toContain("View archived")
  const readonly = render(true)
  expect(readonly).toContain("[M-02]")
  expect(readonly).not.toContain("View archived")
})
