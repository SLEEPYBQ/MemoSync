import { useState, type ComponentType, type SVGProps } from "react"
import { Box, Brain, Gauge, ListTodo, LockOpen, SquareMenu, SquareMinus } from "lucide-react"
import {
  CLAUDE_CONTEXT_WINDOW_OPTIONS,
  CLAUDE_REASONING_OPTIONS,
  CODEX_REASONING_OPTIONS,
  type AgentProvider,
  type ClaudeContextWindow,
  type ClaudeModelOptions,
  type ClaudeReasoningEffort,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ProviderCatalogEntry,
  supportsClaudeMaxReasoningEffort,
} from "../../../shared/types"
import { cn } from "../../lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

// Whale mark from DeepSeek's official DeepSeek-V2 figures/logo.svg, rendered
// with currentColor to match the existing monochrome provider controls.
function DeepSeekIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 56.3 41.36"
      fill="currentColor"
      aria-hidden="true"
      data-provider-icon="deepseek"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M55.6128 3.4712c-.5953-.2918-.8517.2642-1.1998.5466-.1191.0911-.2198.2095-.3206.3189-.8701.9292-1.8867 1.5398-3.2148 1.4668-1.9417-.1094-3.5995.5012-5.065 1.9863-.3114-1.8313-1.3463-2.9248-2.9217-3.6262-.8242-.3645-1.6577-.729-2.2348-1.5217-.4029-.5647-.5129-1.1934-.7143-1.813-.1283-.3735-.2565-.7563-.687-.82-.4671-.0728-.6503.3188-.8335.6469-.7327 1.3394-1.0166 2.8154-.9892 4.3096.0641 3.3621 1.4838 6.0406 4.3048 7.9449.3206.2187.403.4372.3023.7563-.1924.656-.4214 1.2937-.6228 1.9497-.1283.4192-.3207.5103-.7694.3279-1.5479-.6467-2.8852-1.6035-4.0667-2.7605-2.0058-1.9407-3.8193-4.0818-6.0815-5.7583-.5313-.3918-1.0625-.7561-1.6121-1.1025-2.3081-2.2412.3023-4.0818.9068-4.3003.6319-.2278.2198-1.0115-1.8227-1.0022-2.0425.009-3.9109.6924-6.2922 1.6035-.348.1367-.7145.2368-1.09.3189-2.1615-.4101-4.4055-.5014-6.7502-.237C9.4237 3.1978 5.8976 5.2842 3.3055 8.8467.1914 13.1289-.5413 17.9941.3563 23.0691c.9434 5.3481 3.6727 9.7761 7.8676 13.2385 4.3506 3.5896 9.3606 5.3482 15.0758 5.0114 3.4713-.2004 7.3364-.665 11.6961-4.3554 1.099.5467 2.2531.7652 4.1674.9292 1.4746.1367 2.8943-.0727 3.9933-.3005 1.7219-.3645 1.6029-1.959.9801-2.2505-5.0466-2.3506-3.9385-1.3939-4.9459-2.1685 2.5645-3.0339 6.4297-6.1865 7.9409-16.4001.119-.8108.0183-1.3211 0-1.9771-.0092-.4008.0824-.5556.5404-.6013 1.2639-.1457 2.4912-.4919 3.6178-1.1115 3.2698-1.7857 4.5886-4.7195 4.9-8.2364.0459-.5376-.0091-1.0935-.577-1.3757ZM27.119 35.123c-4.8909-3.8447-7.2629-5.1113-8.2431-5.0566-.9159.0547-.751 1.1025-.5496 1.7859.2107.6741.4855 1.1389.8701 1.7311.2656.3918.4489.9748-.2655 1.4122-1.5754.9749-4.314-1.3281-4.4423-1.3918-3.1872-1.877-5.8525-4.3553-7.7302-7.7444-1.8135-3.262-2.8667-6.7605-3.0408-10.4961-.0458-.9019.2198-1.221.8974-1.3848 1.1815-.2187 2.3997-.2644 3.5812-.0913 4.9917.729 9.2414 2.9612 12.8043 6.4963 2.0333 2.0135 3.572 4.419 5.1566 6.7696 1.6852 2.4963 3.4987 4.8745 5.8068 6.8242.8151.6833 1.4654 1.2026 2.0882 1.5854-1.8775.2095-5.0101.2552-7.1531-1.4397Zm2.3447-15.0788c0-.4009.3206-.7197.7237-.7197.0915 0 .1739.018.2472.0454.1008.0366.1924.0913.2656.1731.1283.1277.2015.3098.2015.5012 0 .4009-.3205.7197-.7235.7197-.4031 0-.7145-.3188-.7145-.7197Zm7.2815 3.7356c-.4671.1914-.9342.3552-1.383.3735-.6961.0364-1.4563-.2461-1.8684-.5923-.6411-.5376-1.0991-.8381-1.2915-1.7766-.0824-.4009-.0367-1.0205.0367-1.3757.1648-.7654-.0184-1.2573-.5587-1.7039-.4397-.3645-.9984-.4646-1.6121-.4646-.229 0-.4395-.1003-.5953-.1823-.2565-.1275-.467-.4463-.2656-.8382.0641-.1274.3756-.4372.4488-.4919.8335-.4739 1.7952-.3189 2.6836.0364.8244.3371 1.4472.9567 2.3447 1.8313.9159 1.0568 1.0807 1.3486 1.6028 2.1411.4123.6196.7878 1.2573 1.0442 1.9863.1557.4556-.0458.8291-.5862 1.0569Z" />
    </svg>
  )
}

function OpenAIIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 158.7128 157.296"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M60.8734 57.2556V42.3124c0-1.2586.4722-2.2029 1.5728-2.8314l30.0443-17.3023c4.0899-2.3593 8.9662-3.4599 13.9988-3.4599 18.8759 0 30.8307 14.6289 30.8307 30.2006 0 1.1007 0 2.3593-.158 3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629 0L60.8734 57.2556Zm70.1542 58.2005V79.7487c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651 12.8982-7.3934c1.1007-.6285 2.0453-.6285 3.1458 0l30.0441 17.3024c8.6523 5.0341 14.4708 15.7296 14.4708 26.1107 0 11.9539-7.0769 22.965-18.2461 27.527ZM51.593 83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314V39.0105c0-16.8303 12.8982-29.5722 30.3585-29.5722 6.607 0 12.7403 2.2029 17.9324 6.1349l-30.987 17.9324c-1.8871 1.1007-2.8314 2.6735-2.8314 4.8764v45.6159ZM79.3562 100.0403 60.8733 89.6592V67.6383l18.4829-10.3811 18.4812 10.3811v22.0209l-18.4812 10.3811Zm11.8757 47.8188c-6.607 0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005 2.8318-2.6728 2.8318-4.8759v-45.616l13.0564 7.5498c1.1005.6285 1.5723 1.5728 1.5723 2.8314v34.6051c0 16.8297-13.0564 29.5723-30.5147 29.5723ZM53.9522 112.7822 23.9079 95.4798c-8.652-5.0343-14.471-15.7296-14.471-26.1107 0-12.1119 7.2356-22.9652 18.403-27.5272v35.8634c0 2.2028.9443 3.7756 2.8314 4.8763l39.3248 22.8068-12.8982 7.3938c-1.1007.6287-2.045.6287-3.1456 0ZM52.2229 138.5791c-17.7745 0-30.8306-13.3713-30.8306-29.8871 0-1.2585.1578-2.5169.3143-3.7754l30.987 17.9323c1.8871 1.1005 3.7757 1.1005 5.6628 0l39.4811-22.807v14.9435c0 1.2585-.4721 2.2021-1.5728 2.8308l-30.0443 17.3025c-4.0898 2.359-8.9662 3.4605-13.9989 3.4605h.0014ZM91.2319 157.296c19.0327 0 34.9188-13.5272 38.5383-31.4594 17.6164-4.562 28.9425-21.0779 28.9425-37.908 0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035 1.2595-6.607 1.2595-9.909 0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461 0-8.3363.6285-12.4262 2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331 0-34.9191 13.5268-38.5384 31.4591C11.3255 36.0212 0 52.5373 0 69.3675c0 11.0112 4.7184 21.7065 13.2125 29.4142-.7865 3.3035-1.2586 6.6067-1.2586 9.9092 0 22.4923 18.2466 39.3241 39.3248 39.3241 4.2462 0 8.3362-.6277 12.426-2.0441 7.0776 6.921 16.8302 11.3251 27.5271 11.3251Z" />
    </svg>
  )
}

