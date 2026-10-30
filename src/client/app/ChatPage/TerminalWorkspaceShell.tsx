import { lazy, Suspense, memo, useEffect, useState } from "react"
import { PanelLoading } from "../../components/ui/panel-loading"
import { useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import type { AppState } from "../useAppState"

const TerminalWorkspace = lazy(() => import("../../components/chat-ui/TerminalWorkspace").then(module => ({ default: module.TerminalWorkspace })))

interface TerminalWorkspaceShellProps {
  projectId: string
  fixedTerminalHeight: number
  terminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["projects"][string]
  addTerminal: ReturnType<typeof useTerminalLayoutStore.getState>["addTerminal"]
  socket: AppState["socket"]
  connectionStatus: AppState["connectionStatus"]
  scrollback: number
  minColumnWidth: number
  splitTerminalShortcut?: string[]
  focusRequestVersion: number
  pendingCommandsByTerminalId?: Record<string, string>
  onTerminalCommandSent?: () => void
  onInitialTerminalCommandSent?: (terminalId: string) => void
  onRemoveTerminal: (projectId: string, terminalId: string) => void
  onTerminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["setTerminalSizes"]
}

export const TerminalWorkspaceShell = memo(function TerminalWorkspaceShell({
  projectId,
  fixedTerminalHeight,
  terminalLayout,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  focusRequestVersion,
  pendingCommandsByTerminalId,
  onTerminalCommandSent,
  onInitialTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
}: TerminalWorkspaceShellProps) {
  const [hasOpened, setHasOpened] = useState(terminalLayout.isVisible)
  useEffect(() => {
    if (terminalLayout.isVisible) setHasOpened(true)
  }, [terminalLayout.isVisible])

  // Defer the bundle until first use, then keep terminal subscriptions/state alive.
  if (!terminalLayout.isVisible && !hasOpened) return null

  return (
    <div style={fixedTerminalHeight > 0 ? { height: `${fixedTerminalHeight}px` } : undefined}>
      <Suspense fallback={<PanelLoading />}>
        <TerminalWorkspace
          projectId={projectId}
          layout={terminalLayout}
          onAddTerminal={addTerminal}
          socket={socket}
          connectionStatus={connectionStatus}
          scrollback={scrollback}
          minColumnWidth={minColumnWidth}
          splitTerminalShortcut={splitTerminalShortcut}
          focusRequestVersion={focusRequestVersion}
          pendingCommandsByTerminalId={pendingCommandsByTerminalId}
          onTerminalCommandSent={onTerminalCommandSent}
          onInitialTerminalCommandSent={onInitialTerminalCommandSent}
          onRemoveTerminal={onRemoveTerminal}
          onTerminalLayout={onTerminalLayout}
        />
      </Suspense>
    </div>
  )
})
