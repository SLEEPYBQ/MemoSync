import { useEffect, useRef, useState } from "react"

/**
 * Re-emits `value` at most once per `intervalMs`, always landing on the
 * latest value (trailing edge). The initial value renders immediately.
 *
 * Built for the streaming reply preview: text deltas arrive up to ~50/s and
 * each re-render reparses the full accumulated markdown — O(n²) over a long
 * reply. Ten repaints a second is indistinguishable to the reader and keeps
 * the parse cost bounded.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value)
  const lastEmitRef = useRef(Number.NEGATIVE_INFINITY)
  const latestRef = useRef(value)

  useEffect(() => {
    latestRef.current = value
    const elapsed = performance.now() - lastEmitRef.current
    if (elapsed >= intervalMs) {
      lastEmitRef.current = performance.now()
      setThrottled(value)
      return
    }
    const id = window.setTimeout(() => {
      lastEmitRef.current = performance.now()
      setThrottled(latestRef.current)
    }, intervalMs - elapsed)
    return () => window.clearTimeout(id)
  }, [intervalMs, value])

  return throttled
}