// Official Z.ai brand mark (GLM's vendor; lobehub/lobe-icons, single path),
// rendered in currentColor to match the other monochrome provider icons.
function GlmIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      data-provider-icon="glm"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z" />
    </svg>
  )
}

export const PROVIDER_ICONS: Record<AgentProvider, IconComponent> = {
  claude: DeepSeekIcon,
  codex: OpenAIIcon,
}

// The Claude-engine catalog spans vendors; the composer chip follows the
// selected model's vendor rather than the (single) engine provider.
const VENDOR_ICONS: Record<string, IconComponent> = {
  DeepSeek: DeepSeekIcon,
  GLM: GlmIcon,
}

export function PopoverMenuItem({
  onClick,
  selected,
  icon,
  label,
  description,
  disabled,
}: {
  onClick: () => void
  selected: boolean
  icon: React.ReactNode
  label: React.ReactNode
  description?: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-2 p-2 border border-border/0 rounded-lg text-left transition-opacity",
        selected ? "bg-muted border-border" : "hover:opacity-60",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {icon}
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
    </button>
  )
}

export function InputPopover({
  trigger,
  triggerClassName,
  disabled = false,
  children,
}: {
  trigger: React.ReactNode
  triggerClassName?: string
  disabled?: boolean
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
}) {
  const [open, setOpen] = useState(false)

  if (disabled) {
    return (
      <button
        disabled
        className={cn(
          // No dimming: a locked chip (e.g. the DeepSeek provider) should read
          // as the same color as its interactive neighbours, icon and text alike.
          "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md text-muted-foreground [&>svg]:shrink-0 cursor-default [&>span]:whitespace-nowrap",
          triggerClassName
        )}
      >
        {trigger}
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
            "hover:bg-muted/50",
            triggerClassName
          )}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-1">
        <div className="space-y-1">{typeof children === "function" ? children(() => setOpen(false)) : children}</div>
      </PopoverContent>
    </Popover>
  )
}

export type ModelOptionChange =
  | { type: "claudeReasoningEffort"; effort: ClaudeReasoningEffort }
  | { type: "contextWindow"; contextWindow: ClaudeContextWindow }
  | { type: "codexReasoningEffort"; effort: CodexReasoningEffort }
  | { type: "fastMode"; fastMode: boolean }

interface ChatPreferenceControlsProps {
  availableProviders: ProviderCatalogEntry[]
  selectedProvider: AgentProvider
  showProviderPicker?: boolean
  providerLocked?: boolean
  showCodexCliRequirementHints?: boolean
  model: string
  modelOptions: ClaudeModelOptions | CodexModelOptions
  onProviderChange?: (provider: AgentProvider) => void
  onModelChange: (provider: AgentProvider, model: string) => void
  onModelOptionChange: (change: ModelOptionChange) => void
  planMode?: boolean
  onPlanModeChange?: (planMode: boolean) => void
  includePlanMode?: boolean
  className?: string
}

