import { animate } from "motion"

/**
 * The hero cat: a frame-by-frame character on a continuous path.
 *
 * Each beat of a jump has its own drawing (perch → crouch → launch → glide →
 * descend → land → perch), cut on the beat the way 2D animation is timed,
 * while position, squash/stretch, tilt and facing move continuously with
 * Motion tweens and springs. The belly follows the dotted track drawn in the
 * same 560 × 504 design box, so the cat lands exactly where the line ends.
 */
type Frame = "perch" | "crouch" | "launch" | "glide" | "descend" | "land"

export function startHeroCat(root: HTMLElement, reduceMotion: MediaQueryList) {
  const cat = root.querySelector<HTMLElement>("[data-duo-cat]")!
  const track = root.querySelector<SVGPathElement>("[data-track]")!
  const frames = new Map(
    [...cat.querySelectorAll<HTMLImageElement>("[data-frame]")].map((img) => [img.dataset.frame as Frame, img]),
  )
  const length = track.getTotalLength()

  // p: position on the track, 0 = Ben's head, 1 = the agent's head.
  const s = { p: 0, sx: 1, sy: 1, rot: 0, dx: 0, dy: 0, face: 1 }
  let frame: Frame = "perch"
  let shown: Frame | null = null

  function render() {
    const k = root.clientWidth / 560
    const at = track.getPointAtLength(length * s.p)
    cat.style.left = `${(at.x + s.dx) * k}px`
    cat.style.top = `${(at.y + s.dy) * k}px`
    // A turn narrows the body a little and flips at the middle, never to a sliver.
    const turnX = (s.face >= 0 ? 1 : -1) * (0.74 + 0.26 * Math.abs(s.face))
    cat.style.transform = `translate(-50%, -100%) rotate(${s.rot}deg) scale(${s.sx * turnX}, ${s.sy})`
    if (shown !== frame) {
      if (shown) frames.get(shown)?.classList.remove("on")
      frames.get(frame)?.classList.add("on")
      shown = frame
    }
  }

  /** Tilt that follows the track's slope, mirrored with the cat's facing. */
  function slopeTilt(p: number, dir: number) {
    const a = track.getPointAtLength(length * Math.max(0, p - 0.01))
    const b = track.getPointAtLength(length * Math.min(1, p + 0.01))
    const dx = (b.x - a.x) * dir
    const dy = (b.y - a.y) * dir
    return (Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI
  }

  /** Motion tweens the numbers; a frame loop draws whatever they are. */
  const tween = (to: Partial<typeof s>, options: Record<string, unknown>) => animate(s, to, options)

  let alive = true
  let visible = true
  let wake: (() => void) | null = null
  const waitVisible = () => (visible ? Promise.resolve() : new Promise<void>((r) => (wake = r)))
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible && wake) {
      wake()
      wake = null
    }
  }).observe(root)

  /** Sit and breathe for a while; a slow scale on the belly line. */
  async function idle(seconds: number) {
    frame = "perch"
    await animate(0, 1, {
      duration: seconds,
      ease: "linear",
      onUpdate: (t) => {
        s.sy = 1 + 0.018 * Math.sin(t * Math.PI * 2 * (seconds / 1.7))
        s.sx = 1 - 0.006 * Math.sin(t * Math.PI * 2 * (seconds / 1.7))
        render()
      },
    })
  }

  async function hop(dir: 1 | -1) {
    // Anticipation: gather down, a little wiggle of the hips, eyes on the target.
    frame = "crouch"
    await tween({ sy: 0.9, sx: 1.06, dy: 2 }, { duration: 0.22, ease: [0.3, 0, 0.4, 1] })
    await animate(0, 1, {
      duration: 0.36,
      ease: "linear",
      onUpdate: (t) => {
        s.dx = -2.2 * dir * Math.sin(t * Math.PI * 4) * (1 - t)
        render()
      },
    })
    s.dx = 0

    // Take-off and flight. Horizontal travel stays near-constant; the drawing
    // changes with the phase of the jump, the body stretches in the air.
    const from = s.p
    const to = dir > 0 ? 1 : 0
    await animate(0, 1, {
      duration: 0.92,
      ease: [0.32, 0.08, 0.36, 1],
      onUpdate: (t) => {
        s.p = from + (to - from) * t
        frame = t < 0.17 ? "launch" : t < 0.64 ? "glide" : "descend"
        const air = Math.sin(Math.PI * t)
        s.sx = 1 + 0.05 * air
        s.sy = 1 - 0.04 * air + (t < 0.08 ? 0.08 * (1 - t / 0.08) : 0)
        s.dy = t < 0.1 ? 2 * (1 - t / 0.1) : 0
        s.rot = 0.22 * slopeTilt(s.p, dir) * s.face
        render()
      },
    })

    // Landing: squash on impact, then a damped spring back to the resting shape.
    frame = "land"
    s.rot = 0
    s.sx = 1.1
    s.sy = 0.84
    render()
    await tween({ sx: 1, sy: 1 }, { type: "spring", stiffness: 520, damping: 15, mass: 0.6 })
    await new Promise((r) => setTimeout(r, 120))
  }

  /** Turn to face the other way: a small hop in place while the body flips. */
  async function turn(toFace: 1 | -1) {
    await Promise.all([
      tween({ face: toFace }, { duration: 0.3, ease: [0.45, 0, 0.3, 1] }),
      animate(0, 1, {
        duration: 0.3,
        ease: "linear",
        onUpdate: (t) => {
          s.dy = -7 * Math.sin(Math.PI * t)
          render()
        },
      }),
    ])
    s.dy = 0
  }

  function draw() {
    if (visible) render()
    if (alive) requestAnimationFrame(draw)
  }

  async function loop() {
    render()
    if (reduceMotion.matches) return
    requestAnimationFrame(draw)
    while (alive) {
      await waitVisible()
      await idle(1.9)
      await hop(1)
      await idle(1.5)
      await turn(-1)
      await idle(0.8)
      await waitVisible()
      await hop(-1)
      await idle(1.5)
      await turn(1)
    }
  }

  addEventListener("resize", render)
  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) alive = false
  })
  void loop()
}
