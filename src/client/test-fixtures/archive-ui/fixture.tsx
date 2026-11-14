import { createRoot } from "react-dom/client"
import { useState } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { MemoryPreviewMessage } from "../../components/messages/MemoryPreviewMessage"
import { MemoryTraceMessage } from "../../components/messages/MemoryTraceMessage"
import { MemoryCitationChip } from "../../components/messages/shared"
import { useArchiveMemory } from "../../components/memory/archiveMemory"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { i18n } from "../../i18n"
import { MemoryBoardLauncherProvider, resolveMemoryBoardLaunchRequest, type ResolvedMemoryBoardLaunchRequest } from "../../app/memory/MemoryBoardLauncher"
import { MemoryBoardOverlay } from "../../app/memory/MemoryBoardOverlay"
import "./fixture.css"

await i18n.changeLanguage("en")

const items = [
  { id: "M-01", content: "Keep amounts in integer cents.", status: "archived" },
  { id: "M-02", content: "Validate each charge before submission.", status: "active" },
  { id: "M-03", content: "Record a synthetic receipt.", status: "active" },
].map((item) => ({
  ...item, scope: "personal", type: "constraint", abstractionLevel: "concrete", sensitive: false,
  createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
})) as MemoryItem[]
useMemoryStore.setState({ items, status: "ready" })

const preview = {
  kind: "memory_preview", id: "preview-entry", previewId: "preview-1", timestamp: new Date().toISOString(),
  memories: items.map(({ id, content, scope }) => ({ id, content, scope })),
  relevant: items.slice(0, 2).map(({ id }) => ({ id, why: "Relevant to this synthetic task." })),
  expectedUses: items.map(({ id }) => ({ id, expectedUse: "Apply this rule to the task." })),
} as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>
const trace = {
  kind: "memory_trace", id: "trace-entry", timestamp: new Date().toISOString(),
  labels: [
    { id: "M-01", label: "violated", cause: "not_followed", note: "A synthetic response used decimal values.", cited: true },
    { id: "M-02", label: "operational", note: "The synthetic response validated the charge.", cited: true },
  ],
} as Extract<HydratedTranscriptMessage, { kind: "memory_trace" }>

const remote = new URLSearchParams(window.location.search).has("remote")
const fixtureWindow = window as unknown as {
  archiveFixtureResponses: number
  archiveFixtureItems: MemoryItem[]
  archiveFixturePublish: () => void
}
fixtureWindow.archiveFixtureResponses = 0
fixtureWindow.archiveFixtureItems = items
fixtureWindow.archiveFixturePublish = () => useMemoryStore.setState({
  items: items.map(item => item.id === "M-03" ? { ...item, content: "Refreshed synthetic receipt." } : item),
  status: "ready",
})

function MutationControls() {
  const first = useArchiveMemory("chat_citation")
  const second = useArchiveMemory("chat_gate")
  const pending = useMemoryStore(state => state.pendingArchiveIds)
  return <section id="mutation-controls">
    <button onClick={() => void first.archive("M-02").catch(() => {})}>First archive</button>
    <button onClick={() => void second.archive("M-02").catch(() => {})}>Second archive</button>
    <button onClick={() => void first.restore("M-02").catch(() => {})}>First undo</button>
    <button onClick={() => void second.archive("M-03").catch(() => {})}>Other archive</button>
    <output id="pending-m02">{pending["M-02"] ?? 0}</output>
    <output id="pending-m03">{pending["M-03"] ?? 0}</output>
    <output id="first-error">{first.error}</output>
  </section>
}

function Fixture() {
  const [responses, setResponses] = useState(0)
  const [boardRequest, setBoardRequest] = useState<ResolvedMemoryBoardLaunchRequest | null>(null)
  const location = useLocation()
  return (
    <TranscriptChatContextProvider value={{ chatId: "fixture-chat" }}>
      <MemoryBoardLauncherProvider onOpenMemoryBoard={(request) => setBoardRequest(resolveMemoryBoardLaunchRequest(request, "fixture-chat"))}>
      {boardRequest ? <MemoryBoardOverlay chatId={boardRequest.chatId} memoryId={boardRequest.memoryId} focusedReview={boardRequest.focusedReview} onClose={() => setBoardRequest(null)} /> : null}
      <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
        <section id="board-citations">
          <MemoryCitationChip id="M-02" />{" "}<MemoryCitationChip id="M-01" />
          <input aria-label="Synthetic chat draft" defaultValue="Keep this draft" />
          <output id="fixture-chat-location">{location.pathname}</output>
        </section>
        <section id="working-memory">
          <TranscriptRenderOptionsProvider value={remote ? {} : { previewDemo: { reviseReply: "Synthetic reply." } }}>
            <MemoryPreviewMessage message={preview} onRespond={() => { fixtureWindow.archiveFixtureResponses++; setResponses((count) => count + 1) }} />
          </TranscriptRenderOptionsProvider>
        </section>
        {remote ? <output id="response-count">{responses}</output> : null}
        {remote ? <MutationControls /> : null}
        <section id="audit"><MemoryTraceMessage message={trace} /></section>
        <section id="readonly"><TranscriptRenderOptionsProvider value={{ readonly: true }}><MemoryCitationChip id="M-01" /></TranscriptRenderOptionsProvider></section>
      </main>
      </MemoryBoardLauncherProvider>
      <section id="unavailable"><MemoryCitationChip id="M-02" /></section>
    </TranscriptChatContextProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/chat/fixture-chat"]}>
    <Routes><Route path="/chat/:chatId" element={<Fixture />} /></Routes>
  </MemoryRouter>,
)
