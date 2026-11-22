import { findMatchingActionBinding, getBindingsForAction, parseModifiers } from "../lib/keybindings"
import type { SidebarChatRow, SidebarProjectGroup, KeybindingsSnapshot } from "../../shared/types"

export const SIDEBAR_NUMBER_JUMP_LIMIT = 9
type ModifierKeyEvent = Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "getModifierState">>

export interface VisibleSidebarChat {
  chat: SidebarChatRow
  visibleIndex: number
}

export function getVisibleSidebarChats(
  projectGroups: SidebarProjectGroup[],
  collapsedSections: Set<string>,
  expandedGroups: Set<string>
): VisibleSidebarChat[] {
  const visibleChats: VisibleSidebarChat[] = []

  for (const group of projectGroups) {
    if (collapsedSections.has(group.groupKey)) {
      continue
    }

    const displayChats = expandedGroups.has(group.groupKey)
      ? [...group.previewChats, ...group.olderChats]
      : group.previewChats

    for (const chat of displayChats) {
      visibleChats.push({
        chat,
        visibleIndex: visibleChats.length + 1,
      })
    }
  }

  return visibleChats
}

export function getSidebarJumpTargetIndex(
  snapshot: KeybindingsSnapshot | null,
  event: ModifierKeyEvent & Pick<KeyboardEvent, "code">
): number | null {
  if (!shouldShowSidebarNumberJumpHints(snapshot, event)) return null
  if (!event.code.startsWith("Digit")) return null
  const digit = Number(event.code.slice("Digit".length))
  return Number.isInteger(digit) && digit >= 1 && digit <= SIDEBAR_NUMBER_JUMP_LIMIT ? digit : null
}

export function getSidebarNumberJumpHint(
  snapshot: KeybindingsSnapshot | null,
  visibleIndex: number
) {
  const binding = getSidebarActionBinding(snapshot, visibleIndex)
  return binding ? String(visibleIndex) : null
}

export function shouldShowSidebarNumberJumpHints(
  snapshot: KeybindingsSnapshot | null,
  event: ModifierKeyEvent
) {
  return getBindingsForAction(snapshot, "jumpToSidebarChat").some((binding) => bindingModifiersMatch(binding, event))
}

export function isSidebarModifierShortcut(
  snapshot: KeybindingsSnapshot | null,
  action: "createChatInCurrentProject" | "openAddProject",
  event: KeyboardEvent
): boolean {
  return findMatchingActionBinding(snapshot, action, event) !== null
}

function getSidebarActionBinding(snapshot: KeybindingsSnapshot | null, visibleIndex: number) {
  if (visibleIndex < 1 || visibleIndex > SIDEBAR_NUMBER_JUMP_LIMIT) {
    return null
  }

  return getBindingsForAction(snapshot, "jumpToSidebarChat")[0] ?? null
}

function bindingModifiersMatch(
  binding: string,
  event: ModifierKeyEvent
) {
  if (event.getModifierState?.("AltGraph")) return false
  const modifiers = parseModifiers(binding)
  return event.metaKey === modifiers.meta
    && event.altKey === modifiers.alt
    && event.ctrlKey === modifiers.ctrl
    && event.shiftKey === modifiers.shift
}
