import type { LocalHttpServerInfo, ProjectQuickAction } from "../../shared/protocol"
import type { AppSocket } from "../app/socket"

// Cache local-server lists PER PROJECT. A single global cache flashed one
// project's servers (and its "same-project" markers) when you switched to
// another, and a delayed refresh from the old project could overwrite the new
// one's list (BUG PANEL-6). Mirrors the per-project quick-actions cache below.
const localHttpServersCacheByProjectId = new Map<string, LocalHttpServerInfo[]>()
const localHttpServersRequestByProjectId = new Map<string, Promise<LocalHttpServerInfo[]>>()

const quickActionsCacheByProjectId = new Map<string, ProjectQuickAction[]>()
const quickActionsRequestByProjectId = new Map<string, Promise<ProjectQuickAction[]>>()

function visibleLocalHttpServers(servers: LocalHttpServerInfo[]) {
  return servers.filter((server) => server.status >= 200 && server.status < 400)
}

export function getCachedLocalHttpServers(projectId: string) {
  return localHttpServersCacheByProjectId.get(projectId) ?? null
}

export function refreshCachedLocalHttpServers(socket: AppSocket, projectId: string) {
  const existingRequest = localHttpServersRequestByProjectId.get(projectId)
  if (existingRequest) return existingRequest

  const request = socket.command<LocalHttpServerInfo[]>({
    type: "browser.listLocalHttpServers",
    projectId,
  }).then((servers) => {
    const visibleServers = visibleLocalHttpServers(servers)
    localHttpServersCacheByProjectId.set(projectId, visibleServers)
    return visibleServers
  }).finally(() => {
    localHttpServersRequestByProjectId.delete(projectId)
  })

  localHttpServersRequestByProjectId.set(projectId, request)
  return request
}

export function removeCachedLocalHttpServer(projectId: string, port: number) {
  const nextServers = (localHttpServersCacheByProjectId.get(projectId) ?? []).filter((server) => server.port !== port)
  localHttpServersCacheByProjectId.set(projectId, nextServers)
  return nextServers
}

export function getCachedProjectQuickActions(projectId: string) {
  return quickActionsCacheByProjectId.get(projectId)
}

export function refreshCachedProjectQuickActions(socket: AppSocket, projectId: string) {
  const existingRequest = quickActionsRequestByProjectId.get(projectId)
  if (existingRequest) return existingRequest

  const request = socket.command<ProjectQuickAction[]>({
    type: "project.readQuickActions",
    projectId,
  }).then((actions) => {
    quickActionsCacheByProjectId.set(projectId, actions)
    return actions
  }).finally(() => {
    quickActionsRequestByProjectId.delete(projectId)
  })

  quickActionsRequestByProjectId.set(projectId, request)
  return request
}

export function writeCachedProjectQuickActions(socket: AppSocket, projectId: string, actions: ProjectQuickAction[]) {
  quickActionsCacheByProjectId.set(projectId, actions)
  return socket.command<ProjectQuickAction[]>({
    type: "project.writeQuickActions",
    projectId,
    quickActions: actions,
  }).then((savedActions) => {
    quickActionsCacheByProjectId.set(projectId, savedActions)
    return savedActions
  })
}
