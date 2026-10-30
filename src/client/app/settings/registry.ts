import { t } from "../../i18n"
import { Bell, BookText, Boxes, Brain, Command, Info, Palette, ScrollText, Settings2 } from "lucide-react"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import { KEYBINDING_ACTION_LABELS } from "../../lib/keybindings"
import type { KeybindingAction } from "../../../shared/types"

/** Navigation and stable row anchors; a future command palette can consume these directly. */
export type SettingsNavGroup = "preferences" | "agents" | "other"

export const SETTINGS_NAV_GROUPS: readonly { id: SettingsNavGroup; readonly label: string }[] = [
  { id: "preferences", get label() { return t("settings:navPreferences") } },
  { id: "agents", get label() { return t("settings:navAgents") } },
  { id: "other", get label() { return t("settings:navOther") } },
]

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    group: "preferences",
    get label() { return t("settings:general") },
    icon: Settings2,
    get subtitle() { return t("settings:generalSubtitle") },
  },
  {
    id: "appearance",
    group: "preferences",
    get label() { return t("settings:appearance") },
    icon: Palette,
    get subtitle() { return t("settings:appearanceSubtitle") },
  },
  {
    id: "notifications",
    group: "preferences",
    get label() { return t("settings:notifications") },
    icon: Bell,
    get subtitle() { return t("settings:notificationsSubtitle") },
  },
  {
    id: "providers",
    group: "agents",
    get label() { return t("settings:models") },
    icon: Boxes,
    get subtitle() { return t("settings:modelsSubtitle") },
  },
  {
    id: "memory",
    group: "agents",
    get label() { return t("common:memory") },
    icon: Brain,
    get subtitle() { return t("settings:chooseWhetherTheAgentUsesAndLearnsMemoriesAndHow") },
  },
  {
    id: "skills",
    group: "agents",
    get label() { return t("settings:skills") },
    icon: BookText,
    get subtitle() { return t("settings:manageGloballyInstalledAgentSkillsFromTheActiveSkillLock") },
  },
  {
    id: "keybindings",
    group: "other",
    get label() { return t("settings:keybindings") },
    icon: Command,
    get subtitle() { return t("settings:editGlobalAppShortcutsStoredInTheActiveKeybindingsFile") },
  },
  {
    id: "about",
    group: "other",
    get label() { return t("settings:about") },
    icon: Info,
    get subtitle() { return t("settings:aboutSubtitle") },
  },
  ...(SELF_UPDATE_ENABLED
    ? [
        {
          id: "changelog",
          group: "other",
          get label() { return t("settings:changelog") },
          icon: ScrollText,
          get subtitle() { return t("settings:releaseNotesPulledFromThePublicGitHubReleasesFeed") },
        } as const,
      ]
    : []),
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]

export interface SettingsRowDef {
  id: string
  sectionId: SettingsSectionId
  title: string
  description: string
  keywords?: string[]
}

export function defineRows<TIds extends string>(rows: { [TId in TIds]: Omit<SettingsRowDef, "id"> }): {
  [TId in TIds]: SettingsRowDef
} {
  return Object.fromEntries(
    Object.entries<Omit<SettingsRowDef, "id">>(rows).map(([id, row]) => [id, Object.defineProperty(row, "id", { value: id, enumerable: true })]),
  ) as { [TId in TIds]: SettingsRowDef }
}

export function resolveSettingsSectionId(sectionId: string | undefined): SettingsSectionId | null {
  return SETTINGS_SECTIONS.some((section) => section.id === sectionId) ? (sectionId as SettingsSectionId) : null
}

