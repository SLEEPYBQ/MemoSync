import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { EngineCard } from "./EngineCard"
import { ConnectionDialog, ConnectionsSection } from "./ConnectionsSection"
import { useModelAccessStore } from "../../model-access/modelAccess"
import { useState } from "react"
import type { ApiProtocol } from "../../../shared/model-access"
import type {
  AgentProvider,
  AppSettingsPatch,
  ClaudeModelOptions,
  CodexModelOptions,
  PiModelOptions,
} from "../../../shared/types"
import { ChatPreferenceControls, type ModelOptionChange } from "../../components/chat-ui/ChatPreferenceControls"
import { SelectItem } from "../../components/ui/select"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS, type SettingsRowDef } from "./registry"
import {
  SettingsErrorBanner,
  SettingsGroups,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsGroupHeading,
} from "./shared"

const DEFAULTS_ROWS: Record<AgentProvider, SettingsRowDef> = {
  claude: SETTINGS_ROWS.claudeDefaults,
  codex: SETTINGS_ROWS.codexDefaults,
  pi: SETTINGS_ROWS.piDefaults,
}

/** The option a picker change sets on that provider's saved defaults, if it is one this provider has. */
function modelOptionsPatch(
  provider: AgentProvider,
  change: ModelOptionChange,
): Partial<ClaudeModelOptions | CodexModelOptions | PiModelOptions> | null {
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

export function ProvidersSection({
  state,
}: {
  state: Pick<AppState, "handleWriteAppSettings" | "availableProviders"> & Partial<Pick<AppState, "socket">>
}) {
  useI18n()
  const preferences = useChatPreferencesStore()
  const [error, setError] = useState<string | null>(null)
  const providers = state.availableProviders
  const snapshot = useModelAccessStore((s) => s.snapshot)
  const [adding, setAdding] = useState<{ protocol?: ApiProtocol } | null>(null)

  async function save(patch: AppSettingsPatch) {
    try {
      setError(null)
      await state.handleWriteAppSettings(patch)
    } catch (error) {
      setError(error instanceof Error ? error.message : t("settings:unableToSaveProviderSettings"))
    }
  }

  function renderDefaults(provider: AgentProvider) {
    const defaults = preferences.providerDefaults[provider]
    const setup = snapshot?.engines[provider].setup
    const access = setup?.access
    return (
      <SettingsRow
        key={provider}
        def={DEFAULTS_ROWS[provider]}
        title={t("modelAccess:defaults")}
        description={null}
        wideControl
        alignStart
      >
        <div className="min-w-0 max-w-full @2xl:max-w-[420px]">
          <ChatPreferenceControls
            availableProviders={providers}
            selectedProvider={provider}
            showProviderPicker={false}
            useModelAccess={access?.mode === "connection"}
            selectedConnectionOnly
            connectionId={access?.mode === "connection" ? access.connectionId : undefined}
            providerLocked
            model={
              access?.mode === "connection"
                ? (access.defaultModel ??
                  snapshot?.connections.find((connection) => connection.id === access.connectionId)?.models[0]?.id ??
                  t("modelAccess:chooseModel"))
                : defaults.model
            }
            modelOptions={defaults.modelOptions}
            onModelChange={(_, model) => {
              if (setup && access?.mode === "connection" && state.socket) {
                setError(null)
                void state.socket
                  .command({
                    type: "modelAccess.setEngine",
                    engine: provider,
                    setup: { ...setup, access: { ...access, defaultModel: model } },
                  })
                  .catch((reason) =>
                    setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed")),
                  )
                return
              }
              preferences.setProviderDefaultModel(provider, model)
              void save({ providerDefaults: { [provider]: { model } } })
            }}
            onModelOptionChange={(change) => {
              const modelOptions = modelOptionsPatch(provider, change)
              if (!modelOptions) return
              preferences.setProviderDefaultModelOptions(provider, modelOptions)
              void save({
                providerDefaults: { [provider]: { modelOptions: { ...defaults.modelOptions, ...modelOptions } } },
              })
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
    <div className="model-access-ui @container">
      {error ? <SettingsErrorBanner message={translateUiText(error)} /> : null}
      <SettingsGroups>
        <SettingsGroup title={t("settings:defaultProvider")}>
          <SettingsRow def={SETTINGS_ROWS.defaultProvider}>
            <SettingsSelect
              aria-label={t("settings:defaultProvider")}
              value={preferences.defaultProvider}
              onValueChange={(value) => {
                preferences.setDefaultProvider(value as "last_used" | AgentProvider)
                void save({ defaultProvider: value as "last_used" | AgentProvider })
              }}
            >
              <SelectItem value="last_used">{t("settings:lastUsed")}</SelectItem>
              {providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.id === "claude" ? "Claude Code" : provider.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
        <section id={SETTINGS_ROWS.modelEngines.id} className="space-y-3">
          <SettingsGroupHeading>{t("modelAccess:engines")}</SettingsGroupHeading>
          {(["claude", "codex", "pi"] as const).map((engine) => (
            <EngineCard
              key={engine}
              engine={engine}
              status={snapshot?.engines[engine]}
              connections={snapshot?.connections ?? []}
              socket={state.socket}
              onAddConnection={(protocol) => setAdding({ protocol })}
            >
              {renderDefaults(engine)}
            </EngineCard>
          ))}
        </section>
        <div id={SETTINGS_ROWS.apiConnections.id}>
          <ConnectionsSection
            connections={snapshot?.connections ?? []}
            presets={snapshot?.presets ?? []}
            socket={state.socket}
            onAddConnection={() => setAdding({})}
          />
        </div>
      </SettingsGroups>
      {adding && state.socket ? (
        <ConnectionDialog
          presets={snapshot?.presets ?? []}
          initialProtocol={adding.protocol}
          socket={state.socket}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </div>
  )
}
