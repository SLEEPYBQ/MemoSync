import { BookText, Brain, Command, MessageSquareQuote, ScrollText, Settings2 } from "lucide-react"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import { KEYBINDING_ACTION_LABELS } from "../../lib/keybindings"
import type { KeybindingAction } from "../../../shared/types"

/** Navigation and stable row anchors; a future command palette can consume these directly. */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: Settings2, subtitle: "Appearance, notifications, chats, editor, and terminal." },
  { id: "memory", label: "Memory", icon: Brain, subtitle: "Choose whether the agent uses and learns memories, and how it checks with you." },
  { id: "providers", label: "Providers", icon: MessageSquareQuote, subtitle: "Manage the default chat provider and saved DeepSeek model defaults." },
  { id: "skills", label: "Skills", icon: BookText, subtitle: "Manage globally installed agent skills from the active skill lock file." },
  { id: "keybindings", label: "Keybindings", icon: Command, subtitle: "Edit global app shortcuts stored in the active keybindings file." },
  ...(SELF_UPDATE_ENABLED ? [{ id: "changelog", label: "Changelog", icon: ScrollText, subtitle: "Release notes pulled from the public GitHub releases feed." } as const] : []),
] as const
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]
export interface SettingsRowDef {
  id: string
  sectionId: SettingsSectionId
  title: string
  description: string
  keywords?: string[]
}
export function defineRows<TIds extends string>(rows: { [TId in TIds]: Omit<SettingsRowDef, "id"> }): { [TId in TIds]: SettingsRowDef } {
  return Object.fromEntries(Object.entries<Omit<SettingsRowDef, "id">>(rows).map(([id, row]) => [id, { ...row, id }])) as { [TId in TIds]: SettingsRowDef }
}
export function resolveSettingsSectionId(sectionId: string | undefined): SettingsSectionId | null {
  return SETTINGS_SECTIONS.some((section) => section.id === sectionId) ? sectionId as SettingsSectionId : null
}
export const SETTINGS_ROWS = defineRows({
  applicationUpdate: { sectionId: "general", title: "Application Update", description: "Current version and update status." },
  theme: { sectionId: "general", title: "Theme", description: "Light, dark, or match the system appearance.", keywords: ["appearance"] },
  chatSounds: { sectionId: "general", title: "Chat Sounds", description: "Play a sound when a chat starts waiting on you or the unread count goes up." },
  chatSound: { sectionId: "general", title: "Sound Effect", description: "The sound chat notifications play. Picking one plays a preview." },
  chatBrowserNotifications: { sectionId: "general", title: "System Notifications", description: "Show a system notification when a chat starts waiting on you or turns unread.", keywords: ["browser", "desktop", "permission"] },
  submitWhileRunning: { sectionId: "general", title: "Enter While Running", description: "What Enter does while an agent is working. Cmd/Ctrl+Enter does the other one. With nothing typed, Cmd/Ctrl+Enter sends the oldest queued message now.", keywords: ["queue", "steer", "composer"] },
  defaultEditor: { sectionId: "general", title: "Default Editor", description: "The editor used by Open in Editor." },
  editorCommandTemplate: { sectionId: "general", title: "Command Template", description: "Include {path} and optionally {line} and {column} in your command." },
  terminalScrollback: { sectionId: "general", title: "Terminal Scrollback", description: "Lines retained for embedded terminal history." },
  terminalMinColumnWidth: { sectionId: "general", title: "Terminal Min Column Width", description: "Minimum width for each terminal pane." },
  memoryEnabled: { sectionId: "memory", title: "Use Memory", description: "Let the agent use your memories and learn new ones. When off, chats run without memory; your saved memories stay on the Memory Board." },
  memoryLearn: { sectionId: "memory", title: "Learn From Chats", description: "Suggest new memories and updates from conversations. Turn off to keep using your memories without adding to them." },
  memoryPreview: { sectionId: "memory", title: "Memory Preview", description: "Before each turn, show which memories the agent brings and how they shape its plan — you decide to go on, proceed without memory, or dismiss." },
  memoryAutoProceed: { sectionId: "memory", title: "Auto-proceed When No Memory Applies", description: "Skip the preview pause when the plan involves no memories (the preview is still recorded in the transcript)." },
  memoryChanges: { sectionId: "memory", title: "Memory Changes", description: "Ask First holds every proposal for your review. Apply Automatically applies non-sensitive proposals immediately; each still shows in the transcript with a one-click Revert. Sensitive proposals still ask." },
  defaultProvider: { sectionId: "providers", title: "Default Provider", description: "The default harness used for new chats before a provider is locked by an existing session." },
  deepseekDefaults: { sectionId: "providers", title: "DeepSeek Defaults", description: "Saved defaults for DeepSeek through the Claude Code adapter." },
  installedSkills: { sectionId: "skills", title: "Installed", description: "Globally installed agent skills." },
  discoverSkills: { sectionId: "skills", title: "Discover", description: "Search skills to install globally." },
})
export const KEYBINDING_ROWS: Record<Exclude<KeybindingAction, "openInEditor">, SettingsRowDef> = Object.fromEntries(
  (Object.entries(KEYBINDING_ACTION_LABELS) as [KeybindingAction, string][])
    .filter(([action]) => action !== "openInEditor")
    .map(([action, title]) => [action, { id: `keybinding-${action}`, sectionId: "keybindings", title, description: "Comma-separated shortcuts." }])
) as Record<Exclude<KeybindingAction, "openInEditor">, SettingsRowDef>
export const ALL_SETTINGS_ROWS = [...Object.values(SETTINGS_ROWS), ...Object.values(KEYBINDING_ROWS)] as SettingsRowDef[]
export function getSettingsRowHref(row: SettingsRowDef) { return `/settings/${row.sectionId}#${row.id}` }
