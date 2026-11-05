import { useEffect, useState } from "react"
import type { ChatSnapshot } from "../../shared/types"
import type { AppSocket } from "./socket"

export interface LandingDraft {
  chatId: string
  projectId: string
}

/**
 * The landing page has no chat yet, so it holds a hidden draft for the chosen project.
 * Native commands and Mode then work as in any empty chat; the first send promotes it.
 */
export function useLandingDraft(socket: AppSocket, localPath: string | null, connected: boolean) {
  const [draft, setDraft] = useState<LandingDraft | null>(null)
  const [runtime, setRuntime] = useState<ChatSnapshot["runtime"] | null>(null)

  useEffect(() => {
    if (!connected || !localPath) return
    let left = false
    let owned: string | null = null
    const discard = (chatId: string) => { void socket.command({ type: "chat.discardDraft", chatId }).catch(() => undefined) }
    socket.command<LandingDraft>({ type: "chat.ensureDraft", localPath }).then(result => {
      if (left) return discard(result.chatId)
      owned = result.chatId
      setDraft(result)
    }).catch(() => undefined) // Sending still works without a draft.
    return () => {
      left = true
      setDraft(null)
      setRuntime(null)
      // The server keeps a draft that a send has already promoted.
      if (owned) discard(owned)
    }
  }, [socket, localPath, connected])

  const chatId = draft?.chatId ?? null
  useEffect(() => {
    if (!chatId) return
    return socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId, recentLimit: 1 }, snapshot => setRuntime(snapshot?.runtime ?? null))
  }, [socket, chatId])

  return { draft, runtime }
}
