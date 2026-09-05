import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RAW_TLX_DIMENSION_IDS } from "../../../shared/studyScales"
import type { RawTlxDraft } from "./studyPostSession"
import {
  RawTlxForm,
  StudyCompleteSurface,
  StudyLegacyMemoryQuestionnaireSurface,
  StudyMemoryQuestionnaireSurface,
} from "./StudyPostSessionSurfaces"

function renderTlx(activity: "monitoring" | "control", draft: RawTlxDraft): string {
  return renderToStaticMarkup(
    <RawTlxForm
      activity={activity}
      draft={draft}
      submitting={false}
      onChange={() => undefined}
      onSubmit={() => undefined}
    />,
  )
}

const FULL_DRAFT: RawTlxDraft = Object.fromEntries(
  RAW_TLX_DIMENSION_IDS.map((dimension, index) => [dimension, index * 10]),
) as RawTlxDraft

describe("RawTlxForm", () => {
  test("a fresh draft renders all six dimensions genuinely unanswered", () => {
    for (const activity of ["monitoring", "control"] as const) {
      const html = renderTlx(activity, {})
      // Six explicit unanswered states — no dimension pretends to hold a value.
      expect(html.match(/>Not answered</g)).toHaveLength(6)
      expect(html.match(/data-answered="false"/g)).toHaveLength(6)
      expect(html).not.toContain('data-answered="true"')
      // The native range thumb must not appear as a preselected midpoint
      // answer: every unanswered slider suppresses its thumb and announces
      // the unanswered state instead of the anchor value.
      expect(html.match(/::-webkit-slider-thumb\]:opacity-0/g)).toHaveLength(6)
      expect(html.match(/aria-valuetext="Not answered"/g)).toHaveLength(6)
      // The track itself must also be neutral. A native accent-colored range
      // at value 50 still paints a half-filled bar even when its thumb is
      // hidden, which visually suggests a preselected midpoint.
      expect(html.match(/::-webkit-slider-runnable-track\]:bg-muted/g)).toHaveLength(6)
      expect(html).toContain("appearance-none")
      expect(html).not.toContain("accent-foreground")
    }
  })

  test("keeps Continue unavailable until every dimension is explicitly answered", () => {
    // With submitting=false the submit Button is the only element that can
    // carry the rendered disabled="" attribute.
    const emptyHtml = renderTlx("monitoring", {})
    expect(emptyHtml).toContain("Continue to control workload")
    expect(emptyHtml).toContain('disabled=""')

    const fiveOfSix: RawTlxDraft = { ...FULL_DRAFT }
    delete fiveOfSix.frustration
    expect(renderTlx("monitoring", fiveOfSix)).toContain('disabled=""')

    expect(renderTlx("monitoring", FULL_DRAFT)).not.toContain('disabled=""')
  })

  test("an explicit midpoint answer is a real answer, distinct from unanswered", () => {
    // 50 chosen on purpose must render as answered — the unanswered contract
    // targets the fake preselected thumb, not the value 50 itself.
    const html = renderTlx("control", { ...FULL_DRAFT, mentalDemand: 50 })
    expect(html).not.toContain("Not answered")
    expect(html.match(/data-answered="true"/g)).toHaveLength(6)
    expect(html).not.toContain("::-webkit-slider-thumb]:opacity-0")
    expect(html).toContain("Submit session workload")
    expect(html).not.toContain('disabled=""')
  })
})

describe("StudyCompleteSurface", () => {
  test("renders a completion code only when the server supplies one", () => {
    const withCode = renderToStaticMarkup(
      <StudyCompleteSurface
        completionCode="SERVER-OWNED-CODE"
        completionUrl="https://app.prolific.com/submissions/complete?cc=SERVER-OWNED-CODE"
      />,
    )
    expect(withCode).toContain("SERVER-OWNED-CODE")
    expect(withCode).toContain("completion code")
    expect(withCode).toContain("Return to Prolific")

    // Without a server-issued code (Guide preview, or a legacy record) there
    // is no code block and no placeholder that looks like a usable code.
    const withoutCode = renderToStaticMarkup(<StudyCompleteSurface completionCode={null} />)
    expect(withoutCode).not.toContain("SERVER-OWNED-CODE")
    expect(withoutCode).not.toContain("data-completion-code")
  })
})

describe("StudyLegacyMemoryQuestionnaireSurface", () => {
  test("renders the frozen v1 categorical instrument instead of v2 ratings", () => {
    const html = renderToStaticMarkup(
      <StudyLegacyMemoryQuestionnaireSurface
        item={{ probeId: "probe-v1", snapshotId: "snapshot-v1", cue: "Use pnpm." }}
        itemIndex={0}
        itemCount={1}
        draft={{ probeId: "probe-v1", snapshotId: "snapshot-v1" }}
        submitting={false}
        onField={() => undefined}
        onTextField={() => undefined}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
    )
    expect(html).toContain("Yes, it expresses it accurately")
    expect(html).toContain("Partially, it would need edits")
    expect(html).toContain("I am not sure")
    expect(html).not.toContain("5 · Completely accurately")
    expect(html).toContain('disabled=""')
  })
})

describe("StudyMemoryQuestionnaireSurface attention check", () => {
  test("places the instructed response between the second and third memory sections", () => {
    const html = renderToStaticMarkup(
      <StudyMemoryQuestionnaireSurface
        item={{ probeId: "probe-v2", snapshotId: "snapshot-v2", cue: "Use pnpm." }}
        itemIndex={1}
        itemCount={3}
        draft={{ probeId: "probe-v2", snapshotId: "snapshot-v2" }}
        attentionCheck={{
          checkId: "attention-038-s1",
          prompt: "This is an attention check. To show that you are reading carefully, select Option B.",
          options: [
            { value: "option_a", label: "Option A" },
            { value: "option_b", label: "Option B" },
          ],
        }}
        attentionCheckAnswer={null}
        submitting={false}
        onField={() => undefined}
        onTextField={() => undefined}
        onAttentionCheckAnswer={() => undefined}
        onBack={() => undefined}
        onContinue={() => undefined}
      />,
    )
    const second = html.indexOf("2 · What you believe the agent remembers")
    const attention = html.indexOf("This is an attention check")
    const third = html.indexOf("3 · Application in this session")
    expect(second).toBeGreaterThan(-1)
    expect(attention).toBeGreaterThan(second)
    expect(third).toBeGreaterThan(attention)
  })
})
