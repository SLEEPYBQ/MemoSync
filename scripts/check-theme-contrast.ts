// bun run scripts/check-theme-contrast.ts — WCAG 2 AA body-text/scope audit.
import { readFileSync } from "node:fs"

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
type RGB = [number, number, number]
function color(value: string): RGB {
  const parts = value.match(/[\d.]+/g)!.map(Number)
  if (!value.includes("%")) return parts as RGB
  const [h, s, l] = [parts[0]! / 30, parts[1]! / 100, parts[2]! / 100]
  const a = s! * Math.min(l!, 1 - l!)
  const f = (n: number) => { const k = (n + h!) % 12; return 255 * (l! - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) }
  return [f(0), f(8), f(4)]
}
function luminance(rgb: RGB) {
  const c = rgb.map(x => x / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722
}
let failed = false
for (const mode of [":root", ".dark"]) {
  const block = css.slice(css.indexOf(`  ${mode} {`)).split("\n  }")[0]!
  const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2]]))
  const pairs = ["foreground", "card-foreground", "popover-foreground", "primary", "secondary-foreground", "accent-foreground", "muted-foreground"].flatMap(fg => ["background", "card", "muted"].map(bg => [fg, bg]))
  for (const scope of ["personal", "project", "session"]) pairs.push([`scope-${scope}-fg`, `scope-${scope}-surface`])
  pairs.push(["cand-fg", "cand-surface"])
  for (const [fg, bg] of pairs) {
    const a = luminance(color(tokens[fg!]!)), b = luminance(color(tokens[bg!]!))
    const ratio = (Math.max(a,b) + .05) / (Math.min(a,b) + .05)
    console.log(`${ratio >= 4.5 ? "PASS" : "FAIL"} ${mode} ${fg} / ${bg}: ${ratio.toFixed(3)}:1`)
    if (ratio < 4.5) failed = true
  }
}
if (failed) process.exitCode = 1
