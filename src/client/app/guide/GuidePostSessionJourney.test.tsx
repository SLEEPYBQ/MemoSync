import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GuidePostSessionJourney, GUIDE_POST_SESSION_PHASES } from "./GuidePostSessionJourney"

describe("GuidePostSessionJourney", () => {
  test("owns no study transport", async () => {
    const source = await Bun.file(new URL("./GuidePostSessionJourney.tsx", import.meta.url)).text()
    expect(source).not.toContain("fetch(")
    expect(source).not.toContain("/api/study/")
    expect(source).not.toContain("onChange={() => {}}")
    expect(source).not.toContain("onField={() => {}}")
  })

  test("covers the production post-session order without supplying example answers", () => {
    expect(GUIDE_POST_SESSION_PHASES).toEqual([
      "finish",
      "freezing",
      "memory_questionnaire",
      "monitoring_tlx",
      "control_tlx",
      "next_session",
      "sus",
      "complete",
    ])

    const memory = renderToStaticMarkup(<GuidePostSessionJourney phase="memory_questionnaire" />)
    expect(memory).toContain("Memory 1 of 1")
    expect(memory).toContain("Ask for confirmation before destructive actions")
    expect(memory).not.toContain('aria-pressed="true"')
    expect(memory).toContain("disabled")

    const monitoring = renderToStaticMarkup(<GuidePostSessionJourney phase="monitoring_tlx" />)
    const control = renderToStaticMarkup(<GuidePostSessionJourney phase="control_tlx" />)
    const sus = renderToStaticMarkup(<GuidePostSessionJourney phase="sus" />)
    expect(monitoring).toContain("Monitoring workload")
    expect(control).toContain("Control workload")
    expect(sus).toContain("System usability")
    // Both Guide TLX previews start genuinely unanswered: no preselected
    // midpoint thumb, no dimension marked answered (study owner 2026-08-20).
    for (const html of [monitoring, control]) {
      expect(html.match(/>Not answered</g)).toHaveLength(6)
      expect(html.match(/data-answered="false"/g)).toHaveLength(6)
      expect(html).not.toContain('data-answered="true"')
    }
    expect(sus).not.toContain('aria-pressed="true"')
  })

  test("uses the real next-session and final completion surfaces", () => {
    expect(renderToStaticMarkup(<GuidePostSessionJourney phase="next_session" />)).toContain("Continue to next session")
    const complete = renderToStaticMarkup(<GuidePostSessionJourney phase="complete" />)
    expect(complete).toContain("Guide preview")
    expect(complete).toContain("records nothing")
    expect(complete).toContain("does not mean the study is complete")
    expect(complete).toContain("let the experimenter know")
  })

  test("never reveals the real completion code in the Guide preview or client sources", async () => {
    const complete = renderToStaticMarkup(<GuidePostSessionJourney phase="complete" />)
    expect(complete).not.toContain("CAAML5VN")
    expect(complete).not.toContain("data-completion-code")

    // The real code is server-owned: it must not exist anywhere in the client
    // bundle sources (test files are not shipped and are excluded).
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")
    const root = new URL("../..", import.meta.url).pathname
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx|css|html)$/.test(entry) && !/\.test\./.test(entry)) {
          if (readFileSync(full, "utf8").includes("CAAML5VN")) offenders.push(full)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
