/**
 * The participant-facing information collected before the common study Guide.
 * The orchestrator allocation remains the run identity; Prolific ID is a
 * demographic/contact field and never participates in condition assignment.
 */
export const STUDY_ONBOARDING_CONSENT_VERSION = "2026-08-19-v1"
export const STUDY_ONBOARDING_BRIEFING_VERSION = "2026-08-19-v1"

export const STUDY_ONBOARDING_GENDERS = [
  "Woman",
  "Man",
  "Non-binary",
  "Another identity",
  "Prefer not to say",
] as const

export const STUDY_AGENT_MEMORY_EXPERIENCE = [
  "Frequent",
  "Occasional",
  "Limited",
  "None",
] as const

export const STUDY_AGENT_USE_FREQUENCIES = [
  "Daily or almost daily",
  "Weekly",
  "Monthly or less",
  "Tried once or twice",
  "Never",
] as const

export const STUDY_AGENT_TOOLS = [
  "Claude Code",
  "Codex",
  "Gemini CLI",
  "Cursor",
  "OpenClaw",
  "Other agent tool",
  "None",
] as const

export type StudyOnboardingGender = (typeof STUDY_ONBOARDING_GENDERS)[number]
export type StudyAgentMemoryExperience = (typeof STUDY_AGENT_MEMORY_EXPERIENCE)[number]
export type StudyAgentUseFrequency = (typeof STUDY_AGENT_USE_FREQUENCIES)[number]
export type StudyAgentTool = (typeof STUDY_AGENT_TOOLS)[number]

export interface StudyOnboardingInformation {
  prolificId: string
  age: number
  gender: StudyOnboardingGender
  agentMemoryExperience: StudyAgentMemoryExperience
  agentUseFrequency: StudyAgentUseFrequency
  agentTools: StudyAgentTool[]
}

export interface StudyOnboardingConsent {
  version: string
  acceptedAt: string
}

export interface StudyOnboardingBriefing {
  version: string
  completedAt: string
}

export interface StudyParticipantOnboardingRecord {
  participantId: string
  information: StudyOnboardingInformation
  informationSubmittedAt: string
  consent: StudyOnboardingConsent | null
  briefing: StudyOnboardingBriefing | null
}

export type StudyOnboardingStage = "information" | "consent" | "briefing" | "complete"

/** Browser-safe projection for the participant's own isolated instance. */
export interface StudyOnboardingStatus {
  stage: StudyOnboardingStage
  information?: StudyOnboardingInformation
  /** URL-recorded Prolific ID supplied by the formal allocation. */
  prolificId?: string
}
