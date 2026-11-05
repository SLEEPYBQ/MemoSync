import "./style.css"
import { BRAND_SVGS } from "../../src/client/components/brand/brand-svgs"
import catSizes from "./cat-sizes.json"

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[]
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const mix = (a: number, b: number, t: number) => a + (b - a) * t
/** Progress of u through [a, b], eased. */
const seg = (u: number, a: number, b: number) => ease(clamp((u - a) / (b - a)))

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")

// Every cat drawing is shown at the same head size: widths relative to the perch.
for (const img of $$<HTMLImageElement>("[data-pose]")) {
  const key = img.dataset.pose!
  const name = key === "sleep" ? "sleep-card" : key === "carry" ? "carry-card" : key
  const rel = (catSizes as Record<string, number>)[name]
  if (rel) img.style.width = `${rel * 100}%`
}


/* ───────── small page chrome ───────── */

const nav = $("[data-nav]")
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true })

const logos = $("[data-logos]")
const LOGO_ORDER = ["anthropic", "openai", "deepseek", "zhipu", "moonshot", "qwen", "minimax", "gemini", "xai", "stepfun", "openrouter", "ollama", "lmstudio"] as const
for (const id of LOGO_ORDER) {
  const svg = BRAND_SVGS[id]
  const tile = document.createElement("span")
  tile.title = id
  tile.innerHTML = `<svg viewBox="${svg.viewBox}" fill="currentColor" aria-hidden="true">${svg.markup}</svg>`
  logos.append(tile)
}
for (const mark of $$("[data-brand]")) {
  const svg = BRAND_SVGS[mark.dataset.brand as keyof typeof BRAND_SVGS]
  mark.innerHTML = `<svg viewBox="${svg.viewBox}" fill="currentColor" aria-hidden="true">${svg.markup}</svg>`
}

const copy = $<HTMLButtonElement>("[data-copy]")
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("[data-commands]").textContent ?? "")
    copy.textContent = "Copied"
  } catch {
    copy.textContent = "Select & copy"
  }
  setTimeout(() => (copy.textContent = "Copy"), 1600)
})

fetch("https://api.github.com/repos/SLEEPYBQ/MemoSync")
  .then((r) => (r.ok ? r.json() : null))
  .then((repo) => {
    if (!repo || typeof repo.stargazers_count !== "number") return
    const el = $("[data-stars]")
    $("[data-star-count]", el).textContent = repo.stargazers_count.toLocaleString("en")
    el.hidden = false
  })
  .catch(() => {})

// Point the download buttons at the latest Apple silicon DMG; the Releases page is the fallback.
fetch("https://api.github.com/repos/SLEEPYBQ/MemoSync/releases/latest")
  .then((r) => (r.ok ? r.json() : null))
  .then((release) => {
    const dmg = release?.assets?.find((a: { name: string }) => /arm64\.dmg$/.test(a.name))
    if (!dmg) return
    for (const link of $$<HTMLAnchorElement>("[data-dmg]")) link.href = dmg.browser_download_url
    if (typeof release.tag_name === "string") for (const v of $$("[data-version]")) v.textContent = ` · ${release.tag_name}`
  })
  .catch(() => {})

const video = $<HTMLVideoElement>("[data-video]")
video.addEventListener("error", fallbackVideo, true)
video.querySelector("source")?.addEventListener("error", fallbackVideo)
function fallbackVideo() {
  const link = document.createElement("a")
  link.className = "btn primary"
  link.href = "https://github.com/SLEEPYBQ/MemoSync#readme"
  link.textContent = "Watch the film on GitHub"
  video.replaceWith(link)
}

/* ───────── the story ───────── */

const ACTS = [
  { name: "Learn", title: "It learns <em>while you work.</em>", body: "MemoSync notices what is worth remembering in the conversation — here, a rule about the package manager — and proposes it as memory." },
  { name: "Review", title: "Nothing is kept <em>until you say so.</em>", body: "Every proposed change waits for you. Accept it, edit it, change its scope, or dismiss it." },
  { name: "Persist", title: "Context clears. <em>Memory stays.</em>", body: "Sessions end and context windows compact. The memory board carries what matters into the next session." },
  { name: "Choose", title: "Choose what goes <em>into this turn.</em>", body: "Before the agent starts, you see which memories it plans to use and how — and you can add or drop any of them." },
  { name: "Follow", title: "Watch it cite. <em>Stop it when it drifts.</em>", body: "Replies cite the memories they apply. When the agent goes against one, stop it right there and say what should happen." },
  { name: "Check", title: "Check what was <em>actually followed.</em>", body: "A separate audit reads the whole turn and marks every memory: shaped, violated, not applicable — even ones the agent never cited." },
  { name: "Automatic", title: "Or let it run <em>on Automatic.</em>", body: "Safe changes apply on their own, each with a Revert. Sensitive ones wait on the board. The audit only speaks up when something broke." },
]
const END = ACTS.length

