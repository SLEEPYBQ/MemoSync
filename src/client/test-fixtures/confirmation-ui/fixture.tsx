import { createRoot } from "react-dom/client"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import type { AppSettingsPatch, AppSettingsSnapshot, HydratedTranscriptMessage } from "../../../shared/types"
import type { MemoryItem } from "../../lib/memoriesApi"
import { i18n } from "../../i18n"
import { MemoryPreviewMessage } from "../../components/messages/MemoryPreviewMessage"
import { TranscriptChatContextProvider, TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { useMemoryStore } from "../../stores/memoryStore"
import { MemorySettingsGroups } from "../../app/settings/MemorySection"
import "./fixture.css"

await i18n.changeLanguage("en")
const items = [
  { id: "M-01", content: "Validate the synthetic order." },
  { id: "M-02", content: "Use the revised test protocol." },
  { id: "M-03", content: "Keep fixtures isolated." },
  { id: "M-04", content: "Record a synthetic receipt." },
  { id: "M-05", content: "Use a local test clock." },
].map(item => ({ ...item, scope: "personal", type: "constraint", status: "active", abstractionLevel: "concrete",
  sensitive: false, createdAt: "", updatedAt: "", usageCount: 0, reinforcedCount: 0, citedInCurrentSession: 0, version: 1 })) as MemoryItem[]
useMemoryStore.setState({ items, status: "ready" })
const base = {
  kind: "memory_preview", id: "preview-entry", previewId: "preview-1", timestamp: "2030-01-01T00:00:00.000Z",
  confirmationMode: "on_change",
  memories: items.map(({ id, content, scope }) => ({ id, content, scope })),
  relevant: items.map(({ id }) => ({ id, why: "Relevant to this synthetic task." })),
  expectedUses: items.map(({ id }) => ({ id, expectedUse: `Apply ${id} to this synthetic task.` })),
  confirmationReasons: [{ id: "M-01", reason: "first", version: 1 }, { id: "M-02", reason: "changed", version: 2, previousVersion: 1 }],
} as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>
const receipt = { ...base, id: "receipt", previewId: "preview-2", decision: "go_on", decisionAuto: true, decisionAutoReason: "confirmed",
  decisionSelectedIds: ["M-01", "M-03"], decisionExpectedUses: [base.expectedUses![0], base.expectedUses![2]] } as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>
const failure = { ...base, id: "failure", previewId: "preview-3", relevant: [], confirmationReasons: undefined,
  selectionError: "Working-memory selection failed.", expectedUses: [] } as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>
const choosing = { ...base, id: "choosing", previewId: "preview-4", relevant: undefined, expectedUses: undefined,
  confirmationReasons: undefined, relevancePending: true } as Extract<HydratedTranscriptMessage, { kind: "memory_preview" }>
function SettingsFixture() {
  const [settings, setSettings] = useState({
    memory: { enabled: true, learn: true, control: "review" },
    memoryPreview: { enabled: true, autoProceedWhenEmpty: true, confirmationMode: "on_change" },
  } as AppSettingsSnapshot)
  const save = (patch: AppSettingsPatch) => setSettings(current => ({
    ...current, memory: { ...current.memory, ...patch.memory }, memoryPreview: { ...current.memoryPreview, ...patch.memoryPreview },
  }))
  return <><MemorySettingsGroups settings={settings} mode="ask" save={save} setMode={() => {}} />
    <output>{settings.memoryPreview.confirmationMode}</output></>
}
createRoot(document.getElementById("root")!).render(
  <MemoryRouter><TranscriptChatContextProvider value={{ chatId: "synthetic-chat" }}>
    <TranscriptRenderOptionsProvider value={{ previewDemo: { reviseReply: "Synthetic reply." } }}>
      <main className="mx-auto flex max-w-3xl flex-col gap-8 p-4 sm:p-8">
        <section id="confirmation"><MemoryPreviewMessage message={base} onRespond={() => {}} /></section>
        <section id="receipt"><MemoryPreviewMessage message={receipt} onRespond={() => {}} /></section>
        <section id="failure"><MemoryPreviewMessage message={failure} onRespond={() => {}} /></section>
        <section id="choosing"><MemoryPreviewMessage message={choosing} onRespond={() => {}} /></section>
        <section id="readonly-receipt"><TranscriptRenderOptionsProvider value={{ readonly: true }}>
          <MemoryPreviewMessage message={receipt} onRespond={() => {}} />
        </TranscriptRenderOptionsProvider></section>
        <section id="settings"><SettingsFixture /></section>
      </main>
    </TranscriptRenderOptionsProvider>
  </TranscriptChatContextProvider></MemoryRouter>,
)
