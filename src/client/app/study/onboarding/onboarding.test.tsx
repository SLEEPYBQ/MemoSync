import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { StudyOnboardingPage } from "./StudyOnboardingPage"
import {
  loadStudyOnboarding,
  saveStudyInformation,
  type StudyOnboardingInformation,
} from "./onboardingApi"
import { resolveOnboardingRouteAccess } from "./onboardingRouteGuard"

const information: StudyOnboardingInformation = {
  prolificId: "participant-42",
  age: 28,
  gender: "Prefer not to say",
  agentMemoryExperience: "Occasional",
  agentUseFrequency: "Weekly",
  agentTools: ["Claude Code"],
}

describe("study onboarding transport", () => {
  test("loads the durable onboarding stage and sends the complete information record", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null })
      return Response.json({ data: { stage: "consent", information } })
    }

    expect(await loadStudyOnboarding(fetcher)).toEqual({ stage: "consent", information })
    expect(await saveStudyInformation(information, fetcher)).toEqual({ stage: "consent", information })
    expect(calls).toEqual([
      { url: "/api/study/onboarding", method: "GET", body: null },
      { url: "/api/study/onboarding/information", method: "PUT", body: JSON.stringify(information) },
    ])
  })
})

describe("study onboarding route ownership", () => {
  test("keeps every study route behind unfinished durable onboarding", () => {
    expect(resolveOnboardingRouteAccess({ pathname: "/chat/session-1", checkedPathname: "/chat/session-1", stage: "consent" })).toEqual({ kind: "redirect", to: "/onboarding" })
    expect(resolveOnboardingRouteAccess({ pathname: "/onboarding", checkedPathname: "/onboarding", stage: "briefing" })).toEqual({ kind: "allow" })
  })

  test("moves a completed participant from the onboarding URL to the guide", () => {
    expect(resolveOnboardingRouteAccess({ pathname: "/onboarding", checkedPathname: "/onboarding", stage: "complete" })).toEqual({ kind: "redirect", to: "/guide" })
  })

})

describe("study onboarding presentation", () => {
  test("uses the Coding Agent Study information form with a numeric age and memory experience field", () => {
    const html = renderToStaticMarkup(<MemoryRouter><StudyOnboardingPage initialState={{ stage: "information", information: null }} /></MemoryRouter>)
    expect(html).toContain("Coding Agent Study")
    expect(html).toContain("Participant information")
    expect(html).toContain(">Age</span>")
    expect(html).toContain("Experience using Agent Memory")
    expect(html).toContain("Which AI agent tools have you used?")
  })

  test("renders a verified URL Prolific ID as an automatically recorded read-only field", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StudyOnboardingPage initialState={{
          stage: "information",
          information: null,
          prolificId: "60baf0123456789abcdef0123",
        }} />
      </MemoryRouter>,
    )
    expect(html).toContain("60baf0123456789abcdef0123")
    expect(html).toContain("readOnly")
    expect(html).toContain("Recorded automatically from your verified Prolific link.")
  })

  test("renders the accurate consent and briefing stages", () => {
    const consent = renderToStaticMarkup(<MemoryRouter><StudyOnboardingPage initialState={{ stage: "consent", information }} /></MemoryRouter>)
    const briefing = renderToStaticMarkup(<MemoryRouter><StudyOnboardingPage initialState={{ stage: "briefing", information }} /></MemoryRouter>)
    expect(consent).toContain("I have read the information above and consent to participate.")
    expect(consent).toContain("memory interactions")
    expect(briefing).toContain("Inspect and manage agent memory")
    expect(briefing).toContain("Open guide")
  })

  test("disables None unless the participant selected Never", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StudyOnboardingPage initialState={{ stage: "information", information }} />
      </MemoryRouter>,
    )

    expect(html).toMatch(/<input[^>]*disabled=""[^>]*\/>None<\/label>/)
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*\/>Claude Code<\/label>/)
  })
})
