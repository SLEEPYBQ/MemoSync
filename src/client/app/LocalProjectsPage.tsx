import { useMemo } from "react"
import { useOutletContext } from "react-router-dom"
import { LocalDev } from "../components/LocalDev"
import type { AppState } from "./useAppState"

export function LocalProjectsPage() {
  const state = useOutletContext<AppState>()
  const projectIdByPath = useMemo(() => {
    const map: Record<string, string> = {}
    for (const group of state.sidebarData.projectGroups) {
      if (group.localPath) map[group.localPath] = group.groupKey
    }
    return map
  }, [state.sidebarData])

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <LocalDev
        connectionStatus={state.connectionStatus}
        ready={state.localProjectsReady}
        snapshot={state.localProjects}
        commandError={state.commandError}
        newProjectOpen={state.addProjectModalOpen}
        onNewProjectOpenChange={(open) => {
          if (open) {
            state.openAddProjectModal()
            return
          }
          state.closeAddProjectModal()
        }}
        onCreateProject={state.handleCreateProject}
        onSend={state.handleSend}
        availableProviders={state.availableProviders}
        projectIdByPath={projectIdByPath}
      />
    </div>
  )
}
