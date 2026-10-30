import "./style.css"
import { BRAND_SVGS } from "../../src/client/components/brand/brand-svgs"

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[]
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const mix = (a: number, b: number, t: number) => a + (b - a) * t
/** Progress of u through [a, b], eased. */
const seg = (u: number, a: number, b: number) => ease(clamp((u - a) / (b - a)))

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")

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
    el.textContent = repo.stargazers_count.toLocaleString("en")
    el.hidden = false
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

const story = $("[data-story]")
const stage = $("[data-stage]")
const world = $("[data-world]")
const caption = $("[data-caption]")
const rail = $$("[data-rail] li")
const el = Object.fromEntries($$("[data-el]", world).map((n) => [n.dataset.el!, n])) as Record<string, HTMLElement>
const typed = Object.fromEntries($$("[data-type]", world).map((n) => [n.dataset.type!, n])) as Record<string, HTMLElement>

type Pt = { x: number; y: number }
let anchors: Record<string, Pt & { w: number; h: number }> = {}
let scale = 1
let portrait = false
let catSize = { w: 150, h: 130 }

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
  scale = Math.min(w / W, avail / content)
  const x = (w - W * scale) / 2
  const y = navH + Math.max(0, (avail - content * scale) / 2) - top * scale
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
  catSize = { w: el.cat.offsetWidth, h: el.cat.offsetHeight }
  render(true)
}

const A = (name: string) => anchors[name]
const center = (name: string): Pt => ({ x: A(name).x + A(name).w / 2, y: A(name).y + A(name).h / 2 })

