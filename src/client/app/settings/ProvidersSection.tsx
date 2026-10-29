import { useState } from "react"
import type { AgentProvider, AppSettingsPatch, ClaudeModelOptions, CodexModelOptions, PiModelOptions } from "../../../shared/types"
import { ChatPreferenceControls, type ModelOptionChange } from "../../components/chat-ui/ChatPreferenceControls"
import { SelectItem } from "../../components/ui/select"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS, type SettingsRowDef } from "./registry"
import { SettingsErrorBanner, SettingsGroups, SettingsGroup, SettingsRow, SettingsSelect } from "./shared"

const DEFAULTS_ROWS: Record<AgentProvider, SettingsRowDef> = {
  claude: SETTINGS_ROWS.claudeDefaults,
  codex: SETTINGS_ROWS.codexDefaults,
  pi: SETTINGS_ROWS.piDefaults,
}

/** The option a picker change sets on that provider's saved defaults, if it is one this provider has. */
function modelOptionsPatch(provider: AgentProvider, change: ModelOptionChange): Partial<ClaudeModelOptions | CodexModelOptions | PiModelOptions> | null {
  switch (change.type) {
    case "claudeReasoningEffort":
      return provider === "claude" ? { reasoningEffort: change.effort } : null
    case "contextWindow":
      return provider === "claude" ? { contextWindow: change.contextWindow } : null
    case "codexReasoningEffort":
      return provider === "codex" ? { reasoningEffort: change.effort } : null
    case "fastMode":
      return provider === "codex" ? { fastMode: change.fastMode } : null
    case "piReasoningEffort":
      return provider === "pi" ? { reasoningEffort: change.effort } : null
    default:
      return null
  }
}

export function ProvidersSection({ state }: { state: Pick<AppState, "handleWriteAppSettings" | "availableProviders"> }) {
  const preferences = useChatPreferencesStore()
  const [error, setError] = useState<string | null>(null)
  const providers = state.availableProviders

  async function save(patch: AppSettingsPatch) {
    try {
      setError(null)
      await state.handleWriteAppSettings(patch)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save provider settings.")
    }
  }

  function renderDefaults(provider: AgentProvider) {
    const defaults = preferences.providerDefaults[provider]
    return (
      <SettingsRow key={provider} def={DEFAULTS_ROWS[provider]} wideControl alignStart>
        <div className="min-w-0 max-w-full @2xl:max-w-[420px]">
          <ChatPreferenceControls
            availableProviders={providers}
            selectedProvider={provider}
            showProviderPicker={false}
            providerLocked
            model={defaults.model}
            modelOptions={defaults.modelOptions}
            onModelChange={(_, model) => {
              preferences.setProviderDefaultModel(provider, model)
              void save({ providerDefaults: { [provider]: { model } } })
            }}
            onModelOptionChange={(change) => {
              const modelOptions = modelOptionsPatch(provider, change)
              if (!modelOptions) return
              preferences.setProviderDefaultModelOptions(provider, modelOptions)
              void save({ providerDefaults: { [provider]: { modelOptions: { ...defaults.modelOptions, ...modelOptions } } } })
            }}
            planMode={defaults.planMode}
            onPlanModeChange={(planMode) => {
              preferences.setProviderDefaultPlanMode(provider, planMode)
              void save({ providerDefaults: { [provider]: { planMode } } })
            }}
            includePlanMode={provider !== "pi"}
            className="justify-start flex-wrap"
          />
        </div>
      </SettingsRow>
    )
  }

  return (
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <SettingsGroups>
        <SettingsGroup title="Default Provider">
          <SettingsRow def={SETTINGS_ROWS.defaultProvider}>
            <SettingsSelect
              aria-label="Default Provider"
              value={preferences.defaultProvider}
              onValueChange={(value) => {
                preferences.setDefaultProvider(value as "last_used" | AgentProvider)
                void save({ defaultProvider: value as "last_used" | AgentProvider })
              }}
            >
              <SelectItem value="last_used">Last Used</SelectItem>
              {providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.id === "claude" ? "Claude Code" : provider.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Model Defaults">
          {renderDefaults("claude")}
          {providers.some((provider) => provider.id === "codex") ? renderDefaults("codex") : null}
          {providers.some((provider) => provider.id === "pi") ? renderDefaults("pi") : null}
        </SettingsGroup>
      </SettingsGroups>
    </>
  )
}
