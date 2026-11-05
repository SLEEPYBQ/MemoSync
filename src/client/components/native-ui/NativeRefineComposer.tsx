import { useRef } from "react"
import { ArrowUp, FlaskConical } from "lucide-react"
import { DEFAULT_CLAUDE_MODEL_OPTIONS, DEFAULT_CODEX_MODEL_OPTIONS, DEFAULT_PI_MODEL_OPTIONS, type AgentProvider, type ProviderCatalogEntry } from "../../../shared/types"
import type { NativeModelSelection } from "../../../shared/native-memory"
import { getLocale, t } from "../../i18n"
import { formatTokens } from "../../lib/nativeMemoryPlan"
import { cn } from "../../lib/utils"
import { ChatPreferenceControls } from "../chat-ui/ChatPreferenceControls"
import { Button } from "../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { NativeUiInfo } from "./NativeUiInfo"

export type NativeImportMode = "refine" | "verbatim"
export const SAMPLE_UNITS = 10

interface Props {
  providers: ProviderCatalogEntry[]
  mode: NativeImportMode
  onModeChange: (mode: NativeImportMode) => void
  model: NativeModelSelection | null
  onModelChange: (model: NativeModelSelection) => void
  instruction: string
  onInstructionChange: (value: string) => void
  count: number
  tokens: number
  busy: boolean
  onStart: (sample?: number) => void
}

function modelOptions(model: NativeModelSelection) {
  if (model.provider === "claude") return { ...DEFAULT_CLAUDE_MODEL_OPTIONS, ...(model.effort ? { reasoningEffort: model.effort as never } : {}) }
  if (model.provider === "codex") return { ...DEFAULT_CODEX_MODEL_OPTIONS, ...(model.effort ? { reasoningEffort: model.effort as never } : {}) }
  return { ...DEFAULT_PI_MODEL_OPTIONS, ...(model.effort ? { reasoningEffort: model.effort as never } : {}) }
}

/** Same shape as the chat composer: say what you want, set the model, send. */
export function NativeRefineComposer({ providers, mode, onModeChange, model, onModelChange, instruction, onInstructionChange, count, tokens, busy, onStart }: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const refine = mode === "refine"
  const ready = count > 0 && !busy && (!refine || Boolean(model))
  const label = refine ? t("nativeMemory:startRefine", { count }) : t("nativeMemory:startVerbatim", { count })
  return <div className="rounded-2xl bg-card shadow-composer transition-shadow focus-within:shadow-[0_0_0_1px_hsl(var(--foreground)/0.22),0_1px_2px_hsl(var(--foreground)/0.04),0_14px_30px_-14px_hsl(var(--foreground)/0.18)]">
    {refine ? <textarea ref={area} value={instruction} rows={2} disabled={busy} onChange={event => onInstructionChange(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && ready) { event.preventDefault(); onStart() } }}
      aria-label={t("nativeMemory:instruction")} placeholder={t("nativeMemory:instructionPlaceholder")}
      className="block max-h-40 min-h-[68px] w-full resize-none rounded-t-2xl border-0 bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/80" />
      : null}
    <div className={cn("flex min-w-0 items-center gap-1 px-2 pb-2", refine ? "pt-1" : "pt-2")}>
      <div role="radiogroup" aria-label={t("nativeMemory:mode")} className="flex shrink-0 items-center rounded-lg bg-muted p-0.5">
        {(["refine", "verbatim"] as const).map(option => <button key={option} type="button" role="radio" aria-checked={mode === option} disabled={busy} onClick={() => { onModeChange(option); if (option === "refine") requestAnimationFrame(() => area.current?.focus()) }}
          className={cn("rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", mode === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {t(option === "refine" ? "nativeMemory:modeRefine" : "nativeMemory:modeVerbatim")}
        </button>)}
      </div>
      <NativeUiInfo label={t("nativeMemory:mode")} className="-ml-0.5">{t("nativeMemory:modeInfo")}</NativeUiInfo>
      {refine && model ? <ChatPreferenceControls availableProviders={providers} selectedProvider={model.provider as AgentProvider} model={model.model} connectionId={model.connectionId} modelOptions={modelOptions(model)} includePlanMode={false} showSpeedControl={false}
        onProviderChange={provider => { const entry = providers.find(item => item.id === provider); if (entry) onModelChange({ provider, model: entry.defaultModel }) }}
        onModelChange={(provider, next, connectionId) => onModelChange({ provider, model: next, ...(connectionId ? { connectionId } : {}) })}
        onModelOptionChange={change => { if ("effort" in change) onModelChange({ ...model, effort: change.effort }) }}
        className="min-w-0" /> : null}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {refine && tokens ? <span className="px-1.5 text-xs tabular-nums text-muted-foreground" title={t("nativeMemory:tokensHint")}>{t("nativeMemory:tokenEstimate", { value: formatTokens(tokens, getLocale()) })}</span> : null}
        {refine && count > SAMPLE_UNITS ? <Tooltip delayDuration={120}><TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={!ready} onClick={() => onStart(SAMPLE_UNITS)} className="h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground"><FlaskConical aria-hidden className="size-3.5" />{t("nativeMemory:trySample", { count: SAMPLE_UNITS })}</Button>
        </TooltipTrigger><TooltipContent>{t("nativeMemory:trySampleHint")}</TooltipContent></Tooltip> : null}
        <Tooltip delayDuration={120}><TooltipTrigger asChild>
          <Button type="button" size="icon" aria-label={label} disabled={!ready} onClick={() => onStart()} className="ml-1 size-8 shrink-0 rounded-full border-0 bg-primary text-primary-foreground hover:bg-primary/85"><ArrowUp aria-hidden className="size-[18px]" /></Button>
        </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
      </div>
    </div>
  </div>
}
