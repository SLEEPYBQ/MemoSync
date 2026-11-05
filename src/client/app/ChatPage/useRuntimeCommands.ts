import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { runtimeCommandSelectionKey, type ChatCommandCatalog, type RuntimeCommand, type RuntimeCommandSelection } from "../../../shared/runtime-commands"
import type { AgentProvider } from "../../../shared/types"
import { t } from "../../i18n"
import type { AppSocket } from "../socket"

/** Preparation follows the current composer selection, before any model turn. */
export function useRuntimeCommands(socket: AppSocket, chatId: string | null, engine: AgentProvider | null, connected: boolean, snapshot?: ChatCommandCatalog) {
  const [selectionState, setSelectionState] = useState<{ chatId: string; selection: RuntimeCommandSelection } | null>(null)
  const selection = selectionState?.chatId === chatId && (!engine || selectionState.selection.provider === engine)
    ? selectionState.selection : engine ? { provider: engine } : null
  const selectionKey = selection ? runtimeCommandSelectionKey(selection) : null
  const owner = useMemo(() => ({}), [chatId, selectionKey, connected])
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [read, setRead] = useState<{ owner: object; catalog: ChatCommandCatalog; source: ChatCommandCatalog | undefined } | null>(null)
  const [activity, setActivity] = useState<{ owner: object; kind: "loading" | "executing" } | null>(null)
  const [failure, setFailure] = useState<{ owner: object; message: string } | null>(null)
  const requestVersion = useRef(0)
  // An RPC fills the gap until the next authoritative snapshot. Retirement may
  // reset the catalog revision; never compare it against an older runtime.
  const cached = read?.owner === owner && read.source === snapshot ? read.catalog : null
  const latest = cached ?? snapshot
  const matchesSelection = latest?.selectionKey ? latest.selectionKey === selectionKey : latest?.runtime?.engine === selection?.provider
  const catalog = connected && matchesSelection ? latest ?? null : null

  const prepare = useCallback((next: RuntimeCommandSelection) => {
    if (!chatId) return
    const nextKey = runtimeCommandSelectionKey(next)
    setSelectionState(previous => previous?.chatId === chatId && runtimeCommandSelectionKey(previous.selection) === nextKey
      ? previous : { chatId, selection: next })
  }, [chatId])

  const refresh = useCallback(async (force = true) => {
    const currentSelection = selectionRef.current
    if (!chatId || !connected || !currentSelection) return
    const version = ++requestVersion.current
    const source = snapshotRef.current
    setActivity({ owner, kind: "loading" })
    try {
      const next = await socket.command<ChatCommandCatalog>({ type: "chat.readCommandCatalog", chatId, selection: currentSelection, refresh: force })
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

  return { catalog, prepare, refresh, execute, cancel, busy: activity?.owner === owner, error: failure?.owner === owner ? failure.message : null }
}
