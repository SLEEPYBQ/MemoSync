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

test("a missing saved connection is actionable without rejecting or skipping the row", () => {
  const message: QueuedChatMessage = { id: "blocked", provider: "codex", content: "Fixture task", createdAt: 1, attachments: [], modelOptions: { connectionId: "B" } }
  const render = (connections?: { id: string }[]) => renderToStaticMarkup(
    <QueuedUserMessage message={message} connections={connections} onRemove={() => {}} onSendNow={() => {}} />,
  )
  expect(render([{ id: "A" }])).toContain(t("chat:queuedConnectionMissing"))
  expect(render([{ id: "A" }]).match(/<button/g)).toHaveLength(2)
  expect(render([{ id: "B" }])).not.toContain(t("chat:queuedConnectionMissing"))
  expect(render()).not.toContain(t("chat:queuedConnectionMissing")) // Snapshot hasn't arrived.
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

test("a rejected legacy command retains its input, attachments, and removal control", () => {
  const message: QueuedChatMessage = {
    id: "saved-command",
    rejection: "stale_native_command",
    content: "  /review *literal*",
    attachments: [{
      id: "file", kind: "image", displayName: "fixture.png", absolutePath: "/tmp/fixture.png",
      relativePath: "fixture.png", contentUrl: "/media/fixture.png", mimeType: "image/png", size: 64,
    }],
    createdAt: 100,
  }
  const html = renderToStaticMarkup(<QueuedUserMessage message={message} onRemove={() => undefined} onSendNow={() => undefined} />)
  expect(html).toContain(message.content)
  expect(html).toContain("fixture.png")
  expect(html).toContain(t("chat:staleQueuedNativeCommand"))
  expect(html).toContain(t("chat:removeQueuedMessage"))
  expect(html).not.toContain(t("chat:steerNow"))
})
