import { useEffect, useMemo, useState } from "react"
import type { ChatSnapshot } from "../../shared/types"
import type { AppSocket } from "./socket"

export interface LandingDraft {
  chatId: string
  projectId: string
}

// The server gives the same socket one hold on a draft, not one per ensure.
// Re-entering a folder must not race the previous visit's outstanding discard.
const releasesBySocket = new WeakMap<AppSocket, Map<string, Promise<void>>>()

/**
 * The landing page has no chat yet, so it holds a hidden draft for the chosen project.
 * Native commands and Mode then work as in any empty chat; the first send promotes it.
 */
export function useLandingDraft(socket: AppSocket, localPath: string | null, connected: boolean) {
  const owner = useMemo(() => connected && localPath ? { socket, localPath } : null, [socket, localPath, connected])
  const [session, setSession] = useState<{
    owner: NonNullable<typeof owner>
    draft: LandingDraft | null
    runtime: ChatSnapshot["runtime"] | null
  } | null>(null)

  useEffect(() => {
    if (!owner) return
    const { socket, localPath } = owner
    const releases = releasesBySocket.get(socket) ?? new Map<string, Promise<void>>()
    releasesBySocket.set(socket, releases)
    let left = false
    let owned: string | null = null
    let unsubscribe: (() => void) | undefined
    const request = (async () => {
      await releases.get(localPath)
      if (left) return
      try {
        const draft = await socket.command<LandingDraft>({ type: "chat.ensureDraft", localPath })
        owned = draft.chatId
        if (left) return
        setSession({ owner, draft, runtime: null })
        unsubscribe = socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId: draft.chatId, recentLimit: 1 }, snapshot => {
          if (!left) setSession({ owner, draft, runtime: snapshot?.runtime ?? null })
        })
      } catch {
        // Text-only sending can still open the selected path without a draft.
        if (!left) setSession({ owner, draft: null, runtime: null })
      }
    })()
    return () => {
      left = true
      unsubscribe?.()
      // The server keeps a draft that a send has already promoted.
      const release = request.then(async () => {
        if (owned) await socket.command({ type: "chat.discardDraft", chatId: owned }).catch(() => undefined)
      })
      releases.set(localPath, release)
      void release.then(() => { if (releases.get(localPath) === release) releases.delete(localPath) })
    }
  }, [owner])

  // The new composer's first render happens before passive effect cleanup.
  const current = session?.owner === owner ? session : null
  return { draft: current?.draft ?? null, runtime: current?.runtime ?? null, pending: Boolean(owner && !current) }
}
