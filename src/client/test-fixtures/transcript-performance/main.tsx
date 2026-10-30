import { Profiler, useMemo, useRef } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { MemoryRouter } from "react-router-dom"
import { buildResolvedTranscriptRows, ChatTranscriptRow, useStableResolvedRows } from "../../app/ChatTranscript"
import { ChatTranscriptViewport } from "../../app/ChatPage/ChatTranscriptViewport"
import { useMemoryStore } from "../../stores/memoryStore"
import { TextMessage } from "../../components/messages/TextMessage"
import { TurnInterruptContext } from "../../components/messages/shared"
import { ViolatedCitationsMapProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { applyLanguage } from "../../i18n"
import type { MemoryItem } from "../../lib/memoriesApi"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import "../../../index.css"

const noop = () => {}
const asyncNoop = async () => {}
const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
const timestamp = "2026-10-30T00:00:00Z"
const memoryItems: MemoryItem[] = Array.from({ length: 300 }, (_, i) => ({
  id: `M-${i + 1}`, content: `Synthetic memory rule ${i + 1}`, detail: "Use explicit state transitions and preserve review gates.",
  abstractionLevel: "contextual", sensitive: false, scope: "project", type: "constraint",
  status: i % 3 === 1 ? "candidate" : "active", projectId: "synthetic", createdAt: timestamp, updatedAt: timestamp,
  usageCount: 0, reinforcedCount: 0, version: 1, citedInCurrentSession: 0,
}))
useMemoryStore.setState({ items: memoryItems, status: "ready" })
// 1,200 entries: 300 markdown, 600 tools (300 two-call groups), 300 memory cards.
const seed: HydratedTranscriptMessage[] = Array.from({ length: 300 }, (_, i) => [
  { id: `text-${i}`, kind: "assistant_text", timestamp, text: `## Result ${i}\n\nReviewed **the implementation** with [source](https://example.com).\n\n| Input | Output |\n|---|---|\n| a | b |\n\n\`\`\`ts\nconst result = true\n\`\`\`` },
  ...[0, 1].map(n => ({ id: `tool-${i}-${n}`, kind: "tool", toolKind: "other", toolName: "SyntheticTool", toolId: `call-${i}-${n}`, timestamp, input: { query: `inspect ${i}` }, result: { content: Array.from({ length: 80 }, (_, line) => ({ line, value: "synthetic output ".repeat(8) })) } })),
  i % 3 === 0
    ? { id: `memory-${i}`, kind: "memory_trace", timestamp, turn: i, status: "ok", labels: [{ id: `M-${i + 1}`, label: "operational", note: "Explicit state transitions preserved.", cited: true }], summary: "Synthetic audit complete" }
    : i % 3 === 1
      ? { id: `memory-${i}`, kind: "memory_candidates", timestamp, turn: i, candidates: [{ id: `M-${i + 1}` }] }
      : { id: `memory-${i}`, kind: "memory_preview", timestamp, turn: i, previewId: `preview-${i}`, memories: [{ id: `M-${i + 1}`, content: `Synthetic memory rule ${i + 1}`, scope: "project" }], decision: "go_on" },
]).flat() as HydratedTranscriptMessage[]

let commits: Array<{ phase: string; actualDuration: number }> = []
function AllRows({ messages }: { messages: HydratedTranscriptMessage[] }) {
  const rawRows = useMemo(() => buildResolvedTranscriptRows(messages, { isLoading: true, latestToolIds }), [messages])
  const rows = useStableResolvedRows(rawRows)
  return <>{rows.map(row => <ChatTranscriptRow key={row.id} row={row} onToolGroupExpandedChange={noop} onAskUserQuestionSubmit={noop} onExitPlanModeConfirm={noop} />)}</>
}
function Viewport({ messages }: { messages: HydratedTranscriptMessage[] }) {
  const listRef = useRef(null)
  return <div style={{ height: 700, position: "relative", display: "flex" }}><ChatTranscriptViewport
    activeChatId="synthetic" listRef={listRef} messages={messages} queuedMessages={[]} transcriptPaddingBottom={30}
    latestToolIds={latestToolIds} localPath="/synthetic" isHistoryLoading={false} hasOlderHistory={false}
    isProcessing canCancel runtimeStatus="running" isDraining={false} commandError={null}
    loadOlderHistory={asyncNoop} onStopDraining={noop} onSteerQueuedMessage={asyncNoop} onRemoveQueuedMessage={asyncNoop}
    onOpenLocalLink={asyncNoop} onAskUserQuestionSubmit={asyncNoop} onExitPlanModeConfirm={asyncNoop}
    showScrollButton={false} onIsAtEndChange={noop} scrollToBottom={noop} typedEmptyStateText=""
    isEmptyStateTypingComplete isPageFileDragActive={false} showEmptyState={false}
  /></div>
}
const root = createRoot(document.getElementById("root")!)
const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const measure = (mode: string, messages: HydratedTranscriptMessage[]) => {
  commits = []
  const start = performance.now()
  flushSync(() => root.render(<MemoryRouter><Profiler id="transcript" onRender={(_id, phase, actualDuration) => commits.push({ phase, actualDuration })}>
    {mode === "viewport" ? <Viewport messages={messages} /> : <AllRows messages={messages} />}
  </Profiler></MemoryRouter>))
  return { wallMs: performance.now() - start, reactMs: commits.reduce((n, c) => n + c.actualDuration, 0) }
}
Object.assign(window, {
  fixtureMessages: seed,
  renderFixture(mode: string, messages = seed) { return measure(mode, messages) },
  setFixtureLanguage: applyLanguage,
  updateFixtureMemory(content: string) { useMemoryStore.getState().upsertLocal({ ...memoryItems[0], content }) },
  renderCitationCheck(active: boolean, violated: boolean, textLinks = false) {
    flushSync(() => root.render(<MemoryRouter><TurnInterruptContext.Provider value={{ active, interrupt: noop, resume: asyncNoop }}>
      <ViolatedCitationsMapProvider value={violated ? new Map([["cached-reply", new Set(["M-1"])]]) : null}>
        <TranscriptRenderOptionsProvider value={{ localLinkMode: textLinks ? "text" : "open" }}>
          <TextMessage message={{ id: "cached-reply", kind: "assistant_text", text: "Apply [M-1] and [open file](/fixture/src/app.ts)", timestamp }} isCurrentTurn />
        </TranscriptRenderOptionsProvider>
      </ViolatedCitationsMapProvider>
    </TurnInterruptContext.Provider></MemoryRouter>))
  },
  async runTranscriptBenchmark(mode = "all") {
    flushSync(() => root.render(null))
    const initial = measure(mode, seed)
    await tick()
    const deltas = []
    for (let i = 0; i < 30; i++) {
      // A fresh snapshot rehydrates objects; only one assistant entry changes.
      const messages = structuredClone(seed)
      const message = messages.find(m => m.id === "text-299")!
      if (message.kind === "assistant_text") message.text += `\nDelta ${i}`
      deltas.push(measure(mode, messages))
      await tick()
    }
    return { mode, entries: seed.length, tools: 600, memoryCards: 300, initial, deltas, mountedMemoryCards: document.querySelectorAll(".memory-card").length }
  },
})
