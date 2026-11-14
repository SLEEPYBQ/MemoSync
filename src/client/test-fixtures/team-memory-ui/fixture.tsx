import { createRoot } from "react-dom/client"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { i18n } from "../../i18n"
import { MemoryBoardPage } from "../../app/MemoryBoardPage"
import { MemoryBoardLauncherProvider } from "../../app/memory/MemoryBoardLauncher"
import { MemoryCard } from "../../components/memory/MemoryCard"
import { MemoryDetailPanel } from "../../components/memory/MemoryDetailPanel"
import { MemoryPreviewMessage } from "../../components/messages/MemoryPreviewMessage"
import { MemoryCheckupGate } from "../../components/messages/MemoryCheckupGate"
import { MemoryTeamUpdatedMessage } from "../../components/messages/MemoryTeamUpdatedMessage"
import { MemoryCitationChip } from "../../components/messages/shared"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import type { MemoryItem } from "../../lib/memoriesApi"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import "./fixture.css"

await i18n.changeLanguage("en")
const base = { scope: "project", projectId: "synthetic", type: "constraint", status: "active", abstractionLevel: "concrete",
  sensitive: false, createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 } as const
const team: MemoryItem = { ...base, id: "M-01", content: "Validate requests in src/auth.ts.", team: { id: "T-a123" },
  fileRefs: [{ path: "src/auth.ts", kind: "mention", drift: "changed" }] }
const second: MemoryItem = { ...base, id: "M-02", content: "Run the synthetic suite before release.", version: 3, team: { id: "T-b234" } }
const ordinary: MemoryItem = { ...base, id: "M-03", content: "Document the synthetic deployment procedure." }
const detailed: MemoryItem = { ...base, id: "M-06", content: "Run synthetic checks.", detail: "Extra synthetic detail." }
const noPath: MemoryItem = { ...base, id: "M-05", projectId: "no-path", content: "A synthetic rule without a local project." }
const off: MemoryItem = { ...team, id: "M-04", status: "archived", content: "Keep a synthetic change log.", fileRefs: [] }
useMemoryStore.setState({ items: [team, second, ordinary, off], status: "ready" })
const fixtureWindow = window as unknown as { fixtureLanguage: (language: string) => Promise<unknown>; fixtureLaunches: unknown[] }
fixtureWindow.fixtureLanguage = language => i18n.changeLanguage(language)
fixtureWindow.fixtureLaunches = []
const preview = {
  kind: "memory_preview", id: "preview-entry", previewId: "preview-1", timestamp: "2030-01-01T00:00:00.000Z",
  confirmationMode: "on_change",
  memories: [{ id: team.id, content: team.content, scope: team.scope }, { id: second.id, content: second.content, scope: second.scope }],
  relevant: [{ id: team.id, why: "Relevant synthetic task" }, { id: second.id, why: "Relevant synthetic task" }],
  expectedUses: [{ id: team.id, expectedUse: "Validate requests." }, { id: second.id, expectedUse: "Run the synthetic suite." }],
  confirmationReasons: [{ id: team.id, reason: "first", version: 1, team: true },
    { id: second.id, reason: "changed", previousVersion: 2, version: 3, team: true }],
} as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>

function Detail({ initial }: { initial: MemoryItem }) {
  const [item, setItem] = useState(initial)
  return <MemoryDetailPanel item={item} allItems={[item]} onClose={() => {}} onUpdated={setItem} onAccept={async () => {}} onArchive={async () => {}} />
}

function CheckupFixture() {
  const [resolvedRows, setResolvedRows] = useState<ReadonlyMap<string, string>>(() => new Map())
  const message = {
    kind: "memory_checkup", id: "checkup", checkupId: "checkup", timestamp: "2026-08-19T00:00:00.000Z",
    suggestions: [{ kind: "redundancy", memoryId: team.id, otherMemoryId: ordinary.id, reason: "Similar synthetic rules", teamPair: true, teamMemoryId: team.id }],
  } as Extract<HydratedTranscriptMessage, { kind: "memory_checkup" }>
  return <TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
    <section id="checkup"><MemoryCheckupGate message={message} onRespond={() => {}} resolvedRows={resolvedRows}
      onSuggestionResolved={(id, outcome) => setResolvedRows(current => new Map(current).set(id, outcome))} /></section>
  </TranscriptChatContextProvider>
}

function NoticeFixture({ mode }: { mode: string }) {
  return <MemoryBoardLauncherProvider onOpenMemoryBoard={() => {}}><TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
    <TranscriptRenderOptionsProvider value={{ readonly: mode === "readonly", ...(mode === "demo" ? { previewDemo: { reviseReply: "" } } : {}) }}>
      <section id="notice"><MemoryTeamUpdatedMessage message={{
        kind: "memory_team_updated", id: "notice", timestamp: "2030-01-01T00:00:00.000Z",
        added: ["M-05"], changed: ["M-01"], removed: ["M-03"], turn: 2,
      }} /></section>
    </TranscriptRenderOptionsProvider>
  </TranscriptChatContextProvider></MemoryBoardLauncherProvider>
}

function Fixture() {
  return <MemoryRouter><MemoryBoardLauncherProvider onOpenMemoryBoard={request => fixtureWindow.fixtureLaunches.push(request)}>
    <TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
      <main className="mx-auto flex max-w-6xl flex-col gap-8 p-4">
        <section id="board" className="flex h-[740px] min-w-0"><MemoryBoardPage overlay={{ chatId: "synthetic-chat" }} /></section>
        <section id="card" className="max-w-lg"><MemoryCard item={team} variant="scoped" /></section>
        <section id="team-default" className="max-w-lg rounded-xl border bg-card"><Detail initial={team} /></section>
        <section id="team-propose" className="max-w-lg rounded-xl border bg-card"><Detail initial={second} /></section>
        <section id="team-off" className="max-w-lg rounded-xl border bg-card"><Detail initial={off} /></section>
        <section id="ordinary" className="max-w-lg rounded-xl border bg-card"><Detail initial={ordinary} /></section>
        <section id="ordinary-detail" className="max-w-lg rounded-xl border bg-card"><Detail initial={detailed} /></section>
        <section id="ordinary-no-path" className="max-w-lg rounded-xl border bg-card"><Detail initial={noPath} /></section>
        <section id="preview" className="max-w-3xl"><MemoryPreviewMessage message={preview} onRespond={() => {}} /></section>
        <section id="notice" className="max-w-3xl rounded-xl border bg-card p-4"><MemoryTeamUpdatedMessage message={{ kind: "memory_team_updated", id: "notice", timestamp: "2030-01-01T00:00:00.000Z", added: ["M-01"], changed: ["M-02"], removed: ["M-04"], turn: 2 }} /></section>
        <section id="citation" className="p-4"><MemoryCitationChip id="M-01" /></section>
      </main>
    </TranscriptChatContextProvider>
  </MemoryBoardLauncherProvider></MemoryRouter>
}

const params = new URLSearchParams(window.location.search)
const noticeMode = params.get("teamNotice")
createRoot(document.getElementById("root")!).render(noticeMode ? <NoticeFixture mode={noticeMode} /> : params.has("checkup") ? <CheckupFixture /> : <Fixture />)