const story = $("[data-story]")
const stage = $("[data-stage]")
const world = $("[data-world]")
const caption = $("[data-caption]")
const scenes = $$<HTMLButtonElement>("[data-scenes] button")
const sceneBars = scenes.map((b) => $("span", b))
const el = Object.fromEntries($$("[data-el]", world).map((n) => [n.dataset.el!, n])) as Record<string, HTMLElement>
const typed = Object.fromEntries($$("[data-type]", world).map((n) => [n.dataset.type!, n])) as Record<string, HTMLElement>
const stopped = $(".stopped", el.bad)

/**
 * Style writes are skipped when the value hasn't changed, so a settled scene
 * costs the browser nothing and a moving one only touches what moves.
 */
const written = new WeakMap<HTMLElement, Record<string, string>>()
function put(n: HTMLElement, key: string, value: string) {
  let seen = written.get(n)
  if (!seen) written.set(n, (seen = {}))
  if (seen[key] === value) return
  seen[key] = value
  if (key.startsWith("--")) n.style.setProperty(key, value)
  else n.style[key as "opacity" | "transform"] = value
}
const num = (v: number) => String(Math.round(v * 1000) / 1000)

type Pt = { x: number; y: number }
let anchors: Record<string, Pt & { w: number; h: number }> = {}
let scale = 1
let portrait = false
let catSize = { w: 150, h: 130 }
let ballHome: Pt = { x: 0, y: 0 }
let keys: CatKey[] = []

