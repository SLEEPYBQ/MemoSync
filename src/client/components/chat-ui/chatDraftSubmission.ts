import { AttachmentsNotAdmittedError } from "../../../shared/protocol"
import type { ChatAttachment } from "../../../shared/types"
import { generateUUID } from "../../lib/utils"

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

function hasPendingSend(key: string) {
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(`${key}/send/`)) return true
  }
  return false
}

export function recordUnsentUpload(id: string) {
  try { localStorage.setItem(unsentUploadKey(id), "1") } catch { /* Detach only if storage is unavailable. */ }
}

export function takeUnsentUpload(id: string): boolean {
  try {
    const key = unsentUploadKey(id)
    if (hasPendingSend(key)) {
      localStorage.setItem(`${key}/discard`, "1")
      return false
    }
    // An ACK in another tab spends the grant before releasing its hold.
    if (localStorage.getItem(key) !== "1") return false
    localStorage.removeItem(key)
    localStorage.removeItem(`${key}/discard`)
    return true
  } catch { return false }
}

/** Each attempt holds the upload until its outcome is known. A proven refusal
 * releases only that attempt's hold: it cannot undo a send in another window.
 * Success, a lost ACK, and unclassified errors permanently spend the grant. */
export async function submitWithDraftUploads(
  attachments: ChatAttachment[],
  submit: () => Promise<void>,
  discard: (item: ChatAttachment) => void,
) {
  if (!attachments.length) return submit()
  const attempt = generateUUID()
  const held = attachments.filter(item => {
    const key = unsentUploadKey(item.id)
    try {
      if (localStorage.getItem(key) !== "1") return false
      try { localStorage.setItem(`${key}/send/${attempt}`, "1") }
      catch { localStorage.removeItem(key); return false } // e.g. quota exceeded: keep the file.
      return true
    } catch { return false }
  })
  let notAdmitted = false
  try {
    await submit()
  } catch (error) {
    notAdmitted = error instanceof AttachmentsNotAdmittedError
    throw error
  } finally {
    for (const item of held) {
      const key = unsentUploadKey(item.id)
      try {
        if (!notAdmitted) {
          localStorage.removeItem(key)
          localStorage.removeItem(`${key}/discard`)
        }
        localStorage.removeItem(`${key}/send/${attempt}`)
        if (notAdmitted && localStorage.getItem(`${key}/discard`) && takeUnsentUpload(item.id)) discard(item)
      } catch { /* If the hold cannot be released, keep the file. */ }
    }
  }
}
