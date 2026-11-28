import React, { useEffect, useMemo, useState } from "react"
import { Image, Pressable, SectionList, StyleSheet, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { Ionicons } from "@expo/vector-icons"
import { radius, spacing, useTheme } from "../theme"
import { MOBILE_TYPOGRAPHY } from "../lib/typography"
import { getSocket, type SocketStatus } from "../lib/socket"
import { useHostStore } from "../lib/hostStore"
import { ListRow } from "../components/ui/ListRow"
import { StatusPill, type StatusPillTone } from "../components/StatusPill"
import type {
  ChatActivityStatus,
  LocalProjectsSnapshot,
  SidebarChatRow,
  SidebarData,
} from "../types"
import type { RootStackParamList } from "../navigation"

type Props = NativeStackScreenProps<RootStackParamList, "Projects">

interface ChatListItem {
  chatId: string
  title: string
  status: ChatActivityStatus
  unread: boolean
  provider: string | null
  lastMessageAt?: number
}

interface ProjectSection {
  key: string
  title: string
  localPath: string
  data: ChatListItem[]
}

function isBusy(status: ChatActivityStatus): boolean {
  return status === "running" || status === "starting" || status === "previewing_memory"
}

function statusLabel(status: ChatActivityStatus): string {
  switch (status) {
    case "running":
      return "Working"
    case "starting":
      return "Starting"
    case "previewing_memory":
      return "Preparing"
    case "waiting_for_user":
      return "Waiting"
    case "failed":
      return "Failed"
    default:
      return "Idle"
  }
}

function statusTone(status: ChatActivityStatus): StatusPillTone {
  if (isBusy(status)) return "success"
  if (status === "waiting_for_user") return "info"
  if (status === "failed") return "danger"
  return "neutral"
}

function statusDotColor(status: ChatActivityStatus, colors: ReturnType<typeof useTheme>["colors"]): string {
  if (isBusy(status)) return colors.success
  if (status === "waiting_for_user") return colors.info
  if (status === "failed") return colors.destructive
  return colors.mutedIcon
}

function formatChatTime(timestamp: number | undefined): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  const now = new Date()
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const dayDelta = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  const meridiem = hours >= 12 ? "PM" : "AM"
  if (dayDelta === 0) return `${hour12}:${minutes} ${meridiem}`
  if (dayDelta === 1) return "Yesterday"
  if (dayDelta > 1 && dayDelta < 7) return `${dayDelta} days ago`
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(-2)}`
}

function chatDescription(chat: ChatListItem): string | undefined {
  const pieces = [chat.provider ?? "", formatChatTime(chat.lastMessageAt)].filter(Boolean)
  return pieces.length ? pieces.join(" · ") : undefined
}

function chatAccessibilityLabel(chat: ChatListItem): string {
  const pieces = [
    chat.title || "Untitled chat",
    chat.unread ? "Unread" : undefined,
    statusLabel(chat.status),
    chatDescription(chat),
  ].filter((piece): piece is string => Boolean(piece))
  return pieces.join(", ")
}

function SectionPath({ path, colors }: { path: string; colors: ReturnType<typeof useTheme>["colors"] }) {
  return (
    <Text style={[styles.sectionPath, { color: colors.mutedIcon }]} numberOfLines={1} ellipsizeMode="middle">
      {path}
    </Text>
  )
}

/**
 * Project + chat list, kept live by subscribing the `sidebar` and
 * `local-projects` topics. Busy/idle pills update in place as the host pushes
 * fresh snapshots — no manual refresh.
 */
export function ProjectsScreen({ navigation }: Props) {
  const { colors } = useTheme()
  const credentials = useHostStore((s) => s.credentials)
  const [sidebar, setSidebar] = useState<SidebarData | null>(null)
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("disconnected")

  useEffect(() => {
    navigation.setOptions({
      title: localProjects?.machine.displayName ?? "MemoSync",
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={() => navigation.navigate("Settings")}
          hitSlop={10}
          style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
        >
          <Ionicons name="settings-outline" size={21} color={colors.mutedForeground} />
        </Pressable>
      ),
    })
  }, [navigation, localProjects?.machine.displayName, colors.mutedForeground])

  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const offStatus = socket.onStatus(setSocketStatus)
    const unsubSidebar = socket.subscribe<SidebarData>({ type: "sidebar" }, (value) => {
      if (value) setSidebar(value)
    })
    const unsubProjects = socket.subscribe<LocalProjectsSnapshot>({ type: "local-projects" }, (value) => {
      if (value) setLocalProjects(value)
    })
    return () => {
      offStatus()
      unsubSidebar()
      unsubProjects()
    }
  }, [credentials])

  const sections = useMemo<ProjectSection[]>(() => {
    if (!sidebar) return []
    const result = sidebar.projectGroups.map((group) => {
      const chats: SidebarChatRow[] = [...group.chats, ...(group.previewChats ?? []), ...(group.olderChats ?? [])]
      // De-duplicate: a chat may appear in both `chats` and the preview/older windows.
      const seen = new Set<string>()
      const rows: ChatListItem[] = []
      for (const chat of chats) {
        if (seen.has(chat.chatId)) continue
        seen.add(chat.chatId)
        rows.push({
          chatId: chat.chatId,
          title: chat.title,
          status: chat.status,
          unread: chat.unread,
          provider: chat.provider,
          lastMessageAt: chat.lastMessageAt,
        })
      }
      return {
        key: group.groupKey,
        title: group.sidebarTitle ?? group.title ?? group.realTitle,
        localPath: group.localPath,
        data: rows,
      }
    })
    // Local discovery can know about a project before it has any chats; the
    // sidebar only carries projects with chat rows. Keep those discovered or
    // saved projects visible instead of silently dropping them.
    const representedPaths = new Set(result.map((section) => section.localPath))
    for (const project of localProjects?.projects ?? []) {
      if (representedPaths.has(project.localPath)) continue
      result.push({
        key: `local:${project.localPath}`,
        title: project.title,
        localPath: project.localPath,
        data: [],
      })
    }
    return result
  }, [sidebar, localProjects])

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {socketStatus !== "connected" ? (
        <View style={styles.connectionRow}>
          <StatusPill
            label={socketStatus === "connecting" ? "Connecting to host" : "Connection lost — retrying"}
            tone={socketStatus === "connecting" ? "info" : "warning"}
            size="compact"
          />
        </View>
      ) : null}

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.chatId}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={sections.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyInner}>
            <Image source={require("../../assets/memosync-icon.png")} style={styles.emptyIcon} resizeMode="contain" />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              {sidebar ? "No chats yet" : "Loading projects"}
            </Text>
            <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>
              {sidebar
                ? "Start a chat on your computer and it will appear here."
                : "Reading the project list from your MemoSync host."}
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Text style={[styles.sectionTitle, { color: colors.sectionTitle }]} numberOfLines={1}>
                {section.title}
              </Text>
              <Text style={[styles.sectionCount, { color: colors.mutedIcon }]}>
                {section.data.length === 1 ? "1 chat" : `${section.data.length} chats`}
              </Text>
            </View>
            <SectionPath path={section.localPath} colors={colors} />
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? (
            <View style={styles.rowOuter}>
              <Text style={[styles.emptySectionText, { color: colors.mutedForeground }]}>No chats yet — start one in MemoSync on the host.</Text>
            </View>
          ) : null
        }
        renderItem={({ item, index, section }) => {
          const first = index === 0
          const last = index === section.data.length - 1
          return (
            <View style={styles.rowOuter}>
              <ListRow
                label={item.title || "Untitled chat"}
                description={chatDescription(item)}
                leading={
                  <View style={[styles.chatIconWell, { backgroundColor: colors.secondary }]}> 
                    <Ionicons name="chatbubble-outline" size={13} color={colors.mutedForeground} />
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusDotColor(item.status, colors), borderColor: colors.card },
                      ]}
                    />
                  </View>
                }
                accessory={
                  <>
                    {item.unread ? (
                      <View style={[styles.unreadDot, { backgroundColor: colors.success }]} />
                    ) : null}
                    <StatusPill label={statusLabel(item.status)} tone={statusTone(item.status)} size="compact" />
                  </>
                }
                accessibilityLabel={chatAccessibilityLabel(item)}
                onPress={() => navigation.navigate("Chat", { chatId: item.chatId, title: item.title })}
                style={[
                  styles.groupedRow,
                  {
                    borderColor: colors.border,
                    borderTopLeftRadius: first ? radius.lg : 0,
                    borderTopRightRadius: first ? radius.lg : 0,
                    borderBottomLeftRadius: last ? radius.lg : 0,
                    borderBottomRightRadius: last ? radius.lg : 0,
                    borderTopWidth: first ? StyleSheet.hairlineWidth : 0,
                  },
                ]}
              />
            </View>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
  },
  headerButtonPressed: {
    opacity: 0.55,
  },
  connectionRow: {
    alignItems: "center",
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  listContent: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.xxl,
  },
  sectionHeader: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    marginHorizontal: spacing.lg + spacing.xs,
    gap: spacing.xxs,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitle: {
    ...MOBILE_TYPOGRAPHY.label,
    fontWeight: "600",
    flexShrink: 1,
  },
  sectionCount: {
    ...MOBILE_TYPOGRAPHY.caption,
  },
  sectionPath: {
    ...MOBILE_TYPOGRAPHY.caption,
  },
  rowOuter: {
    marginHorizontal: spacing.lg,
  },
  emptySectionText: {
    ...MOBILE_TYPOGRAPHY.footnote,
    paddingVertical: spacing.sm,
  },
  groupedRow: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
  },
  chatIconWell: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 9,
    height: 9,
    borderRadius: radius.full,
    borderWidth: 2,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyInner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
    gap: spacing.sm,
  },
  emptyIcon: {
    width: 58,
    height: 58,
    marginBottom: spacing.sm,
    opacity: 0.92,
  },
  emptyTitle: {
    ...MOBILE_TYPOGRAPHY.headline,
  },
  emptyBody: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
    textAlign: "center",
    maxWidth: 290,
  },
})