export const SETTINGS_ROWS = defineRows({
  applicationUpdate: {
    sectionId: "about",
    get title() { return t("settings:applicationUpdate") },
    get description() { return t("settings:currentVersionAndUpdateStatus") },
  },
  language: {
    sectionId: "appearance",
    get title() { return t("settings:language") },
    get description() { return t("settings:chooseTheInterfaceLanguageChangesApplyImmediately") },
    get keywords() { return t("settings:searchKeywords0").split(",") },
  },
  theme: {
    sectionId: "appearance",
    get title() { return t("settings:theme") },
    get description() { return t("settings:lightDarkOrMatchTheSystemAppearance") },
    get keywords() { return t("settings:searchKeywords1").split(",") },
  },
  chatSounds: {
    sectionId: "notifications",
    get title() { return t("settings:chatSounds") },
    get description() { return t("settings:playASoundWhenAChatStartsWaitingOnYou") },
  },
  chatSound: {
    sectionId: "notifications",
    get title() { return t("settings:soundEffect") },
    get description() { return t("settings:theSoundChatNotificationsPlayPickingOnePlaysAPreview") },
  },
  chatBrowserNotifications: {
    sectionId: "notifications",
    get title() { return t("settings:systemNotifications") },
    get description() { return t("settings:showASystemNotificationWhenAChatStartsWaitingOn") },
    get keywords() { return t("settings:searchKeywords2").split(",") },
  },
  submitWhileRunning: {
    sectionId: "general",
    get title() { return t("settings:enterWhileRunning") },
    get description() { return t("settings:whatEnterDoesWhileAnAgentIsWorkingCmdCtrl") },
    get keywords() { return t("settings:searchKeywords3").split(",") },
  },
  defaultEditor: { sectionId: "general", get title() { return t("settings:defaultEditor") }, get description() { return t("settings:theEditorUsedByOpenInEditor") } },
  editorCommandTemplate: {
    sectionId: "general",
    get title() { return t("settings:commandTemplate") },
    get description() { return t("settings:includePathAndOptionallyLineAndColumnInYourCommand") },
  },
  terminalScrollback: {
    sectionId: "general",
    get title() { return t("settings:terminalScrollback") },
    get description() { return t("settings:linesRetainedForEmbeddedTerminalHistory") },
  },
  terminalMinColumnWidth: {
    sectionId: "general",
    get title() { return t("settings:terminalMinColumnWidth") },
    get description() { return t("settings:minimumWidthForEachTerminalPane") },
  },
  memoryControl: {
    sectionId: "memory",
    get title() { return t("settings:memoryControl") },
    get description() { return t("settings:memoryControlDescription") },
    keywords: ["control", "automatic", "review each turn", "控制方式", "自动", "每轮确认"],
  },
  memoryEnabled: {
    sectionId: "memory",
    get title() { return t("settings:useMemory") },
    get description() { return t("settings:letTheAgentUseYourMemoriesAndLearnNewOnes") },
  },
  memoryLearn: {
    sectionId: "memory",
    get title() { return t("settings:learnFromChats") },
    get description() { return t("settings:suggestNewMemoriesAndUpdatesFromConversationsTurnOffTo") },
  },
  memoryPreview: {
    sectionId: "memory",
    get title() { return t("settings:memoryPreview") },
    get description() { return t("settings:beforeEachTurnShowWhichMemoriesTheAgentBringsAnd") },
  },
  memoryAutoProceed: {
    sectionId: "memory",
    get title() { return t("settings:autoProceedWhenNoMemoryApplies") },
    get description() { return t("settings:skipThePreviewPauseWhenThePlanInvolvesNoMemories") },
  },
  memoryChanges: {
    sectionId: "memory",
    get title() { return t("settings:memoryChanges") },
    get description() { return t("settings:askFirstHoldsEveryProposalForYourReviewApplyAutomatically") },
  },
  modelEngines: {
    sectionId: "providers",
    get title() { return t("modelAccess:engines") },
    get description() { return t("modelAccess:enginesDescription") },
    get keywords() { return t("modelAccess:searchKeywords").split(",") },
  },
  apiConnections: {
    sectionId: "providers",
    get title() { return t("modelAccess:connections") },
    get description() { return t("modelAccess:connectionsDescription") },
    get keywords() { return t("modelAccess:searchKeywords").split(",") },
  },
  defaultProvider: {
    sectionId: "providers",
    get title() { return t("settings:defaultProvider") },
    get description() { return t("settings:theDefaultHarnessUsedForNewChatsBeforeAProvider") },
  },
  claudeDefaults: {
    sectionId: "providers",
    get title() { return t("settings:claudeCodeDefaults") },
    get description() { return t("settings:savedModelAndReasoningSettingsForNewClaudeCodeChats") },
    get keywords() { return t("settings:searchKeywords4").split(",") },
  },
  codexDefaults: {
    sectionId: "providers",
    get title() { return t("settings:codexDefaults") },
    get description() { return t("settings:savedModelAndReasoningSettingsForNewCodexChats") },
  },
  piDefaults: {
    sectionId: "providers",
    get title() { return t("settings:piDefaults") },
    get description() { return t("settings:savedModelAndReasoningSettingsForNewPiChats") },
  },
  installedSkills: { sectionId: "skills", get title() { return t("settings:installed") }, get description() { return t("settings:globallyInstalledAgentSkills") } },
  discoverSkills: { sectionId: "skills", get title() { return t("settings:discover") }, get description() { return t("settings:searchSkillsToInstallGlobally") } },
})

export const KEYBINDING_ROWS: Record<Exclude<KeybindingAction, "openInEditor">, SettingsRowDef> = Object.fromEntries(
  (Object.entries(KEYBINDING_ACTION_LABELS) as [KeybindingAction, string][])
    .filter(([action]) => action !== "openInEditor")
    .map(([action]) => [
      action,
      { id: `keybinding-${action}`, sectionId: "keybindings", get title() { return KEYBINDING_ACTION_LABELS[action] }, get description() { return t("settings:commaSeparatedShortcuts") } },
    ]),
) as Record<Exclude<KeybindingAction, "openInEditor">, SettingsRowDef>

export const ALL_SETTINGS_ROWS = [
  ...Object.values(SETTINGS_ROWS),
  ...Object.values(KEYBINDING_ROWS),
] as SettingsRowDef[]

export function getSettingsRowHref(row: SettingsRowDef) {
  return `/settings/${row.sectionId}#${row.id}`
}
