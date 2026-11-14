import { createRoot } from "react-dom/client"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { i18n } from "../../i18n"
import { MemoryBoardPage } from "../../app/MemoryBoardPage"
import { MarkdownSyncCard } from "../../components/memory/MarkdownSyncCard"
import { MemoryDetailPanel } from "../../components/memory/MemoryDetailPanel"
import { MemoryPreviewMessage } from "../../components/messages/MemoryPreviewMessage"
import { MemoryCitationChip } from "../../components/messages/shared"
import { TranscriptChatContextProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import "./fixture.css"

await i18n.changeLanguage("en")
const base = { scope: "project", projectId: "synthetic", type: "constraint", status: "active", abstractionLevel: "concrete",
  sensitive: false, createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 } as const
const changed: MemoryItem = { ...base, id: "M-01", content: "Validate requests in src/auth.ts.", fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }] }
const removed: MemoryItem = { ...base, id: "M-02", content: "Run the synthetic test before release.", fileRefs: [{ path: "AGENTS.md", kind: "source", drift: "line_removed" }] }
const missing: MemoryItem = { ...base, id: "M-03", content: "Use the synthetic release configuration.", fileRefs: [{ path: "config/release.ts", kind: "mention", drift: "missing" }] }
const multiple: MemoryItem = { ...base, id: "M-04", content: "Check the synthetic release pipeline.", fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }, { path: "config/release.ts", kind: "mention", drift: "missing" }] }
const boardItems = [changed, removed]
useMemoryStore.setState({ items: boardItems, status: "ready" })
const fixtureWindow = window as unknown as { fixtureBoardItems: MemoryItem[]; fixtureLanguage: (language: string) => Promise<unknown> }
fixtureWindow.fixtureBoardItems = boardItems
fixtureWindow.fixtureLanguage = language => i18n.changeLanguage(language)
const preview = {
  kind: "memory_preview", id: "preview-entry", previewId: "preview-1", timestamp: "2030-01-01T00:00:00.000Z",
  confirmationMode: "on_change", memories: [{ id: changed.id, content: changed.content, scope: changed.scope }],
  relevant: [{ id: changed.id, why: "Relevant synthetic task" }], expectedUses: [{ id: changed.id, expectedUse: "Validate the request." }],
  confirmationReasons: [{ id: changed.id, reason: "file_changed", version: 1, files: [{ path: "src/auth.ts", drift: "changed" }] }],
} as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>

function Detail({ initial }: { initial: MemoryItem }) {
  const [item, setItem] = useState(initial)
  return <MemoryDetailPanel item={item} allItems={[item]} onClose={() => {}} onUpdated={setItem} onAccept={async () => {}} onArchive={async () => {}} />
}

function Fixture() {
  return <MemoryRouter><TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-4">
      <section id="board" className="flex h-[740px] min-w-0"><MemoryBoardPage overlay={{ chatId: "synthetic-chat" }} /></section>
      <section id="changed" className="max-w-lg rounded-xl border bg-card"><Detail initial={changed} /></section>
      <section id="missing" className="max-w-lg rounded-xl border bg-card"><Detail initial={missing} /></section>
      <section id="removed" className="max-w-lg rounded-xl border bg-card"><Detail initial={removed} /></section>
      <section id="multiple" className="max-w-lg rounded-xl border bg-card"><Detail initial={multiple} /></section>
      <section id="preview" className="max-w-3xl"><MemoryPreviewMessage message={preview} onRespond={() => {}} /></section>
      <section id="citation" className="p-4"><MemoryCitationChip id="M-01" /></section>
      <section id="import" className="max-w-3xl rounded-xl border bg-card"><MarkdownSyncCard embedded /></section>
    </main>
  </TranscriptChatContextProvider></MemoryRouter>
}

createRoot(document.getElementById("root")!).render(<Fixture />)
