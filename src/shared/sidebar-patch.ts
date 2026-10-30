import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "./types"

/**
 * Incremental sidebar pushes, for clients that ask for them
 * (`{ type: "sidebar", patches: true }`).
 *
 * The full snapshot is ~500 KB on a machine with a few hundred chats, and a
 * running turn changes one row of it several times a second. Sending it whole
 * meant deflating half a megabyte on the server's main thread per socket per
 * change, the largest single cost in a profile of a busy server. A patch
 * carries the rows and group headers whose serialization changed, plus the
 * row lists of the groups whose membership or order moved.
 *
 * Opt-in because the iOS app decodes `sidebar` snapshots as `SidebarData` and
 * does not know this shape; subscribers that don't ask keep full snapshots.
 *
 * Revisions make a patch safe to apply: `from` names the snapshot it was
 * computed against and `to` the one it produces. `from: null` is a reset that
 * carries everything, and is what every (re)subscribe starts with. A client
 * holding anything other than `from` must resubscribe.
 */

type RowListKey = "chats" | "previewChats" | "olderChats" | "archivedChats"

export type SidebarGroupHeader = Omit<SidebarProjectGroup, RowListKey>

export interface SidebarGroupLists {
  groupKey: string
  chats: string[]
  previewChats: string[]
  olderChats: string[]
  /** Present exactly when the group has archived chats, like the group field. */
  archivedChats?: string[]
}

export interface SidebarPatch {
  from: number | null
  to: number
  /** Every group key, in order. Groups not named here are gone. */
  order: string[]
  /** Headers of groups that are new or changed. */
  headers?: SidebarGroupHeader[]
  /** Row lists of groups that are new or whose lists changed, as chat ids. */
  lists?: SidebarGroupLists[]
  /** Rows that are new or changed, from any group. */
  rows?: SidebarChatRow[]
}

/**
 * Each part of a snapshot serialized once, so two snapshots diff by string
 * comparison. Built once per derived snapshot and shared by every socket.
 */
export interface SidebarIndex {
  order: string[]
  headers: Map<string, { value: SidebarGroupHeader; json: string }>
  lists: Map<string, { value: SidebarGroupLists; json: string }>
  rows: Map<string, { value: SidebarChatRow; json: string }>
}

function splitGroup(group: SidebarProjectGroup): { header: SidebarGroupHeader; lists: SidebarGroupLists } {
  const { chats, previewChats, olderChats, archivedChats, ...header } = group
  const ids = (rows: SidebarChatRow[]) => rows.map((row) => row.chatId)
  return {
    header,
    lists: {
      groupKey: group.groupKey,
      chats: ids(chats),
      previewChats: ids(previewChats),
      olderChats: ids(olderChats),
      ...(archivedChats ? { archivedChats: ids(archivedChats) } : {}),
    },
  }
}

/**
 * Null when the snapshot can't be expressed as a patch: rows are keyed by chat
 * id across the whole snapshot, so one id carrying two different rows (never
 * expected; a chat has one project) sends that subscriber full snapshots.
 */
export function indexSidebarData(data: SidebarData): SidebarIndex | null {
  const index: SidebarIndex = { order: [], headers: new Map(), lists: new Map(), rows: new Map() }
  for (const group of data.projectGroups) {
    const { header, lists } = splitGroup(group)
    index.order.push(group.groupKey)
    index.headers.set(group.groupKey, { value: header, json: JSON.stringify(header) })
    index.lists.set(group.groupKey, { value: lists, json: JSON.stringify(lists) })
    for (const rowList of [group.chats, group.previewChats, group.olderChats, group.archivedChats ?? []]) {
      for (const row of rowList) {
        const existing = index.rows.get(row.chatId)
        // `previewChats` and `olderChats` hold the same objects as `chats`.
        if (existing?.value === row) continue
        const json = JSON.stringify(row)
        if (existing && existing.json !== json) return null
        index.rows.set(row.chatId, { value: row, json })
      }
    }
  }
  return index
}

/** What turns `previous` (null for a reset) into `next`. */
export function diffSidebarIndex(
  previous: SidebarIndex | null,
  next: SidebarIndex,
  from: number | null,
  to: number
): SidebarPatch {
  const headers: SidebarGroupHeader[] = []
  const lists: SidebarGroupLists[] = []
  const rows: SidebarChatRow[] = []
  for (const [key, entry] of next.headers) {
    if (previous?.headers.get(key)?.json !== entry.json) headers.push(entry.value)
  }
  for (const [key, entry] of next.lists) {
    if (previous?.lists.get(key)?.json !== entry.json) lists.push(entry.value)
  }
  for (const [chatId, entry] of next.rows) {
    if (previous?.rows.get(chatId)?.json !== entry.json) rows.push(entry.value)
  }
  return {
    from,
    to,
    order: next.order,
    ...(headers.length ? { headers } : {}),
    ...(lists.length ? { lists } : {}),
    ...(rows.length ? { rows } : {}),
  }
}

/**
 * The snapshot a patch produces. `previous` must be the snapshot at
 * `patch.from` (ignored for a reset). Throws if the patch names something
 * neither side has, which means the two were not a pair.
 */
export function applySidebarPatch(previous: SidebarData | null, patch: SidebarPatch): SidebarData {
  const base = patch.from === null ? null : previous
  const headers = new Map<string, SidebarGroupHeader>()
  const lists = new Map<string, SidebarGroupLists>()
  const rows = new Map<string, SidebarChatRow>()
  for (const group of base?.projectGroups ?? []) {
    const split = splitGroup(group)
    headers.set(group.groupKey, split.header)
    lists.set(group.groupKey, split.lists)
    for (const rowList of [group.chats, group.previewChats, group.olderChats, group.archivedChats ?? []]) {
      for (const row of rowList) rows.set(row.chatId, row)
    }
  }
  for (const header of patch.headers ?? []) headers.set(header.groupKey, header)
  for (const groupLists of patch.lists ?? []) lists.set(groupLists.groupKey, groupLists)
  for (const row of patch.rows ?? []) rows.set(row.chatId, row)

  const resolve = (ids: string[]) => ids.map((chatId) => {
    const row = rows.get(chatId)
    if (!row) throw new Error(`sidebar patch ${patch.from}→${patch.to} names unknown chat ${chatId}`)
    return row
  })
  return {
    projectGroups: patch.order.map((groupKey) => {
      const header = headers.get(groupKey)
      const groupLists = lists.get(groupKey)
      if (!header || !groupLists) throw new Error(`sidebar patch ${patch.from}→${patch.to} names unknown group ${groupKey}`)
      return {
        ...header,
        chats: resolve(groupLists.chats),
        previewChats: resolve(groupLists.previewChats),
        olderChats: resolve(groupLists.olderChats),
        ...(groupLists.archivedChats ? { archivedChats: resolve(groupLists.archivedChats) } : {}),
      }
    }),
  }
}
