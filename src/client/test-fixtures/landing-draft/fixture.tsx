import { useState, type ComponentProps } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import type { ClientCommand, SubscriptionTopic } from "../../../shared/protocol"
import { PROVIDERS, type ChatRuntime, type LocalProjectsSnapshot } from "../../../shared/types"
import type { AppSocket } from "../../app/socket"
import type { LandingDraft } from "../../app/useLandingDraft"
import { LocalDev } from "../../components/LocalDev"
import { TooltipProvider } from "../../components/ui/tooltip"
import { useChatInputStore } from "../../stores/chatInputStore"

const snapshot: LocalProjectsSnapshot = {
  machine: { id: "local", displayName: "Synthetic machine", platform: "linux" },
  projects: ["alpha", "beta", "saved"].map(name => ({
    localPath: `/fixture/${name}`, title: name, source: name === "saved" ? "saved" : "discovered", chatCount: 0,
  })),
}

const requests: Array<{ localPath: string; resolve: (draft: LandingDraft) => void; reject: (error: Error) => void }> = []
const commands: Array<{ command: ClientCommand; heading: string | null; connection: number }> = []
const sends: Array<Parameters<ComponentProps<typeof LocalDev>["onSend"]>> = []
const subscriptions = new Set<string>()
const projects = new Map([["project-saved", "/fixture/saved"]])
const projectByChat = new Map<string, string>()
let sendGate: Promise<void> | undefined, acceptSend: (() => void) | undefined
// A callback already in flight can be delivered by the test after unsubscribe.
type RuntimeReceiver = (snapshot: { runtime: Pick<ChatRuntime, "provider" | "harness"> }) => void
const receivers = new Map<string, RuntimeReceiver>()

function fixtureSocket(connection: number) {
  return {
    command(command: ClientCommand) {
      commands.push({ command, connection, heading: document.querySelector("h1")?.textContent ?? null })
      if (command.type === "chat.ensureDraft" && "localPath" in command) {
        return new Promise<LandingDraft>((resolve, reject) => requests.push({ localPath: command.localPath, resolve, reject }))
      }
      if (command.type === "chat.discardDraft") {
        const id = projectByChat.get(command.chatId)
        if (id && id !== "project-saved") projects.delete(id)
      }
      return Promise.resolve(null)
    },
    subscribe(topic: SubscriptionTopic, receive: RuntimeReceiver) {
      if (topic.type !== "chat") throw new Error(`Unexpected subscription: ${topic.type}`)
      subscriptions.add(topic.chatId)
      receivers.set(topic.chatId, receive)
      return () => subscriptions.delete(topic.chatId)
    },
  } as unknown as AppSocket
}

const fixture = {
  commands, sends, subscriptions,
  paths: () => requests.map(request => request.localPath),
  resolve: (index: number, id: string) => {
    const request = requests[index]!
    projects.set(`project-${id}`, request.localPath)
    projectByChat.set(`chat-${id}`, `project-${id}`)
    request.resolve({ chatId: `chat-${id}`, projectId: `project-${id}` })
  },
  pathFor: (id: string) => projects.get(id),
  seed: useChatInputStore.getState().setAttachmentDrafts,
  holdSend: () => { sendGate = new Promise<void>(resolve => { acceptSend = resolve }) },
  acceptSend: () => { acceptSend?.(); sendGate = undefined },
  reject: (index: number) => requests[index]!.reject(new Error("Synthetic draft failure")),
  publish: (chatId: string, permissionMode: "default" | "acceptEdits") => {
    const policy = { engine: "claude", permissionMode } as const
    flushSync(() => receivers.get(chatId)!({ runtime: { provider: "claude", harness: {
      nativeRuntime: "absent",
      capabilities: { engine: "claude", revision: 1, capabilities: [], executionPolicies: [] },
      policy: { desired: policy, effective: null, desiredRevision: 1, effectiveRevision: null, status: "pending", boundaries: [] },
    } } }))
  },
}
declare global { interface Window { landingFixture: typeof fixture } }
window.landingFixture = fixture

function Host() {
  const [socket, setSocket] = useState(() => fixtureSocket(1))
  return <>
    <button onClick={() => setSocket(fixtureSocket(2))}>Replace fixture connection</button>
    <LocalDev
      connectionStatus="connected" ready snapshot={snapshot} commandError={null}
      newProjectOpen={false} onNewProjectOpenChange={() => {}} onCreateProject={async () => {}}
      socket={socket} availableProviders={PROVIDERS} projectIdByPath={{ "/fixture/saved": "project-saved" }}
      onSend={async (...args) => { sends.push(args); await sendGate }}
    />
  </>
}

createRoot(document.getElementById("root")!).render(<MemoryRouter><TooltipProvider><Host /></TooltipProvider></MemoryRouter>)
