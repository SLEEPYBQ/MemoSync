import type { StudyOnboardingInformation as SharedStudyOnboardingInformation, StudyOnboardingStage } from "../../../../shared/studyOnboarding"

export const STUDY_ONBOARDING_PATH = "/onboarding"
export type { StudyOnboardingStage }
export type StudyOnboardingInformation = SharedStudyOnboardingInformation

export interface StudyOnboardingState {
  stage: StudyOnboardingStage
  information: StudyOnboardingInformation | null
  prolificId?: string | null
}

type StudyFetch = (url: string, init?: RequestInit) => Promise<Response>

function isStage(value: unknown): value is StudyOnboardingStage {
  return value === "information" || value === "consent" || value === "briefing" || value === "complete"
}

function parseInformation(value: unknown): StudyOnboardingInformation | null {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<StudyOnboardingInformation>
  if (
    typeof candidate.prolificId !== "string"
    || typeof candidate.age !== "number"
    || !Number.isInteger(candidate.age)
    || typeof candidate.gender !== "string"
    || typeof candidate.agentMemoryExperience !== "string"
    || typeof candidate.agentUseFrequency !== "string"
    || !Array.isArray(candidate.agentTools)
    || !candidate.agentTools.every((tool) => typeof tool === "string")
  ) return null
  return {
    prolificId: candidate.prolificId,
    age: candidate.age,
    gender: candidate.gender,
    agentMemoryExperience: candidate.agentMemoryExperience,
    agentUseFrequency: candidate.agentUseFrequency,
    agentTools: candidate.agentTools,
  }
}

async function readState(response: Response): Promise<StudyOnboardingState> {
  if (!response.ok) throw new Error(`study onboarding request failed (${response.status})`)
  const body = await response.json() as { data?: unknown }
  if (!body.data || typeof body.data !== "object") throw new Error("study onboarding response is invalid")
  const state = body.data as Partial<StudyOnboardingState>
  if (!isStage(state.stage)) throw new Error("study onboarding response is invalid")
  const information = parseInformation(state.information)
  if (state.information !== null && state.information !== undefined && information === null) {
    throw new Error("study onboarding response is invalid")
  }
  const prolificId = state.prolificId === undefined || state.prolificId === null
    ? null
    : typeof state.prolificId === "string" && state.prolificId.length > 0
      ? state.prolificId
      : null
  if (state.prolificId !== undefined && state.prolificId !== null && prolificId === null) {
    throw new Error("study onboarding response is invalid")
  }
  return {
    stage: state.stage,
    information,
    ...(prolificId ? { prolificId } : {}),
  }
}

function jsonRequest(method: "PUT" | "POST", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

/**
 * The single client transport seam for the durable, server-owned onboarding
 * stage. Pages never infer completion from browser storage or from a local
 * form submit; every transition returns the authoritative next state.
 */
export function loadStudyOnboarding(fetcher: StudyFetch = fetch): Promise<StudyOnboardingState> {
  return fetcher("/api/study/onboarding", { cache: "no-store" }).then(readState)
}

export function saveStudyInformation(
  information: StudyOnboardingInformation,
  fetcher: StudyFetch = fetch,
): Promise<StudyOnboardingState> {
  return fetcher("/api/study/onboarding/information", jsonRequest("PUT", information)).then(readState)
}

export function saveStudyConsent(fetcher: StudyFetch = fetch): Promise<StudyOnboardingState> {
  return fetcher("/api/study/onboarding/consent", jsonRequest("POST", { consented: true })).then(readState)
}

export function saveStudyBriefing(fetcher: StudyFetch = fetch): Promise<StudyOnboardingState> {
  return fetcher("/api/study/onboarding/briefing", jsonRequest("POST", {})).then(readState)
}