/** Position an element (top-left) in world space. */
function place(n: HTMLElement, x: number, y: number, s = 1, r = 0, o = 1) {
  n.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg) scale(${s})`
  n.style.opacity = String(o)
}

function face(n: HTMLElement, name: string) {
  for (const img of $$("img", n)) img.classList.toggle("on", (img.dataset.face ?? img.dataset.pose) === name)
}

type CatKey = { u: number; at: () => Pt; pose: string; move?: string; flip?: boolean; arc?: number }

/** The cat's day. `at` is where its feet are; `move` is the pose used while travelling to this key. */
function catKeys(): CatKey[] {
  const ben = A("benHome")
  const benSize = el.ben.offsetWidth
  const onBen = () => ({ x: ben.x + benSize * 0.55, y: ben.y + benSize * 0.1 })
  const slot = (i: number) => A(`slot${i}`)
  const onCard = (i: number) => ({ x: slot(i).x + slot(i).w * 0.62, y: slot(i).y + slot(i).h * 0.55 })
  const tray = () => ({ x: center("tray02").x + 40, y: A("tray02").y + 6 })
  const sheetRight = () => A("sheet2").x + A("sheet2").w
  const stamp = () => ({ x: slot(2).x + slot(2).w - 70, y: slot(2).y + slot(2).h - 6 })
  const nap = () => ({ x: slot(4).x + slot(4).w / 2, y: slot(4).y + slot(4).h })
  // On a phone there is no gutter beside the sheet: the cat stands on its right edge.
  const beside = () => sheetRight() + (portrait ? -40 : 66)
  const point = () => ({ x: beside(), y: A("bad").y + A("bad").h + (portrait ? 14 : 26) })
  const lens = () => ({ x: beside(), y: A("audit").y + A("audit").h })
  return [
    { u: 0, at: onBen, pose: "perch" },
    { u: 1.0, at: onBen, pose: "perch" },
    { u: 1.2, at: () => A("catTug"), pose: "tug", move: "hop", arc: 120 },
    { u: 1.42, at: () => A("catTug"), pose: "tug" },
    { u: 1.72, at: stamp, pose: "stamp", move: "hop", arc: 160 },
    { u: 2.05, at: stamp, pose: "sit" },
    { u: 2.55, at: stamp, pose: "sit" },
    { u: 2.85, at: nap, pose: "sleep", move: "hop", arc: 70 },
    { u: 3.45, at: nap, pose: "stretch" },
    { u: 3.6, at: () => onCard(2), pose: "carry", move: "hop", arc: 40 },
    { u: 3.88, at: tray, pose: "sit", move: "carry", arc: 70, flip: true },
    { u: 4.15, at: tray, pose: "sit" },
    { u: 4.35, at: point, pose: "sit", move: "hop", arc: 60 },
    { u: 4.72, at: point, pose: "point", flip: true },
    { u: 5.0, at: point, pose: "sit" },
    { u: 5.25, at: lens, pose: "magnifier", move: "hop", arc: 50, flip: true },
    { u: 5.95, at: lens, pose: "magnifier", flip: true },
    { u: 6.25, at: () => A("catAuto"), pose: "sit", move: "hop", arc: 120 },
    { u: 6.45, at: () => onCard(3), pose: "sit", move: "hop", arc: 140 },
    { u: 6.7, at: stamp, pose: "sit", move: "hop", arc: 100 },
    { u: 6.95, at: onBen, pose: "perch", move: "hop", arc: 200, flip: true },
    { u: 7, at: onBen, pose: "perch" },
  ]
}

function renderCat(u: number) {
  const keys = catKeys()
  let i = keys.findIndex((k) => k.u > u)
  if (i === -1) i = keys.length - 1
  const to = keys[i]
  const from = keys[Math.max(0, i - 1)]
  const t = from === to ? 1 : clamp((u - from.u) / (to.u - from.u))
  const a = from.at()
  const b = to.at()
  const travelling = Boolean(to.move) && t > 0 && t < 1 && (a.x !== b.x || a.y !== b.y)
  const e = ease(t)
  const x = mix(a.x, b.x, e)
  const y = mix(a.y, b.y, e) - (travelling ? (to.arc ?? 0) * Math.sin(Math.PI * t) : 0)
  const pose = travelling ? to.move! : t >= 1 ? to.pose : from.pose
  const flip = travelling ? b.x < a.x : t >= 1 ? Boolean(to.flip) : Boolean(from.flip)
  face(el.cat, pose)
  el.cat.style.transform = `translate(${x - catSize.w / 2}px, ${y - catSize.h}px) scaleX(${flip ? -1 : 1})`
}

const cardHome = (i: number) => A(`slot${i}`)

let lastAct = -1
function render(force = false) {
  const rect = story.getBoundingClientRect()
  const total = story.offsetHeight - stage.offsetHeight
  let p = clamp(-rect.top / total)
  let u = p * ACTS.length
  if (reduceMotion.matches) u = Math.min(Math.floor(u) + 0.999, ACTS.length)

  // caption + rail
  const act = Math.min(ACTS.length - 1, Math.floor(u))
  if (act !== lastAct || force) {
    const a = ACTS[act]
    $("[data-act-num]", caption).textContent = String(act + 1).padStart(2, "0")
    $("[data-act-name]", caption).textContent = a.name
    $("[data-act-title]", caption).innerHTML = a.title
    $("[data-act-body]", caption).textContent = a.body
    if (!force) {
      caption.classList.remove("swap")
      void caption.offsetWidth
      caption.classList.add("swap")
    }
    rail.forEach((li, i) => {
      li.classList.toggle("on", i === act)
      li.classList.toggle("done", i < act)
    })
    lastAct = act
  }

  /* session 1 */
  const in1 = seg(u, 0, 0.35)
  const crumple = seg(u, 2.15, 2.55)
  place(el.sheet1, mix(0, -60, crumple) , mix(40, 0, in1) + mix(0, 120, crumple), mix(1, 0.14, crumple), mix(0, -28, crumple), crumple > 0.92 ? 0 : in1)
  typed.m1a.style.setProperty("--reveal", String(seg(u, 0.15, 0.7)))
  typed.m1b.style.setProperty("--reveal", String(seg(u, 0.55, 0.68)))
  typed.m1c.style.setProperty("--reveal", String(seg(u, 0.68, 0.78)))
  typed.m1d.style.setProperty("--reveal", String(seg(u, 0.78, 0.88)))
  typed.m1e.style.setProperty("--reveal", String(seg(u, 0.88, 0.98)))
  el.phrase.style.setProperty("--hl", String(seg(u, 1.02, 1.25)))

  const ball = el.ball
  const s1 = el.sheet1
  const bx = s1.offsetLeft + s1.offsetWidth / 2 - ball.offsetWidth / 2 - 60
  const by = s1.offsetTop + s1.offsetHeight / 2 - ball.offsetHeight / 2 + 120
  const roll = seg(u, 2.55, 3.0)
  place(ball, mix(bx, A("ballOut").x, roll), mix(by, A("ballOut").y, roll), mix(0.7, 1, seg(u, 2.45, 2.6)), -540 * roll, u < 2.45 ? 0 : u > 2.98 ? 0 : 1)

  /* session 2 */
  const in2 = seg(u, 2.95, 3.35)
  place(el.sheet2, mix(90, 0, in2), 0, 1, 0, in2)
  typed.m2a.style.setProperty("--reveal", String(seg(u, 3.2, 3.5)))
  el.tray.style.opacity = String(seg(u, 3.4, 3.55))
  el.tray02.style.opacity = String(seg(u, 3.82, 3.9))
  el.tray07.style.opacity = String(seg(u, 4.0, 4.08))
  typed.l1.style.setProperty("--reveal", String(seg(u, 4.12, 4.38)))
  typed.l2.style.setProperty("--reveal", String(seg(u, 4.38, 4.62)))
  el.bad.style.opacity = String(seg(u, 4.62, 4.7))
  el.bad.style.setProperty("--strike", String(seg(u, 4.78, 4.86)))
  ;($(".stopped", el.bad) as HTMLElement).style.opacity = String(seg(u, 4.78, 4.84))
  el.good.style.opacity = String(seg(u, 4.9, 5.0))
  el.audit.style.opacity = String(seg(u, 5.15, 5.28))
  el.a1.style.opacity = String(seg(u, 5.3, 5.4))
  el.a2.style.opacity = String(seg(u, 5.45, 5.55))
  el.a3.style.opacity = String(seg(u, 5.6, 5.7))

  /* the board */
  const c = (name: string, i: number, o = 1, s = 1) => place(el[name], cardHome(i).x, cardHome(i).y, s, 0, o)
  c("c07", 0)
  c("c11", 1)
  el.c11.classList.toggle("dim", u > 3.55 && u < 6)
  el.c07.classList.toggle("dim", false)

  // M-02 is born from the highlighted phrase and flies to the board.
  const ph = A("phrase")
  const fly = seg(u, 1.3, 1.72)
  const slot2 = cardHome(2)
  const born = u >= 1.28
  const lift = Math.sin(Math.PI * clamp((u - 1.3) / 0.42)) * 90
  place(el.c02, mix(ph.x - 20, slot2.x, fly), mix(ph.y - 30, slot2.y, fly) - lift, mix(0.45, 1, fly) + (u > 1.9 && u < 2.0 ? 0.04 * Math.sin(Math.PI * (u - 1.9) * 10) : 0), mix(-8, 0, fly), born ? seg(u, 1.28, 1.36) : 0)
  const accepted = u >= 1.92
  el.c02.classList.toggle("proposed", !accepted)
  el.c02tag.textContent = accepted ? "project" : "proposed"

  // Automatic: two new cards arrive on their own.
  const auto = el.auto
  auto.style.opacity = String(seg(u, 6.0, 6.12))
  auto.classList.toggle("on", u >= 6.22)
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

  renderCat(u)
}

let queued = false
function requestRender() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    render()
  })
}

addEventListener("scroll", requestRender, { passive: true })
addEventListener("resize", layout)
reduceMotion.addEventListener("change", () => render(true))
document.fonts?.ready.then(layout)
addEventListener("load", layout)
layout()
