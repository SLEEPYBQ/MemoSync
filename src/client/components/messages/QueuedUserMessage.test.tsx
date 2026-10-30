import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { QueuedChatMessage } from "../../../shared/types"
import { t } from "../../i18n"
import { QueuedUserMessage } from "./QueuedUserMessage"

describe("QueuedUserMessage", () => {
  test("renders queued message content left aligned inside the bubble", () => {
    const message: QueuedChatMessage = {
      id: "queued-1",
      content: "Queued follow-up",
      attachments: [],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued follow-up")
    expect(html).toContain("text-left")
    expect(html).not.toContain("text-right")
  })
})


for (const kind of ["text-only", "attachment-only", "mixed"] as const) {
  test(`${kind} queued message exposes exactly one send and remove control`, () => {
    const message: QueuedChatMessage = {
      id: "queued-controls",
      content: kind === "attachment-only" ? "" : "https://example.com/" + "a".repeat(500),
      attachments: kind === "text-only" ? [] : [{
        id: "attachment-1", kind: "image", displayName: "screenshot.png", absolutePath: "/tmp/screenshot.png",
        relativePath: "screenshot.png", contentUrl: "/media/screenshot.png", mimeType: "image/png", size: 1024,
      }],
      createdAt: 100,
    }
    const html = renderToStaticMarkup(<QueuedUserMessage message={message} onRemove={() => undefined} onSendNow={() => undefined} />)
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain(`aria-label="${t("chat:steerNow")}"`)
    expect(html).toContain(`aria-label="${t("chat:removeQueuedMessage")}"`)
    if (kind !== "text-only") expect(html).toContain("screenshot.png")
    if (kind === "attachment-only") expect(html).toContain(t("chat:queued"))
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]")
    expect(html).toContain("[overflow-wrap:anywhere]")
  })
}
