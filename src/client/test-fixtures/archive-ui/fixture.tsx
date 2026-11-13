import { createRoot } from "react-dom/client"
import { useState } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { MemoryPreviewMessage } from "../../components/messages/MemoryPreviewMessage"
import { MemoryTraceMessage } from "../../components/messages/MemoryTraceMessage"
import { MemoryCitationChip } from "../../components/messages/shared"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { i18n } from "../../i18n"
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
const fixtureWindow = window as unknown as { archiveFixtureResponses: number }
fixtureWindow.archiveFixtureResponses = 0

function Fixture() {
  const [responses, setResponses] = useState(0)
  return (
    <TranscriptChatContextProvider value={{ chatId: "fixture-chat" }}>
      <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
        <section id="working-memory">
          <TranscriptRenderOptionsProvider value={remote ? {} : { previewDemo: { reviseReply: "Synthetic reply." } }}>
            <MemoryPreviewMessage message={preview} onRespond={() => { fixtureWindow.archiveFixtureResponses++; setResponses((count) => count + 1) }} />
          </TranscriptRenderOptionsProvider>
        </section>
        {remote ? <output id="response-count">{responses}</output> : null}
        <section id="audit"><MemoryTraceMessage message={trace} /></section>
        <section id="readonly"><TranscriptRenderOptionsProvider value={{ readonly: true }}><MemoryCitationChip id="M-01" /></TranscriptRenderOptionsProvider></section>
      </main>
    </TranscriptChatContextProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/chat/fixture-chat"]}>
    <Routes><Route path="/chat/:chatId" element={<Fixture />} /></Routes>
  </MemoryRouter>,
)
