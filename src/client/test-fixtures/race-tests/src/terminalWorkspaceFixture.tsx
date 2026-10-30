import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { TerminalSnapshot } from "../../../../shared/protocol"
import { AppSocket } from "../../../app/socket"
import { TerminalWorkspaceShell } from "../../../app/ChatPage/TerminalWorkspaceShell"
import { TooltipProvider } from "../../../components/ui/tooltip"
import { ThemeProvider } from "../../../hooks/useTheme"
import { useTerminalLayoutStore } from "../../../stores/terminalLayoutStore"
import "../../../../index.css"

// Model an existing server session: its output predates the client subscription.
const snapshot: TerminalSnapshot = {
  terminalId: "saved-terminal", title: "Saved terminal", cwd: "/fixture",
  shell: "/bin/sh", cols: 80, rows: 24, scrollback: 1_000,
  serializedState: "OUTPUT_BEFORE_OPEN\r\n", status: "running", exitCode: null,
}

class FixtureSocket extends AppSocket {
  subscriptions = 0
  unsubscriptions = 0
  private listener?: Parameters<AppSocket["subscribeTerminal"]>[1]

  override subscribeTerminal(terminalId: string, listener: Parameters<AppSocket["subscribeTerminal"]>[1]) {
    if (terminalId !== snapshot.terminalId) throw new Error("Saved terminal ID changed")
    this.subscriptions++
    this.listener = listener
    listener.onSnapshot(snapshot)
    return () => { this.unsubscriptions++; this.listener = undefined }
  }

  override async command(command: Parameters<AppSocket["command"]>[0]): Promise<unknown> {
    return command.type === "terminal.create" ? snapshot : undefined
  }

  emitOutput(data: string) {
    this.listener?.onEvent?.({ type: "terminal.output", terminalId: snapshot.terminalId, data })
  }
}

export function mountTerminalWorkspaceFixture(root: HTMLElement) {
  const socket = new FixtureSocket("ws://fixture")
  useTerminalLayoutStore.setState({ projects: {
    fixture: { isVisible: false, mainSizes: [68, 32], nextTerminalIndex: 1,
      terminals: [{ id: snapshot.terminalId, title: snapshot.title, size: 100 }] },
  } })
  const api = {
    stats: () => ({ subscriptions: socket.subscriptions, unsubscriptions: socket.unsubscriptions }),
    emitOutput: (data: string) => socket.emitOutput(data),
  }
  ;(window as unknown as { __terminalFixture: typeof api }).__terminalFixture = api

  function Host() {
    const layout = useTerminalLayoutStore(state => state.projects.fixture!)
    const [revision, setRevision] = useState(0)
    const store = useTerminalLayoutStore.getState()
    return <>
      <div data-testid="fixture-ready" />
      <button data-testid="toggle" onClick={() => store.toggleVisibility("fixture")}>Toggle</button>
      <button data-testid="rerender" onClick={() => setRevision(value => value + 1)}>Rerender</button>
      <output data-testid="revision">{revision}</output>
      <div style={{ display: layout.isVisible ? "block" : "none", height: 300, width: 900 }}>
        <TerminalWorkspaceShell projectId="fixture" fixedTerminalHeight={300}
          terminalLayout={layout} addTerminal={store.addTerminal} socket={socket}
          connectionStatus="connected" scrollback={1_000} minColumnWidth={200}
          focusRequestVersion={0} onRemoveTerminal={store.removeTerminal}
          onTerminalLayout={store.setTerminalSizes} />
      </div>
    </>
  }
  createRoot(root).render(<ThemeProvider><TooltipProvider><Host /></TooltipProvider></ThemeProvider>)
}
