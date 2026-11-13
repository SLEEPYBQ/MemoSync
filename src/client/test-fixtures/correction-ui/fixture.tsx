import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { MemoryTraceMessage } from "../../components/messages/MemoryTraceMessage"
import { MemoryCard } from "../../components/memory/MemoryCard"
import { MemoryDetailPanel } from "../../components/memory/MemoryDetailPanel"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { i18n } from "../../i18n"
import "./fixture.css"

await i18n.changeLanguage("en")
const item = {
  id: "M-07", content: "Use integer cents for all amounts.", scope: "personal", type: "constraint", status: "active",
  abstractionLevel: "concrete", sensitive: false, createdAt: "", updatedAt: "", usageCount: 6,
  reinforcedCount: 0, citedInCurrentSession: 0, version: 1, lastTraceLabel: "not_applicable", lastTraceCorrected: true,
} as MemoryItem
useMemoryStore.setState({ items: [item], status: "ready" })
const trace = {
  kind: "memory_trace", id: "trace", timestamp: new Date().toISOString(), turn: 1, status: "ok",
  labels: [{ id: item.id, label: "violated", cause: "not_followed", note: "The response used decimal amounts." }],
} as Extract<HydratedTranscriptMessage, { kind: "memory_trace" }>
const corrected = { ...trace, id: "corrected", labels: [{ ...trace.labels[0]!, userLabel: "not_applicable" as const, userNote: "No monetary amounts were produced." }] }
type Correction = { label: typeof trace.labels[number]["label"] | null; note?: string }
declare global {
  interface Window {
    correctionFixture: {
      item: MemoryItem
      publish: (correction: Correction | null) => void
      setReadonly: (readonly: boolean) => void
      setStatus: (status: "active" | "archived") => void
    }
  }
}

function Fixture() {
  const [correction, setCorrection] = useState<Correction | null>(null)
  const [readonly, setReadonly] = useState(false)
  const currentItem = useMemoryStore(state => state.items.find(value => value.id === item.id) ?? item)
  window.correctionFixture = {
    item,
    publish: setCorrection,
    setReadonly,
    setStatus: status => useMemoryStore.getState().upsertLocal({ ...useMemoryStore.getState().items.find(value => value.id === item.id)!, status }),
  }
  useEffect(() => {
    void fetch("/api/fixture-correction").then(response => response.json()).then(result => setCorrection(result.data))
  }, [])
  const liveTrace = { ...trace, labels: trace.labels.map(label => correction?.label
    ? { ...label, userLabel: correction.label, ...(correction.note ? { userNote: correction.note } : {}) }
    : label) }
  return (
    <MemoryRouter><TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
      <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
        <section id="editor"><TranscriptRenderOptionsProvider value={{ readonly }}><MemoryTraceMessage message={liveTrace} /></TranscriptRenderOptionsProvider></section>
        <section id="corrected"><MemoryTraceMessage message={corrected} /></section>
        <section id="detail" className="rounded-xl border border-border bg-card"><MemoryDetailPanel item={currentItem} allItems={[currentItem]} onClose={() => {}} onUpdated={() => {}} onAccept={async () => {}} onArchive={async () => {}} /></section>
        <section id="board"><MemoryCard item={currentItem} variant="scoped" /></section>
      </main>
    </TranscriptChatContextProvider></MemoryRouter>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
