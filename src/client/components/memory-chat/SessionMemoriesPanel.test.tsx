import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryBoardLauncherProvider } from "../../app/study/MemoryBoardLauncher"
import { SessionMemoriesPanel } from "./SessionMemoriesPanel"

describe("SessionMemoriesPanel", () => {
  test("exposes the approved Board entry as visible text, not an icon-only affordance", () => {
    const html = renderToStaticMarkup(
      <MemoryBoardLauncherProvider onOpenMemoryBoard={() => undefined}>
        <SessionMemoriesPanel chatId="guide-chat" messages={[]} exposureInitiator="system" />
      </MemoryBoardLauncherProvider>,
    )
    expect(html).toContain("Go to Memory Board")
    expect(html).toContain('data-go-to-memory-board="true"')
    expect(html).toContain('data-memory-board-source="memory_record"')
    expect(html).not.toContain("disabled=\"\"")
  })
})
