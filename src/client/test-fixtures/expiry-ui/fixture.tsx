import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { MemoryBoardLauncherProvider } from "../../app/memory/MemoryBoardLauncher"
import { MemoryBoardPage } from "../../app/MemoryBoardPage"
import { MemoryCard } from "../../components/memory/MemoryCard"
import { MemoryDetailPanel } from "../../components/memory/MemoryDetailPanel"
import { MemoryCandidateCard } from "../../components/messages/MemoryCandidatesMessage"
import { MemoryExpiredMessage } from "../../components/messages/MemoryExpiredMessage"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import { i18n } from "../../i18n"
import "./fixture.css"

await i18n.changeLanguage("en")
const base = {
  scope: "personal", type: "constraint", abstractionLevel: "concrete", sensitive: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1,
} as const
const items = [
  { ...base, id: "M-01", status: "candidate", content: "For now, use the synthetic cache.", expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() },
  { ...base, id: "M-02", status: "active", content: "Keep synthetic tests isolated.", expiresAt: new Date(Date.now() + 6 * 86400000 - 1000).toISOString() },
  { ...base, id: "M-03", status: "archived", content: "Use the temporary synthetic service.", expiresAt: "2020-01-01T00:00:00.000Z" },
  { ...base, id: "M-04", status: "archived", content: "Keep the temporary synthetic queue.", expiresAt: "2020-01-01T00:00:00.000Z" },
] as MemoryItem[]
useMemoryStore.setState({ items, status: "ready" })
const probe = new URLSearchParams(window.location.search).get("probe")
if (probe) useMemoryStore.setState({ items: [{ ...items[1]!, id: "M-01", expiresAt: null }], status: "ready" })

function Probe() {
  const current = useMemoryStore(state => state.items)
  return <MemoryRouter><MemoryBoardLauncherProvider onOpenMemoryBoard={() => {}}><TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
    <TranscriptRenderOptionsProvider value={{ readonly: probe === "readonly", ...(probe === "demo" ? { previewDemo: { reviseReply: "" } } : {}) }}>
      {probe === "detail" ? <section id="detail"><MemoryDetailPanel item={current[0]!} allItems={current}
        onUpdated={item => useMemoryStore.getState().upsertLocal(item)} onClose={() => {}} onAccept={async () => {}} onArchive={async () => {}} /></section>
        : <section id="receipt"><MemoryExpiredMessage message={{ id: "receipt", kind: "memory_expired", timestamp: new Date().toISOString(), ids: ["M-01"], turn: 2 }} /></section>}
    </TranscriptRenderOptionsProvider>
  </TranscriptChatContextProvider></MemoryBoardLauncherProvider></MemoryRouter>
}

function Fixture() {
  const current = useMemoryStore(state => state.items)
  return <MemoryRouter><MemoryBoardLauncherProvider onOpenMemoryBoard={() => {}}><TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <section id="candidate"><MemoryCandidateCard candidate={current.find(item => item.id === "M-01")!} /></section>
      <section id="card"><MemoryCard item={current.find(item => item.id === "M-02")!} variant="scoped" /></section>
      <section id="receipt"><MemoryExpiredMessage message={{ id: "receipt", kind: "memory_expired", timestamp: new Date().toISOString(), ids: ["M-03"], turn: 2 }} /></section>
      <section id="detail" className="h-[470px] overflow-hidden rounded-xl border"><MemoryDetailPanel item={current.find(item => item.id === "M-02")!} allItems={current} onUpdated={item => useMemoryStore.getState().upsertLocal(item)} onClose={() => {}} onAccept={async () => {}} onArchive={async () => {}} /></section>
      <section id="board" className="h-[700px] overflow-hidden rounded-xl border"><MemoryBoardPage overlay={{ chatId: "synthetic-chat", initialLens: "archived" }} /></section>
    </main>
  </TranscriptChatContextProvider></MemoryBoardLauncherProvider></MemoryRouter>
}

createRoot(document.getElementById("root")!).render(probe ? <Probe /> : <Fixture />)
