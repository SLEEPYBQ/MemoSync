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
// Keep this one-way handoff separate from the draft snapshot: restoring a stale
// snapshot (including in another tab) must never restore permission to unlink.
const unsentUploadKey = (id: string) => `memosync.unsent-upload.${id}`

export function recordUnsentUpload(id: string) {
  try { localStorage.setItem(unsentUploadKey(id), "1") } catch { /* Detach only if storage is unavailable. */ }
}

export function takeUnsentUpload(id: string): boolean {
  try {
    const key = unsentUploadKey(id)
    if (localStorage.getItem(key) !== "1") return false
    localStorage.removeItem(key)
    return true
  } catch { return false }
}