export function ChatPreferenceControls({
  availableProviders,
  selectedProvider,
  showProviderPicker = true,
  providerLocked = false,
  showCodexCliRequirementHints = false,
  model,
  modelOptions,
  onProviderChange,
  onModelChange,
  onModelOptionChange,
  planMode = false,
  onPlanModeChange,
  includePlanMode = true,
  className,
}: ChatPreferenceControlsProps) {
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const selectedModelEntry = providerConfig?.models.find((candidate) => candidate.id === model)
  const selectedVendor = selectedModelEntry?.vendor
  // Two-level model picker when the engine's catalog spans vendors: the left
  // chip chooses the vendor (DeepSeek / GLM), the right chip lists only that
  // vendor's models. Vendors are collected in catalog order.
  const vendors = (providerConfig?.models ?? []).reduce<string[]>((acc, candidate) => {
    if (candidate.vendor && !acc.includes(candidate.vendor)) acc.push(candidate.vendor)
    return acc
  }, [])
  const useVendorPicker = vendors.length > 1
  const modelList = useVendorPicker && selectedVendor
    ? (providerConfig?.models ?? []).filter((candidate) => candidate.vendor === selectedVendor)
    : (providerConfig?.models ?? [])
  const VendorIcon = (selectedVendor ? VENDOR_ICONS[selectedVendor] : undefined) ?? PROVIDER_ICONS[selectedProvider]
  // The engine chip only appears when there are multiple ENGINES and no vendor
  // split to drive the left chip instead.
  const showEngineProviderPicker = showProviderPicker && !useVendorPicker && availableProviders.length > 1
  const ModelIcon = Box
  const showPlanMode = includePlanMode && providerConfig?.supportsPlanMode && onPlanModeChange
  const claudeModelOptions = selectedProvider === "claude" ? modelOptions as ClaudeModelOptions : null
  const codexModelOptions = selectedProvider === "codex" ? modelOptions as CodexModelOptions : null
  const contextWindowOptions = providerConfig.models.find((candidate) => candidate.id === model)?.contextWindowOptions ?? []
  const selectedContextWindow = claudeModelOptions?.contextWindow ?? CLAUDE_CONTEXT_WINDOW_OPTIONS[0].id
  const ContextWindowIcon = selectedContextWindow === "1m" ? SquareMenu : SquareMinus

  return (
    <div className={cn("flex md:justify-center items-center gap-0.5", className)}>
      {useVendorPicker ? (
        <InputPopover
          trigger={(
            <>
              <VendorIcon className="h-3.5 w-3.5" />
              <span>{selectedVendor ?? providerConfig?.label ?? selectedProvider}</span>
            </>
          )}
        >
          {(close) => vendors.map((vendor) => {
            const Icon = VENDOR_ICONS[vendor] ?? PROVIDER_ICONS[selectedProvider]
            return (
              <PopoverMenuItem
                key={vendor}
                onClick={() => {
                  // Switching vendor moves to that vendor's first model, which
                  // re-filters the model chip on the right.
                  const firstModel = providerConfig?.models.find((candidate) => candidate.vendor === vendor)
                  if (firstModel) onModelChange(selectedProvider, firstModel.id)
                  close()
                }}
                selected={selectedVendor === vendor}
                icon={<Icon className="h-4 w-4 text-muted-foreground" />}
                label={vendor}
              />
            )
          })}
        </InputPopover>
      ) : showEngineProviderPicker ? (
        <InputPopover
          disabled={providerLocked || !onProviderChange}
          trigger={(
            <>
              {(() => {
                const ProviderIcon = PROVIDER_ICONS[selectedProvider]
                return <ProviderIcon className="h-3.5 w-3.5" />
              })()}
              <span>{providerConfig?.label ?? selectedProvider}</span>
            </>
          )}
        >
          {(close) => availableProviders.map((provider) => {
            const Icon = PROVIDER_ICONS[provider.id]
            return (
              <PopoverMenuItem
                key={provider.id}
                onClick={() => {
                  onProviderChange?.(provider.id)
                  close()
                }}
                selected={selectedProvider === provider.id}
                icon={<Icon className="h-4 w-4 text-muted-foreground" />}
                label={provider.label}
              />
            )
          })}
        </InputPopover>
      ) : null}

      <InputPopover
        trigger={(
          <>
            <ModelIcon className="h-3.5 w-3.5" />
            <span>{selectedModelEntry?.label ?? model}</span>
          </>
        )}
      >
        {(close) => modelList.map((candidate) => {
          const Icon = Box
          return (
            <PopoverMenuItem
              key={candidate.id}
              onClick={() => {
                onModelChange(selectedProvider, candidate.id)
                close()
              }}
              selected={model === candidate.id}
              icon={<Icon className="h-4 w-4 text-muted-foreground" />}
              label={
                showCodexCliRequirementHints && selectedProvider === "codex" && candidate.id === "gpt-5.5"
                  ? (
                    <>
                      {candidate.label}{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        codex-cli &gt;= 0.124
                      </span>
                    </>
                  )
                  : candidate.label
              }
            />
          )
        })}
      </InputPopover>

      <InputPopover
        trigger={(
          <>
            <Brain className="h-3.5 w-3.5" />
            <span>{
              selectedProvider === "claude"
                ? CLAUDE_REASONING_OPTIONS.find((effort) => effort.id === modelOptions.reasoningEffort)?.label ?? modelOptions.reasoningEffort
                : CODEX_REASONING_OPTIONS.find((effort) => effort.id === modelOptions.reasoningEffort)?.label ?? modelOptions.reasoningEffort
            }</span>
          </>
        )}
      >
        {(close) => (
          selectedProvider === "claude"
            // The catalog's efforts list is authoritative — a study-pinned
            // server narrows it to one entry and the menu must follow.
            ? CLAUDE_REASONING_OPTIONS.filter((effort) =>
                !providerConfig?.efforts?.length || providerConfig.efforts.some((option) => option.id === effort.id)
              ).map((effort) => (
              <PopoverMenuItem
                key={effort.id}
                onClick={() => {
                  onModelOptionChange({ type: "claudeReasoningEffort", effort: effort.id })
                  close()
                }}
                selected={modelOptions.reasoningEffort === effort.id}
                icon={<Brain className="h-4 w-4 text-muted-foreground" />}
                label={effort.label}
                disabled={effort.id === "max" && !supportsClaudeMaxReasoningEffort(model)}
              />
            ))
            : CODEX_REASONING_OPTIONS.map((effort) => (
              <PopoverMenuItem
                key={effort.id}
                onClick={() => {
                  onModelOptionChange({ type: "codexReasoningEffort", effort: effort.id })
                  close()
                }}
                selected={modelOptions.reasoningEffort === effort.id}
                icon={<Brain className="h-4 w-4 text-muted-foreground" />}
                label={effort.label}
              />
            ))
        )}
      </InputPopover>

      {selectedProvider === "claude" && contextWindowOptions.length > 1 ? (
        <InputPopover
          trigger={(
            <>
              <ContextWindowIcon className="h-3.5 w-3.5" />
              <span>{contextWindowOptions.find((option) => option.id === selectedContextWindow)?.label ?? selectedContextWindow}</span>
            </>
          )}
        >
          {(close) => contextWindowOptions.map((option) => (
            <PopoverMenuItem
              key={option.id}
                onClick={() => {
                  onModelOptionChange({ type: "contextWindow", contextWindow: option.id })
                  close()
                }}
                selected={selectedContextWindow === option.id}
                icon={option.id === "1m"
                  ? <SquareMenu className="h-4 w-4 text-muted-foreground" />
                  : <SquareMinus className="h-4 w-4 text-muted-foreground" />}
                label={option.label}
                description={option.id === "1m" ? "Expanded context window" : "Standard context window"}
              />
          ))}
        </InputPopover>
      ) : null}

      {selectedProvider === "codex" ? (
        <InputPopover
          trigger={(
            <>
              {codexModelOptions?.fastMode
                ? <Gauge className="h-3.5 w-3.5" />
                : <Gauge className="h-3.5 w-3.5 -scale-x-100" />}
              <span>{codexModelOptions?.fastMode ? "Fast Mode" : "Standard"}</span>
            </>
          )}
          triggerClassName={codexModelOptions?.fastMode ? "text-emerald-500 dark:text-emerald-400" : undefined}
        >
          {(close) => (
            <>
              <PopoverMenuItem
                onClick={() => {
                  onModelOptionChange({ type: "fastMode", fastMode: false })
                  close()
                }}
                selected={!codexModelOptions?.fastMode}
                icon={<Gauge className="h-4 w-4 text-muted-foreground -scale-x-100" />}
                label="Standard"
              />
              <PopoverMenuItem
                onClick={() => {
                  onModelOptionChange({ type: "fastMode", fastMode: true })
                  close()
                }}
                selected={Boolean(codexModelOptions?.fastMode)}
                icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                label="Fast Mode"
              />
            </>
          )}
        </InputPopover>
      ) : null}

      {showPlanMode ? (
        <InputPopover
          trigger={(
            <>
              {planMode ? <ListTodo className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
              <span>{planMode ? "Plan Mode" : "Full Access"}</span>
            </>
          )}
          triggerClassName={planMode ? "text-blue-400 dark:text-blue-300" : undefined}
        >
          {(close) => (
            <>
              <PopoverMenuItem
                onClick={() => {
                  onPlanModeChange(false)
                  close()
                }}
                selected={!planMode}
                icon={<LockOpen className="h-4 w-4 text-muted-foreground" />}
                label="Full Access"
                description="Execution without approval"
              />
              <PopoverMenuItem
                onClick={() => {
                  onPlanModeChange(true)
                  close()
                }}
                selected={planMode}
                icon={<ListTodo className="h-4 w-4 text-muted-foreground" />}
                label="Plan Mode"
                description="Review a plan before execution"
              />
            </>
          )}
        </InputPopover>
      ) : null}
    </div>
  )
}
