// Motion primitives for memory-lifecycle moments. Motion here is MEANING, not
// decoration: each lifecycle station gets one signature move so a glance tells
// what kind of event just happened (birth rises, transfer flips, violation
// pings once, delegation stamps). Grounding rules:
//
// - One-shot and short (200–500ms), spring-eased. Nothing loops — a looping
//   attention animation is a nag, and the drift signals must stay trustworthy.
// - FRESH-GUARDED: the transcript list is virtualized, so rows REMOUNT when
//   scrolled back into view. Entrance animations only play while the event is
//   actually fresh (its timestamp within FRESH_WINDOW_MS of mount); old rows
//   render settled. Pass `freshAt` from the message timestamp.
// - `prefers-reduced-motion` renders everything settled immediately.
import { useMemo, type CSSProperties, type ReactNode } from "react"
import { motion, useReducedMotion, type Transition } from "motion/react"

const FRESH_WINDOW_MS = 8_000

/** True while the event that produced this UI just happened. */
export function isFresh(freshAt?: string | number): boolean {
  if (freshAt === undefined) return true
  const t = typeof freshAt === "number" ? freshAt : Date.parse(freshAt)
  if (Number.isNaN(t)) return true
  return Date.now() - t < FRESH_WINDOW_MS
}

const SPRING: Transition = { type: "spring", stiffness: 420, damping: 32, mass: 0.7 }

/**
 * Birth move: rise + settle. For cards entering the stream (capture
 * candidates, the preview gate). `delay` staggers siblings.
 */
export function RiseIn({
  children,
  freshAt,
  delay = 0,
  className,
}: {
  children: ReactNode
  freshAt?: string | number
  delay?: number
  className?: string
}) {
  const reduced = useReducedMotion()
  const animateEntrance = useMemo(() => !reduced && isFresh(freshAt), [reduced, freshAt])
  if (!animateEntrance) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Secondary-surface move: slide in from the side after the primary content
 * landed. For the gate's attention row — the eye reads the gate first, then
 * the ride-along arrives, visually subordinate.
 */
export function SlideInLater({
  children,
  freshAt,
  delay = 0.45,
  className,
}: {
  children: ReactNode
  freshAt?: string | number
  delay?: number
  className?: string
}) {
  const reduced = useReducedMotion()
  const animateEntrance = useMemo(() => !reduced && isFresh(freshAt), [reduced, freshAt])
  if (!animateEntrance) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Transfer move: a real 3D flip. Face A ("Transferring …") holds for
 * `holdMs`, then the card turns over to face B (the Localized result).
 * Old gates render face B directly — the journey already happened.
 */
export function FlipReveal({
  front,
  back,
  freshAt,
  holdMs = 1100,
  delay = 0,
  className,
}: {
  front: ReactNode
  back: ReactNode
  freshAt?: string | number
  holdMs?: number
  delay?: number
  className?: string
}) {
  const reduced = useReducedMotion()
  const animateFlip = useMemo(() => !reduced && isFresh(freshAt), [reduced, freshAt])
  if (!animateFlip) return <div className={className}>{back}</div>
  const face: CSSProperties = { backfaceVisibility: "hidden", gridArea: "1 / 1" }
  return (
    // Perspective must live on the PARENT for the child's rotation to gain
    // depth — set on the rotating element it has no effect on its own turn.
    <div className={className} style={{ perspective: 1200 }}>
      <motion.div
        style={{ transformStyle: "preserve-3d", display: "grid" }}
        initial={{ rotateX: 0 }}
        animate={{ rotateX: 180 }}
        transition={{ delay: delay + holdMs / 1000, type: "spring", stiffness: 190, damping: 24 }}
      >
        <div style={face}>{front}</div>
        <div style={{ ...face, transform: "rotateX(180deg)" }}>{back}</div>
      </motion.div>
    </div>
  )
}

/**
 * Violation move: ONE red ring ping on arrival, then quiet. The signal's
 * salience comes from staying visible, not from repeating.
 */
export function PulseOnce({
  children,
  freshAt,
  className,
  color = "rgb(239 68 68 / 0.45)",
}: {
  children: ReactNode
  freshAt?: string | number
  className?: string
  color?: string
}) {
  const reduced = useReducedMotion()
  const animatePulse = useMemo(() => !reduced && isFresh(freshAt), [reduced, freshAt])
  if (!animatePulse) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ boxShadow: `0 0 0 0px ${color}` }}
      animate={{ boxShadow: [`0 0 0 0px ${color}`, `0 0 0 7px ${color.replace("0.45", "0")}`] }}
      transition={{ duration: 0.7, ease: "easeOut", delay: 0.15 }}
      style={{ borderRadius: "inherit" }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Delegation move: the "auto" stamp pops into place — quick, confident,
 * slightly overshooting. For the auto-applied badge.
 */
export function StampIn({
  children,
  freshAt,
  className,
}: {
  children: ReactNode
  freshAt?: string | number
  className?: string
}) {
  const reduced = useReducedMotion()
  const animateStamp = useMemo(() => !reduced && isFresh(freshAt), [reduced, freshAt])
  if (!animateStamp) return <span className={className}>{children}</span>
  return (
    <motion.span
      className={className}
      style={{ display: "inline-flex" }}
      initial={{ opacity: 0, scale: 1.6, rotate: -6 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 22, delay: 0.1 }}
    >
      {children}
    </motion.span>
  )
}
