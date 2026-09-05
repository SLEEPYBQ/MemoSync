// A legend for MemoSync's visual vocabulary: what the scope colors, per-card
// status dot, and freshness marks mean. Rendered inline or in
// a popover next to the surfaces that use those marks — the Board (§4.9) and
// the in-chat capture cards (§4.1). The review flagged that the marks (notably
// the red status dot, which reads as "recently updated" but actually means
// "violated") were unlabeled and being misread; this names each one against the
// exact swatch the cards render, drawing both from memoryVocab so they cannot
// drift.
import { type ReactNode } from "react"
import { Info } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Chip, ScopeBadge } from "./ScopeBadge"
import {
  FRESHNESS_CLASSES,
  FRESHNESS_LEGEND,
  SCOPE_LEGEND,
  TRACE_DOT_CLASSES,
  TRACE_DOT_LEGEND,
} from "./memoryVocab"

export type LegendSection = "scope" | "status" | "freshness"

const ALL_SECTIONS: LegendSection[] = ["scope", "status", "freshness"]

function Row({ swatch, meaning }: { swatch: ReactNode; meaning: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 flex shrink-0 items-center">{swatch}</span>
      <span className="text-xs text-muted-foreground">{meaning}</span>
    </li>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">{title}</p>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  )
}

/** The legend body. `sections` picks which vocabulary groups to show. */
export function MemoryLegend({
  sections = ALL_SECTIONS,
  className,
}: {
  sections?: LegendSection[]
  className?: string
}) {
  return (
    <div className={cn("space-y-3", className)}>
      {sections.includes("scope") ? (
        <Section title="Scope — where it applies">
          {SCOPE_LEGEND.map(({ scope, meaning }) => (
            <Row key={scope} swatch={<ScopeBadge scope={scope} />} meaning={meaning} />
          ))}
        </Section>
      ) : null}
      {sections.includes("status") ? (
        <Section title="Status dot — how the agent used it">
          {TRACE_DOT_LEGEND.map(({ verdict, label, meaning }) => (
            <Row
              key={verdict}
              swatch={
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn("h-2 w-2 rounded-full", TRACE_DOT_CLASSES[verdict])} />
                  <span className="text-xs font-medium text-foreground">{label}</span>
                </span>
              }
              meaning={meaning}
            />
          ))}
        </Section>
      ) : null}
      {sections.includes("freshness") ? (
        <Section title="Since your last visit here">
          {FRESHNESS_LEGEND.map(({ freshness, label, meaning }) => (
            <Row key={freshness} swatch={<Chip className={FRESHNESS_CLASSES[freshness]}>{label}</Chip>} meaning={meaning} />
          ))}
        </Section>
      ) : null}
    </div>
  )
}

/** A quiet "Legend" trigger that opens {@link MemoryLegend} in a popover. */
export function MemoryLegendButton({
  sections,
  label = "Legend",
  align = "end",
}: {
  sections?: LegendSection[]
  label?: string
  align?: "start" | "center" | "end"
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80">
        <p className="mb-2 text-sm font-medium text-foreground">What the colors &amp; dots mean</p>
        <MemoryLegend sections={sections} />
      </PopoverContent>
    </Popover>
  )
}
