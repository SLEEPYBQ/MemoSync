import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChatCommandCatalog, RuntimeCommand } from "../../../shared/runtime-commands"
import type { AgentProvider } from "../../../shared/types"
import { t } from "../../i18n"
import type { AppSocket } from "../socket"

/** Catalogs stay in the live chat scope and are never persisted by provider. */
export function useRuntimeCommands(socket: AppSocket, chatId: string | null, engine: AgentProvider | null, connected: boolean, snapshot?: ChatCommandCatalog) {
  const owner = useMemo(() => ({}), [chatId, engine, connected])
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const [read, setRead] = useState<{ owner: object; catalog: ChatCommandCatalog; source: ChatCommandCatalog | undefined } | null>(null)
  const [activity, setActivity] = useState<{ owner: object; kind: "loading" | "executing" } | null>(null)
  const [failure, setFailure] = useState<{ owner: object; message: string } | null>(null)
  const requestVersion = useRef(0)
  // An RPC fills the gap until the next authoritative snapshot. Retirement
  // may reset the catalog revision; never compare it against an older runtime.
  const cached = read?.owner === owner && read.source === snapshot ? read.catalog : null
  const latest = cached ?? snapshot
  const catalog = connected && (!latest?.runtime || latest.runtime.engine === engine) ? latest ?? null : null

  const refresh = useCallback(async (force = true) => {
    if (!chatId || !connected) return
    const version = ++requestVersion.current
    const source = snapshotRef.current
    setActivity({ owner, kind: "loading" })
    try {
      const next = await socket.command<ChatCommandCatalog>({ type: "chat.readCommandCatalog", chatId, refresh: force })
      if (currentOwner.current === owner && requestVersion.current === version) {
        if (snapshotRef.current === source) setRead({ owner, catalog: next, source })
        setFailure(null)
      }
    } catch (err) {
      if (currentOwner.current === owner && requestVersion.current === version) setFailure({ owner, message: err instanceof Error ? err.message : t("commands:loadFailed") })
    } finally {
      if (currentOwner.current === owner && requestVersion.current === version) setActivity(null)
    }
  }, [socket, chatId, connected, owner])

  useEffect(() => { void refresh(false) }, [refresh])

  async function execute(command: RuntimeCommand, args = "") {
    if (!chatId || !catalog?.runtimeKey || currentOwner.current !== owner) throw new Error(t("commands:notReady"))
    if (catalog.commands.status !== "ready" || !catalog.commands.items.some(item => item.id === command.id)) throw new Error(t("commands:stale"))
    setActivity({ owner, kind: "executing" })
    setFailure(null)
    try {
      await socket.command({ type: "chat.executeCommand", chatId, commandId: command.id, arguments: args, runtimeKey: catalog.runtimeKey, expectedRevision: catalog.revision })
    } catch (err) {
      if (currentOwner.current === owner) setFailure({ owner, message: err instanceof Error ? err.message : t("commands:executeFailed") })
      throw err
    } finally {
      if (currentOwner.current === owner) { setActivity(null); void refresh(false) }
    }
  }

  async function cancel() {
    const operation = catalog?.operation
    if (!chatId || !operation || currentOwner.current !== owner) return
    await socket.command({ type: "chat.cancelCommand", chatId, operationId: operation.id })
    if (currentOwner.current === owner) await refresh(false)
  }

  return { catalog, refresh, execute, cancel, busy: activity?.owner === owner, error: failure?.owner === owner ? failure.message : null }
}
