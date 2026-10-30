import type { ClientCommand } from "../shared/protocol"

type EnqueueCommand = Extract<ClientCommand, { type: "message.enqueue" }>

/** Keep enqueue + steer in one server request, using the same steer path as Send now.
 * The message is durably queued before steering, so a failed steer that leaves it
 * queued still succeeds as a plain enqueue: rejecting would keep the composer's
 * draft and a retry would queue a second copy. If auto-drain already started this
 * message, the requested outcome has happened.
 * This adapter leaves the coordinator untouched while its memory work is in flight.
 */
export async function enqueueAndMaybeSteer(
  command: EnqueueCommand,
  dependencies: {
    enqueue: (command: EnqueueCommand) => Promise<{ queuedMessageId: string }>
    steer: (command: Extract<ClientCommand, { type: "message.steer" }>) => Promise<void>
    isQueued: (chatId: string, messageId: string) => boolean
    isRunning: (chatId: string) => boolean
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
      if (dependencies.isQueued(command.chatId, result.queuedMessageId)) return result
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
