import type { EngineId } from "../../../shared/model-access"
import { cn } from "../../lib/utils"
import { BRAND_SVGS, type BrandId } from "./brand-svgs"

/** A vendor mark. Monochrome marks follow `currentColor`; colour marks keep their own fills. */
export function BrandMark({ brand, className }: { brand: BrandId; className?: string }) {
  const svg = BRAND_SVGS[brand]
  return (
    <svg
      aria-hidden="true"
      viewBox={svg.viewBox}
      fill="currentColor"
      className={cn("size-4 shrink-0", className)}
      // Static, in-repo constants (brand-svgs.ts): never user or network content.
      dangerouslySetInnerHTML={{ __html: svg.markup }}
    />
  )
}

/** Pi's own pixel mark (earendil-works/pi, pi-logo.ts): a 4×4 grid in coral, blue and yellow. */
function PiMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 4 4" shapeRendering="crispEdges" className={cn("size-4 shrink-0", className)}>
      <rect x="0" y="0" width="3" height="1" fill="#e48a7a" />
      <rect x="2" y="1" width="1" height="1" fill="#e48a7a" />
      <rect x="0" y="1" width="1" height="3" fill="#4f8eb3" />
      <rect x="1" y="2" width="1" height="1" fill="#4f8eb3" />
      <rect x="3" y="2" width="1" height="2" fill="#eab65d" />
    </svg>
  )
}

/**
 * A logo on a small rounded tile, the way Codex and Claude Desktop list
 * integrations. The tile gives every mark the same footprint whatever its shape.
 */
export function BrandTile({
  brand,
  size = "md",
  className,
}: {
  brand: BrandId | "pi" | null
  size?: "sm" | "md"
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-black/[0.06] bg-white text-foreground dark:border-white/[0.06] dark:bg-white/[0.06]",
        size === "md" ? "size-8 [&>svg]:size-[18px]" : "size-6 rounded-md [&>svg]:size-3.5",
        className,
      )}
    >
      {brand === "pi" ? <PiMark /> : brand ? <BrandMark brand={brand} /> : <span className="size-2 rounded-full bg-muted-foreground/40" />}
    </span>
  )
}

export const ENGINE_BRANDS: Record<EngineId, BrandId | "pi"> = { claude: "claude", codex: "openai", pi: "pi" }

/** Best-effort vendor mark for a connection, from its preset id or name. */
export function brandForConnection(connection: { presetId?: string; name: string; id?: string }): BrandId | null {
  const key = `${connection.presetId ?? ""} ${connection.id ?? ""} ${connection.name}`.toLowerCase()
  const rules: [RegExp, BrandId][] = [
    [/deepseek/, "deepseek"],
    [/zhipu|glm|z\.?ai|bigmodel/, "zhipu"],
    [/kimi/, "kimi"],
    [/moonshot/, "moonshot"],
    [/qwen|dashscope|bailian|aliyun/, "qwen"],
    [/minimax/, "minimax"],
    [/stepfun|step plan/, "stepfun"],
    [/openrouter/, "openrouter"],
    [/ollama/, "ollama"],
    [/lm ?studio|lmstudio/, "lmstudio"],
    [/gemini|google/, "gemini"],
    [/xai|grok/, "xai"],
    [/anthropic|claude/, "anthropic"],
    [/openai|chatgpt/, "openai"],
  ]
  return rules.find(([pattern]) => pattern.test(key))?.[1] ?? null
}
