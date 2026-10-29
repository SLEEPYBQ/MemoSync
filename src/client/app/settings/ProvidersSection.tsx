import { useState } from "react"
import { PROVIDERS, type AgentProvider, type AppSettingsPatch } from "../../../shared/types"
import { ChatPreferenceControls } from "../../components/chat-ui/ChatPreferenceControls"
import { SelectItem } from "../../components/ui/select"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsErrorBanner, SettingsGroups, SettingsGroup, SettingsRow, SettingsSelect } from "./shared"

export function ProvidersSection({ state }: { state: Pick<AppState, "handleWriteAppSettings"> }) {
  const preferences = useChatPreferencesStore()
  const [error, setError] = useState<string | null>(null)
  async function save(patch: AppSettingsPatch) {
    try { setError(null); await state.handleWriteAppSettings(patch) }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to save provider settings.") }
  }
  return <>
    {error ? <SettingsErrorBanner message={error} /> : null}
    <SettingsGroups>
      <SettingsGroup title="Default Provider">
        <SettingsRow def={SETTINGS_ROWS.defaultProvider}>
          <SettingsSelect aria-label="Default Provider" value={preferences.defaultProvider} onValueChange={(value) => {
            preferences.setDefaultProvider(value as "last_used" | AgentProvider)
            void save({ defaultProvider: value as "last_used" | AgentProvider })
          }}>
            <SelectItem value="last_used">Last Used</SelectItem>
            {PROVIDERS.filter((provider) => provider.id === "claude").map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
          </SettingsSelect>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Model Defaults">
        <SettingsRow def={SETTINGS_ROWS.deepseekDefaults} wideControl alignStart>
          <div className="min-w-0 max-w-full @2xl:max-w-[420px]">
            <ChatPreferenceControls availableProviders={PROVIDERS.filter((provider) => provider.id === "claude")} selectedProvider="claude" showProviderPicker={false} providerLocked
              model={preferences.providerDefaults.claude.model} modelOptions={preferences.providerDefaults.claude.modelOptions}
              onModelChange={(_, model) => { preferences.setProviderDefaultModel("claude", model); void save({ providerDefaults: { claude: { model } } }) }}
              onModelOptionChange={(change) => {
                const modelOptions = change.type === "claudeReasoningEffort" ? { reasoningEffort: change.effort } : change.type === "contextWindow" ? { contextWindow: change.contextWindow } : null
                if (!modelOptions) return
                preferences.setProviderDefaultModelOptions("claude", modelOptions)
                void save({ providerDefaults: { claude: { modelOptions: { ...preferences.providerDefaults.claude.modelOptions, ...modelOptions } } } })
              }}
              planMode={preferences.providerDefaults.claude.planMode} onPlanModeChange={(planMode) => { preferences.setProviderDefaultPlanMode("claude", planMode); void save({ providerDefaults: { claude: { planMode } } }) }}
              includePlanMode className="justify-start flex-wrap" />
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsGroups>
  </>
}
