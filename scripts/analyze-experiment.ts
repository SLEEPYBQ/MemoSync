// CLI for the local usage analyzer: per-session metamemory
// metrics + aggregates from an events.jsonl.
//   bun run scripts/analyze-experiment.ts <events.jsonl> [--csv out.csv]
// The log lives at ~/.memosync/data/experiments/events.jsonl.
import { readFileSync, writeFileSync } from "node:fs"
import { analyzeEvents } from "../src/server/experiment/analyze"

const file = process.argv[2]
if (!file) {
  console.error("usage: bun run scripts/analyze-experiment.ts <events.jsonl> [--csv out.csv]")
  process.exit(1)
}
const csvFlag = process.argv.indexOf("--csv")
const csvPath = csvFlag > -1 ? process.argv[csvFlag + 1] : null

const report = analyzeEvents(readFileSync(file, "utf8").split("\n"))

console.log(
  `sessions: ${report.totals.sessions} · events: ${report.totals.events} · `
    + `ignored legacy/unknown events: ${report.totals.ignoredEvents} · skipped lines: ${report.totals.skippedLines}`,
)
console.log(
  `capture: proposed ${report.totals.captureProposed} → surfaced ${report.totals.captureSurfaced} · ` +
    `UI decisions ${JSON.stringify(report.totals.decisions)} · accept rate ${(report.totals.acceptRate * 100).toFixed(0)}%`,
)
console.log(`utilization: citations ${report.totals.citations} · detail loads ${report.totals.detailLoads}`)
console.log(`preview decisions: ${JSON.stringify(report.totals.previewDecisions)}`)
console.log(`trace labels: ${JSON.stringify(report.totals.traceLabels)}`)
console.log("")

const rows = Object.values(report.sessions)
const pad = (v: string | number, w: number) => String(v).padEnd(w)
console.log(
  pad("session", 14) + pad("eng", 7) + pad("turns", 6) + pad("inj", 5) + pad("cite", 5) +
    pad("load", 5) + pad("cap s/p", 8) + pad("prev g/w/d", 11) + pad("trace o/n/v", 12) + "bringin",
)
for (const s of rows) {
  console.log(
    pad(s.sessionId.slice(0, 12), 14) + pad(s.engine ?? "-", 7) + pad(s.maxTurn, 6) +
      pad(s.injections, 5) + pad(s.citations, 5) + pad(s.detailLoads, 5) +
      pad(`${s.captureSurfaced}/${s.captureProposed}`, 8) +
      pad(`${s.previewDecisions.go_on}/${s.previewDecisions.without_memory}/${s.previewDecisions.dismiss}`, 11) +
      pad(`${s.traceLabels.operational}/${s.traceLabels.injected_without_effect}/${s.traceLabels.violated}`, 12) +
      s.bringIns,
  )
}

if (csvPath) {
  writeFileSync(csvPath, report.toCsv())
  console.log(`\nCSV → ${csvPath}`)
}
