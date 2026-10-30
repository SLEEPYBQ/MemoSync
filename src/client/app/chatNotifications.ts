import type { ChatPreview, SidebarData } from "../../shared/types"

export function getNotificationTitleCount(sidebarData: SidebarData) {
  return sidebarData.projectGroups.reduce((count, group) => (
    count + group.chats.reduce((chatCount, chat) => (
      chatCount + (chat.unread ? 1 : 0) + (chat.status === "waiting_for_user" ? 1 : 0)
    ), 0)
  ), 0)
}

interface ChatNotificationSnapshot {
  unreadCount: number
  waitingChatIds: Set<string>
}

export function getChatNotificationSnapshot(sidebarData: SidebarData): ChatNotificationSnapshot {
  let unreadCount = 0
  const waitingChatIds = new Set<string>()

  for (const group of sidebarData.projectGroups) {
    for (const chat of group.chats) {
      if (chat.unread) unreadCount += 1
      if (chat.status === "waiting_for_user") {
        waitingChatIds.add(chat.chatId)
      }
    }
  }

  return { unreadCount, waitingChatIds }
}

export function getChatSoundBurstCount(previous: SidebarData | null, next: SidebarData): number {
  if (!previous) return 0

  const previousSnapshot = getChatNotificationSnapshot(previous)
  const nextSnapshot = getChatNotificationSnapshot(next)

  const unreadIncrease = Math.max(0, nextSnapshot.unreadCount - previousSnapshot.unreadCount)
  let newWaitingChats = 0
  for (const chatId of nextSnapshot.waitingChatIds) {
    if (!previousSnapshot.waitingChatIds.has(chatId)) {
      newWaitingChats += 1
    }
  }

  return unreadIncrease + newWaitingChats
}

export interface ChatNotificationEvent {
  chatId: string
  projectTitle: string
  chatTitle: string
  /**
   * Immediate waiting-for-response copy when the chat starts waiting.
   * `null` for a chat that only turned unread: the sidebar carries no message
   * previews, so showChatNotificationEvents fetches one via chat.getPreview,
   * falling back to "New chat activity." if unavailable.
   */
  message: string | null
}

/** Keep waiting notifications immediate and fetch at most once per unread event. */
export async function showChatNotificationEvents(args: {
  enabled: boolean
  events: ChatNotificationEvent[]
  loadPreview: (chatId: string) => Promise<ChatPreview | null>
  showNotification: (event: ChatNotificationEvent & { message: string }) => void
}): Promise<void> {
  if (!args.enabled) return
  await Promise.all(args.events.map(async (event) => {
    let message = event.message
    if (message === null) {
      try {
        const preview = await args.loadPreview(event.chatId)
        message = preview?.lastAgentMessagePreview || "New chat activity."
      } catch {
        message = "New chat activity."
      }
    }
    args.showNotification({ ...event, message })
  }))
}


/**
 * Per-chat, unlike the chime's net count: a chat read while another turned
 * unread still deserves its notification, and each one names its chat.
 */
export function getChatNotificationEvents(previous: SidebarData | null, next: SidebarData): ChatNotificationEvent[] {
  if (!previous) return []

  const previousChats = new Map<string, { unread: boolean; waiting: boolean }>()
  for (const group of previous.projectGroups) {
    for (const chat of group.chats) {
      previousChats.set(chat.chatId, {
        unread: chat.unread,
        waiting: chat.status === "waiting_for_user",
      })
    }
  }

  const events: ChatNotificationEvent[] = []
  for (const group of next.projectGroups) {
    for (const chat of group.chats) {
      const previousChat = previousChats.get(chat.chatId) ?? { unread: false, waiting: false }

      const becameUnread = chat.unread && !previousChat.unread
      const becameWaiting = chat.status === "waiting_for_user" && !previousChat.waiting
      if (!becameUnread && !becameWaiting) continue

      events.push({
        chatId: chat.chatId,
        projectTitle: group.title?.trim() || group.localPath,
        chatTitle: chat.title.trim() || "Untitled chat",
        message: becameWaiting ? "Waiting for your response." : null,
      })
    }
  }

  return events
}
