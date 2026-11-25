import { AttachmentsNotAdmittedError } from "../../../shared/protocol"
import type { ChatAttachment } from "../../../shared/types"

/**
 * Keep a user's persisted composer draft intact while an async submit
 * is waiting on admission (for example, the opening Long-term Memory Board).
 * Only a successfully accepted real send is allowed to clear it.
 */
export async function runRetainedDraftSubmission(options: {
  submit: () => Promise<void>
  onAccepted: () => void
  onRejected: (error: unknown) => void
}): Promise<void> {
  try {
    await options.submit()
    options.onAccepted()
  } catch (error) {
    options.onRejected(error)
  }
}

// A persisted chip is a reference, not proof that the draft still owns a file.
// Keep ownership separate from the draft snapshot: restoring a stale snapshot
// (including in another tab) must never restore permission to unlink.
const unsentUploadKey = (id: string) => `memosync.unsent-upload.${id}`

export function recordUnsentUpload(id: string) {
  try { localStorage.setItem(unsentUploadKey(id), "1") } catch { /* Detach only if storage is unavailable. */ }
}

function takeUnsentUpload(id: string): boolean {
  try {
    const key = unsentUploadKey(id)
    if (localStorage.getItem(key) !== "1") return false
    localStorage.removeItem(key)
    return true
  } catch { return false }
}

// Serialize only operations on the same files. The browser releases these
// locks when a document goes away; nothing persisted can revive a lost ACK.
function withUploadLocks(ids: string[], run: (locked: boolean) => Promise<void>) {
  if (!ids.length || !navigator.locks) return run(false)
  const keys = [...new Set(ids)].sort()
  const next = (i: number): Promise<void> => i === keys.length
    ? run(true)
    : navigator.locks.request(unsentUploadKey(keys[i]!), () => next(i + 1))
  return next(0)
}

export function submitWithDraftUploads(attachments: ChatAttachment[], submit: () => Promise<void>) {
  return withUploadLocks(attachments.map(item => item.id), async locked => {
    const owned = attachments.filter(item => takeUnsentUpload(item.id))
    try {
      await submit()
    } catch (error) {
      if (locked && error instanceof AttachmentsNotAdmittedError) owned.forEach(item => recordUnsentUpload(item.id))
      throw error
    }
  })
}

export function discardDraftUpload(item: ChatAttachment, discard: (item: ChatAttachment) => Promise<void>) {
  return withUploadLocks([item.id], async () => {
    if (takeUnsentUpload(item.id)) await discard(item)
  })
}