/** Lay the design-space world into the stage, then read anchor positions from the layout. */
function layout() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  portrait = w / h < 0.86
  stage.classList.toggle("portrait", portrait)
  const W = portrait ? 440 : 1440
  const navH = nav.offsetHeight
  const capH = caption.offsetHeight + 24
  const top = portrait ? 10 : 84
  const content = portrait ? 800 : 700
  const avail = h - capH - navH - 8
  // Keep a margin at the sides, and stop growing past a little over life size,
  // so the scene keeps its proportions on any window shape.
  const gutter = portrait ? 0 : Math.max(24, w * 0.035)
  scale = Math.min((w - 2 * gutter) / W, avail / content, portrait ? Infinity : 1.15)
  const x = (w - W * scale) / 2
  // Spare height goes mostly below the scene, so it starts close to the top as it scrolls in.
  const y = navH + Math.max(0, (avail - content * scale) * 0.35) - top * scale
  world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`

  // Measure with every animated element at rest.
  const moved = $$<HTMLElement>("[data-el]", world)
  const saved = moved.map((n) => n.style.transform)
  moved.forEach((n) => (n.style.transform = "none"))
  const base = world.getBoundingClientRect()
  anchors = {}
  for (const n of $$("[data-anchor]", world)) {
    const r = n.getBoundingClientRect()
    anchors[n.dataset.anchor!] = { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale }
  }
  moved.forEach((n, i) => (n.style.transform = saved[i]))

  // Everything the frame loop needs from the layout is read here, once, so a
  // frame only writes styles and never forces the browser to lay out again.
  catSize = { w: el.cat.offsetWidth, h: el.cat.offsetHeight }
  const s1 = el.sheet1
  const ball = el.ball
  ballHome = {
    x: s1.offsetLeft + s1.offsetWidth / 2 - ball.offsetWidth / 2 - 60,
    y: s1.offsetTop + s1.offsetHeight / 2 - ball.offsetHeight / 2 + 120,
  }
  keys = catKeys(el.ben.offsetWidth, el.agent.offsetWidth)
}

const A = (name: string) => anchors[name]
const center = (name: string): Pt => ({ x: A(name).x + A(name).w / 2, y: A(name).y + A(name).h / 2 })

/** Position an element (top-left) in world space. */
function place(n: HTMLElement, x: number, y: number, s = 1, r = 0, o = 1) {
  put(n, "transform", `translate(${num(x)}px, ${num(y)}px) rotate(${num(r)}deg) scale(${num(s)})`)
  put(n, "opacity", num(o))
}

function face(n: HTMLElement, name: string) {
  for (const img of $$("img", n)) img.classList.toggle("on", (img.dataset.face ?? img.dataset.pose) === name)
}

type CatKey = { u: number; at: Pt; pose: string; move?: string; flip?: boolean; arc?: number }

/** The cat's day. `at` is where its feet are; `move` is the pose used while travelling to this key. */
function catKeys(benSize: number, agentSize: number): CatKey[] {
  const ben = A("benHome")
  const ag = A("agentHome")
  const onAgent = { x: ag.x + agentSize * 0.5, y: ag.y + agentSize * 0.23 }
  // Ben's drawing has a transparent margin; the paws hang over the front of the head.
  const onBen = { x: ben.x + benSize * 0.55, y: ben.y + benSize * 0.23 }
  const slot = (i: number) => A(`slot${i}`)
  const onCard = (i: number) => ({ x: slot(i).x + slot(i).w * 0.62, y: slot(i).y + slot(i).h * 0.55 })
  const tray = { x: center("tray02").x + 40, y: A("tray02").y + 6 }
  const sheetRight = A("sheet2").x + A("sheet2").w
  // Standing on the speech bubble right above the highlighted phrase, pulling it up and out.
  const tug = { x: A("phrase").x + A("phrase").w * 0.5 + (portrait ? 18 : 36), y: A("phrase").y + 4 }
  const stamp = { x: slot(2).x + slot(2).w - 70, y: slot(2).y + slot(2).h - 6 }
  const nap = { x: slot(4).x + slot(4).w / 2, y: slot(4).y + slot(4).h }
  // On a phone there is no gutter beside the sheet: the cat stands on its right edge.
  const beside = sheetRight + (portrait ? -40 : 66)
  const point = { x: beside, y: A("bad").y + A("bad").h + (portrait ? 14 : 26) }
  const lens = { x: beside, y: A("audit").y + A("audit").h }
  return [
    // Opening: the memory you share hops from your agent to you.
    { u: 0, at: portrait ? onBen : onAgent, pose: "perch", flip: true },
    { u: 0.22, at: portrait ? onBen : onAgent, pose: "perch", flip: true },
    { u: 0.6, at: onBen, pose: "perch", move: "hop", arc: 120, flip: true },
    { u: 1.0, at: onBen, pose: "perch", flip: true },
    { u: 1.2, at: tug, pose: "tug", move: "hop", arc: 70 },
    { u: 1.42, at: tug, pose: "tug" },
    { u: 1.72, at: stamp, pose: "stamp", move: "hop", arc: 160 },
    { u: 2.05, at: stamp, pose: "sit" },
    { u: 2.55, at: stamp, pose: "sit" },
    { u: 2.85, at: nap, pose: "sleep", move: "hop", arc: 70 },
    { u: 3.45, at: nap, pose: "stretch" },
    { u: 3.6, at: onCard(2), pose: "carry", move: "hop", arc: 40 },
    { u: 3.88, at: tray, pose: "sit", move: "carry", arc: 70, flip: true },
    { u: 4.15, at: tray, pose: "sit" },
    { u: 4.35, at: point, pose: "sit", move: "hop", arc: 60 },
    { u: 4.72, at: point, pose: "point", flip: true },
    { u: 5.0, at: point, pose: "sit" },
    { u: 5.25, at: lens, pose: "magnifier", move: "hop", arc: 50, flip: true },
    { u: 5.95, at: lens, pose: "magnifier", flip: true },
    { u: 6.25, at: A("catAuto"), pose: "sit", move: "hop", arc: 120 },
    { u: 6.45, at: onCard(3), pose: "sit", move: "hop", arc: 140 },
    { u: 6.7, at: stamp, pose: "sit", move: "hop", arc: 100 },
    { u: 6.95, at: onBen, pose: "perch", move: "hop", arc: 200, flip: true },
    { u: 7, at: onBen, pose: "perch" },
  ]
}

/**
 * The cat. A hop is played as a sequence of drawings — crouch, launch, glide,
 * descend, land — over the travel, with squash and stretch; turning around
 * passes the body through a quick turn instead of mirroring instantly; a pose
 * change while standing gets a small settle.
 */
function renderCat(u: number) {
  let i = keys.findIndex((k) => k.u > u)
  if (i === -1) i = keys.length - 1
  const to = keys[i]
  const from = keys[Math.max(0, i - 1)]
  const t = from === to ? 1 : clamp((u - from.u) / (to.u - from.u))
  const a = from.at
  const b = to.at
  const moving = Boolean(to.move) && t > 0 && t < 1 && (a.x !== b.x || a.y !== b.y)
  const hop = moving && to.move === "hop"

  let pose = t >= 1 ? to.pose : from.pose
  let x = t >= 1 ? b.x : a.x
  let y = t >= 1 ? b.y : a.y
  let sx = 1
  let sy = 1
  let rot = 0
  const fromFace = from.flip ? -1 : 1
  let facing = t >= 1 ? (to.flip ? -1 : 1) : fromFace

  if (moving) {
    const goingLeft = b.x < a.x
    const travelFace = goingLeft ? -1 : 1
    if (hop) {
      // 0–.14 crouch in place (and turn if needed) · .14–.88 airborne · .88–1 land
      const air = clamp((t - 0.14) / 0.74)
      const e = ease(air)
      // Never let the top of the jump leave the stage under the lane labels.
      const arc = Math.max(0, Math.min(to.arc ?? 0, Math.min(a.y, b.y) - catSize.h * 1.4 - 70))
      x = mix(a.x, b.x, e)
      y = mix(a.y, b.y, e) - arc * Math.sin(Math.PI * air)
      if (t < 0.14) {
        const c = t / 0.14
        pose = "crouch"
        sy = 1 - 0.1 * Math.sin((Math.PI / 2) * c)
        sx = 1 + 0.05 * Math.sin((Math.PI / 2) * c)
        facing = fromFace === travelFace ? travelFace : mix(fromFace, travelFace, ease(c))
      } else if (t < 0.88) {
        pose = air < 0.2 ? "launch" : air < 0.62 ? "glide" : "descend"
        const lift = Math.sin(Math.PI * air)
        sx = 1 + 0.05 * lift
        sy = 1 - 0.04 * lift
        rot = (air < 0.5 ? -10 : 10) * Math.sin(Math.PI * air) * travelFace
        facing = travelFace
      } else {
        const l = (t - 0.88) / 0.12
        pose = "land"
        sy = 0.86 + 0.14 * ease(l)
        sx = 1.08 - 0.08 * ease(l)
        facing = travelFace
      }
    } else {
      // Walking with something in its mouth: a light trot bob.
      const e = ease(t)
      x = mix(a.x, b.x, e)
      y = mix(a.y, b.y, e) - (to.arc ?? 0) * Math.sin(Math.PI * t) - Math.abs(Math.sin(t * Math.PI * 6)) * 5
      pose = to.move!
      facing = travelFace
    }
  } else if (t >= 1 || from === to) {
    // Settling into a new pose right after a key.
    const since = (u - (t >= 1 ? to.u : from.u)) / 0.05
    if (since >= 0 && since < 1) {
      const k = ease(since)
      sy = 0.93 + 0.07 * k
      sx = 1.04 - 0.04 * k
    }
  }

  face(el.cat, pose)
  // A turn narrows the body a little and flips at the middle, never to a sliver.
  const turnX = (facing >= 0 ? 1 : -1) * (0.74 + 0.26 * Math.abs(facing))
  put(el.cat, "transform", `translate(${num(x - catSize.w / 2)}px, ${num(y - catSize.h)}px) rotate(${num(rot)}deg) scale(${num(sx * turnX)}, ${num(sy)})`)
}

const cardHome = (i: number) => A(`slot${i}`)

/** Story time, in scenes: 2.5 is halfway through the third scene. */
let clock = 0

let lastAct = -1
function render(force = false) {
  const u = clock
  const act = Math.min(ACTS.length - 1, Math.floor(u))

  // caption + scene bar
  if (act !== lastAct || force) {
    const a = ACTS[act]
    $("[data-act-num]", caption).textContent = String(act + 1).padStart(2, "0")
    $("[data-act-name]", caption).textContent = a.name
    $("[data-act-title]", caption).innerHTML = a.title
    $("[data-act-body]", caption).textContent = a.body
    if (!force && lastAct !== -1) {
      caption.classList.remove("swap")
      void caption.offsetWidth
      caption.classList.add("swap")
    }
    scenes.forEach((b, i) => (i === act ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")))
    lastAct = act
  }
  sceneBars.forEach((bar, i) => put(bar, "--p", i < act || u >= END ? "1" : i > act ? "0" : num(u - act)))

  /* session 1 */
  const in1 = seg(u, 0, 0.35)
  const crumple = seg(u, 2.15, 2.55)
  place(el.sheet1, mix(0, -60, crumple), mix(40, 0, in1) + mix(0, 120, crumple), mix(1, 0.14, crumple), mix(0, -28, crumple), crumple > 0.92 ? 0 : in1)
  put(typed.m1a, "--reveal", num(seg(u, 0.15, 0.7)))
  put(typed.m1b, "--reveal", num(seg(u, 0.55, 0.68)))
  put(typed.m1c, "--reveal", num(seg(u, 0.68, 0.78)))
  put(typed.m1d, "--reveal", num(seg(u, 0.78, 0.88)))
  put(typed.m1e, "--reveal", num(seg(u, 0.88, 0.98)))
  put(el.phrase, "--hl", num(seg(u, 1.02, 1.25)))

  const roll = seg(u, 2.55, 3.0)
  place(el.ball, mix(ballHome.x, A("ballOut").x, roll), mix(ballHome.y, A("ballOut").y, roll), mix(0.7, 1, seg(u, 2.45, 2.6)), -540 * roll, u < 2.45 ? 0 : u > 2.98 ? 0 : 1)

  /* session 2 */
  const in2 = seg(u, 2.95, 3.35)
  place(el.sheet2, mix(90, 0, in2), 0, 1, 0, in2)
  put(typed.m2a, "--reveal", num(seg(u, 3.2, 3.5)))
  put(el.tray, "opacity", num(seg(u, 3.4, 3.55)))
  put(el.tray02, "opacity", num(seg(u, 3.82, 3.9)))
  put(el.tray07, "opacity", num(seg(u, 4.0, 4.08)))
  put(typed.l1, "--reveal", num(seg(u, 4.12, 4.38)))
  put(typed.l2, "--reveal", num(seg(u, 4.38, 4.62)))
  put(el.bad, "opacity", num(seg(u, 4.62, 4.7)))
  put(el.bad, "--strike", num(seg(u, 4.78, 4.86)))
  put(stopped, "opacity", num(seg(u, 4.78, 4.84)))
  put(el.good, "opacity", num(seg(u, 4.9, 5.0)))
  put(el.audit, "opacity", num(seg(u, 5.15, 5.28)))
  put(el.a1, "opacity", num(seg(u, 5.3, 5.4)))
  put(el.a2, "opacity", num(seg(u, 5.45, 5.55)))
  put(el.a3, "opacity", num(seg(u, 5.6, 5.7)))

  /* the board */
  const c = (name: string, i: number) => place(el[name], cardHome(i).x, cardHome(i).y)
  c("c07", 0)
  c("c11", 1)
  el.c11.classList.toggle("dim", u > 3.55 && u < 6)

  // M-02 is born from the highlighted phrase and flies to the board.
  const ph = A("phrase")
  const fly = seg(u, 1.3, 1.72)
  const slot2 = cardHome(2)
  const born = u >= 1.28
  const lift = Math.sin(Math.PI * clamp((u - 1.3) / 0.42)) * 90
  place(el.c02, mix(ph.x - 20, slot2.x, fly), mix(ph.y - 30, slot2.y, fly) - lift, mix(0.45, 1, fly) + (u > 1.9 && u < 2.0 ? 0.04 * Math.sin(Math.PI * (u - 1.9) * 10) : 0), mix(-8, 0, fly), born ? seg(u, 1.28, 1.36) : 0)
  const accepted = u >= 1.92
  el.c02.classList.toggle("proposed", !accepted)
  const tag = accepted ? "project" : "proposed"
  if (el.c02tag.textContent !== tag) el.c02tag.textContent = tag

  // Automatic: two new cards arrive on their own.
  put(el.auto, "opacity", num(seg(u, 6.0, 6.12)))
  el.auto.classList.toggle("on", u >= 6.22)
  const s3 = cardHome(3)
  const s4 = cardHome(4)
  const fly19 = seg(u, 6.3, 6.5)
  place(el.c19, mix(s3.x - 260, s3.x, fly19), mix(s3.y - 120, s3.y, fly19) - Math.sin(Math.PI * fly19) * 40, mix(0.6, 1, fly19), 0, u < 6.3 ? 0 : seg(u, 6.3, 6.36))
  const fly20 = seg(u, 6.5, 6.7)
  place(el.c20, mix(s4.x - 260, s4.x, fly20), mix(s4.y - 120, s4.y, fly20) - Math.sin(Math.PI * fly20) * 40, mix(0.6, 1, fly20), 0, u < 6.5 ? 0 : seg(u, 6.5, 6.56))

  /* characters */
  const ben = A("benHome")
  place(el.ben, ben.x, ben.y + (u < 1 ? Math.sin(u * Math.PI * 4) * 2 : 0))
  face(el.ben,
    u >= 6.85 ? "wink"
    : u >= 6.2 ? "happy"
    : u >= 4.66 && u < 4.95 ? "surprised"
    : u >= 3.3 && u < 3.6 ? "thinking"
    : u >= 1.85 && u < 2.4 ? "happy"
    : "neutral")
  const ag = A("agentHome")
  const blank = u >= 2.4 && u < 3.3
  place(el.agent, ag.x, ag.y + (blank ? 6 : 0), 1, 0, blank ? 0.85 : 1)
  face(el.agent, blank ? "blank" : u >= 3.3 && u < 4.1 ? "thinking" : u >= 4.75 && u < 5.0 ? "thinking" : u >= 6.0 ? "happy" : "neutral")

  put(el.noteBen, "opacity", num(1 - seg(u, 0.7, 1.0)))
  put(el.noteAgent, "opacity", num(1 - seg(u, 0.7, 1.0)))

  renderCat(u)
}

/* ───────── scrolling ─────────
 * The story follows the scroll position, but eases toward it instead of
 * jumping: a mouse wheel moves the page in coarse steps, and each step
 * becomes a short glide. A trackpad's fine steps pass through almost
 * unchanged. The page's own scrolling is never taken over. With reduced
 * motion there is no glide: each scene is shown settled.
 */
let storyTop = 0
let storyRun = 1
let target = 0
let running = false
let last = 0
/** Time constant of the glide, in seconds: about how long a wheel step takes to settle. */
const GLIDE = 0.14

function measureScroll() {
  storyTop = story.getBoundingClientRect().top + scrollY
  storyRun = Math.max(1, story.offsetHeight - stage.offsetHeight)
}

function scrollTarget() {
  const u = clamp((scrollY - storyTop) / storyRun) * END
  return reduceMotion.matches ? Math.min(Math.floor(u) + 0.999, END) : u
}

function frame(now: number) {
  // Clamp the step so a dropped frame or a background tab never skips a beat.
  const dt = clamp((now - last) / 1000, 0, 1 / 20)
  last = now
  const gap = target - clock
  if (Math.abs(gap) < 0.0004) {
    clock = target
    running = false
  } else {
    clock += gap * (1 - Math.exp(-dt / GLIDE))
  }
  render()
  if (running) requestAnimationFrame(frame)
}

function follow() {
  target = scrollTarget()
  if (reduceMotion.matches) {
    clock = target
    render()
    return
  }
  if (running || target === clock) return
  running = true
  last = performance.now()
  requestAnimationFrame(frame)
}

// The scene bar scrolls to the start of a scene; the story glides there.
scenes.forEach((b, i) =>
  b.addEventListener("click", () => {
    const top = storyTop + ((i + 0.02) / END) * storyRun
    scrollTo({ top, behavior: reduceMotion.matches ? "auto" : "smooth" })
  }),
)

function relayout() {
  layout()
  measureScroll()
  clock = target = scrollTarget()
  render(true)
}

addEventListener("scroll", follow, { passive: true })
addEventListener("resize", relayout)
reduceMotion.addEventListener("change", relayout)
document.fonts?.ready.then(relayout)
addEventListener("load", relayout)
relayout()
