import type { ClientCommand } from "../shared/protocol"

type EnqueueCommand = Extract<ClientCommand, { type: "message.enqueue" }>

/** Keep enqueue + steer in one server request, using the same steer path as Send now.
 * The message is durably queued before steering. If steer only found the chat still
 * busy, it stays queued and the request succeeds as a plain enqueue: rejecting would
 * keep the composer's draft and a retry would queue a second copy. Any other refusal
 * removes the queued copy before rejecting, so a refused prompt can't drain later.
 * If auto-drain already started this message, the requested outcome has happened.
 * This adapter leaves the coordinator untouched while its memory work is in flight.
 */
export async function enqueueAndMaybeSteer(
  command: EnqueueCommand,
  dependencies: {
    enqueue: (command: EnqueueCommand) => Promise<{ queuedMessageId: string }>
    steer: (command: Extract<ClientCommand, { type: "message.steer" }>) => Promise<void>
    isQueued: (chatId: string, messageId: string) => boolean
    isRunning: (chatId: string) => boolean
    remove: (chatId: string, messageId: string) => Promise<void>
  },
) {
  const result = await dependencies.enqueue(command)
  if (command.steer) {
    try {
      await dependencies.steer({
        type: "message.steer",
        chatId: command.chatId,
        queuedMessageId: result.queuedMessageId,
      })
    } catch (error) {
      if (dependencies.isQueued(command.chatId, result.queuedMessageId)) {
        if (error instanceof Error && error.message === "Chat is still running") return result
        await dependencies.remove(command.chatId, result.queuedMessageId)
        throw error
      }
      if (
        !(
          error instanceof Error &&
          error.message === "Queued message not found" &&
          dependencies.isRunning(command.chatId)
        )
      ) {
        throw error
      }
    }
  }
  return result
}
