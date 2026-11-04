import { useEffect, useMemo, useRef } from "react"
import type { HostActionRequested, HostFileSnapshot } from "../../../shared/host-actions"
import { HostFileWorkbench } from "../../lib/hostFileWorkbench"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import type { AppSocket } from "../socket"

/** One workbench owner per visible chat. Status updates can stop delivery, never navigate. */
export function useHostFileActions(socket: AppSocket, chatId: string | null, projectId: string | null) {
  const current = useRef<object | null>(null)
  const owner = useMemo(() => ({ generation: 0 }), [socket, chatId, projectId])
  current.current = owner
  const workbench = useMemo(() => chatId && projectId ? new HostFileWorkbench(chatId, projectId, () => {
    if (current.current !== owner) return
    const store = useRightSidebarStore.getState()
    if (store.projects[projectId]?.rightPanel !== "files") store.togglePanel(projectId, "files")
  }, request => current.current === owner && request.generation === owner.generation
    && request.targetClientId === socket.getHostActionClientId()) : null, [socket, chatId, projectId, owner])

  useEffect(() => {
    if (!workbench || !chatId || !projectId) return
    workbench.activate()
    const inFlight = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout>; generation: number }>()
    let alive = true
    const abortPending = () => { for (const entry of inFlight.values()) entry.controller.abort() }
    async function present(request: HostActionRequested) {
      if (request.chatId !== chatId || request.action.workspaceRef !== projectId || request.targetClientId !== socket.getHostActionClientId()) return
      if (inFlight.has(request.operationId)) return
      if (request.generation > owner.generation) {
        owner.generation = request.generation
        for (const [id, entry] of inFlight) if (entry.generation < request.generation) {
          workbench!.stop(id)
          entry.controller.abort()
        }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(0, request.expiresAt - Date.now()))
      const entry = { controller, timer, generation: request.generation }
      inFlight.set(request.operationId, entry)
      try {
        const snapshot = await socket.command<HostFileSnapshot>({ type: "host.action.readSnapshot", operationId: request.operationId })
        if (!alive || current.current !== owner) controller.abort()
        const receipt = await workbench!.presentReadonlySnapshot(request, snapshot, controller.signal)
        // A rendered old view is still a fact. This ACK cannot navigate or advance a turn.
        await socket.command({ type: "host.action.presented", operationId: request.operationId, ...receipt })
      } catch (error) {
        // Cancellation and disconnect remain unconfirmed presentation, never a success ACK.
        if (!controller.signal.aborted && alive) console.warn("[memosync] host file presentation unavailable", error instanceof Error ? error.message : "unknown")
      } finally {
        clearTimeout(timer)
        if (inFlight.get(request.operationId) === entry) inFlight.delete(request.operationId)
      }
    }
    const offActions = socket.onHostAction(event => {
      if (!alive || event.targetClientId !== socket.getHostActionClientId() || event.chatId !== chatId) return
      if (event.type === "host.action.requested") void present(event)
      else if (event.receipt.delivery === "stopped") {
        workbench.stop(event.receipt.operationId)
        inFlight.get(event.receipt.operationId)?.controller.abort()
      }
    })
    const offStatus = socket.onStatus(status => { if (status !== "connected") abortPending() })
    return () => {
      alive = false
      offActions()
      offStatus()
      abortPending()
      for (const entry of inFlight.values()) clearTimeout(entry.timer)
      inFlight.clear()
      workbench.dispose()
    }
  }, [socket, chatId, projectId, owner, workbench])
  return workbench
}
