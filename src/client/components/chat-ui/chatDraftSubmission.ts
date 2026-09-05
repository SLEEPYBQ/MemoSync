/**
 * Keep a participant's persisted composer draft intact while an async submit
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
