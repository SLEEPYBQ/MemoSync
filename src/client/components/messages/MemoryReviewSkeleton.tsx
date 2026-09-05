import { AnimatedShinyText } from "../ui/animated-shiny-text"

interface Props {
  label: string
  status: string
}

/** One loading language for every pre-turn memory review. */
export function MemoryReviewSkeleton({ label, status }: Props) {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite" aria-label={label}>
      <div className="memory-review-skeleton h-6 w-3/4 rounded-lg" />
      <div className="memory-review-skeleton h-6 w-1/2 rounded-lg" />
      <AnimatedShinyText className="mx-0 max-w-none text-[11px] italic">
        {status}
      </AnimatedShinyText>
    </div>
  )
}
