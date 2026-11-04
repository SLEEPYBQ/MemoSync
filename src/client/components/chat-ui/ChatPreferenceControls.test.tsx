import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

describe("ChatPreferenceControls", () => {
  test("omits unsupported effort controls while retaining Codex fast mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.3-codex"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includePlanMode={false}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.3 Codex")
    expect(html).not.toContain("lucide-brain")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("shows the CLI's concrete version on the selected account model", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS.map(provider => provider.id === "claude" ? {
          ...provider,
          defaultModel: "sonnet",
          models: [{ id: "sonnet", label: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5", supportsEffort: false }],
        } : provider)}
        selectedProvider="claude"
        model="sonnet"
        modelOptions={{ reasoningEffort: "high", contextWindow: "200k" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includePlanMode={false}
      />
    )
    expect(html).toContain("Sonnet 5.5")
  })

  test("renders DeepSeek branding, icon, and Pro controls when enabled", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="deepseek-v4-pro"
        modelOptions={{ reasoningEffort: "max", contextWindow: "200k" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        planMode
        onPlanModeChange={() => {}}
        includePlanMode
      />
    )

    expect(html).toContain("DeepSeek")
    expect(html).toContain("V4 Pro")
    expect(html).toContain('data-provider-icon="deepseek"')
    expect(html).toContain("Max")
    expect(html).toContain("Plan Mode")
    expect(html).toContain("Claude Code")
    expect(html).not.toContain("Opus")
  })

  test("renders DeepSeek V4 Flash as the default model option", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="deepseek-v4-flash"
        modelOptions={{ reasoningEffort: "high", contextWindow: "200k" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includePlanMode={false}
      />
    )

    expect(html).toContain("V4 Flash")
    expect(html).toContain("High")
  })
})
