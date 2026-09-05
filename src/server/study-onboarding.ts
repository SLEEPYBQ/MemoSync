import {
  STUDY_AGENT_MEMORY_EXPERIENCE,
  STUDY_AGENT_TOOLS,
  STUDY_AGENT_USE_FREQUENCIES,
  STUDY_ONBOARDING_BRIEFING_VERSION,
  STUDY_ONBOARDING_CONSENT_VERSION,
  STUDY_ONBOARDING_GENDERS,
  type StudyAgentTool,
  type StudyOnboardingInformation,
  type StudyOnboardingStatus,
  type StudyParticipantOnboardingRecord,
} from "../shared/studyOnboarding"

export class StudyOnboardingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "StudyOnboardingError"
  }
}

export interface StudyOnboardingStore {
  getParticipantOnboarding(): StudyParticipantOnboardingRecord | null
  saveParticipantOnboardingInformation(input: {
    participantId: string
    information: StudyOnboardingInformation
    submittedAt: string
  }): StudyParticipantOnboardingRecord
  recordParticipantOnboardingConsent(input: {
    participantId: string
    version: string
    acceptedAt: string
  }): StudyParticipantOnboardingRecord
  recordParticipantOnboardingBriefing(input: {
    participantId: string
    version: string
    completedAt: string
  }): StudyParticipantOnboardingRecord
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value)
}

function informationFrom(value: unknown): StudyOnboardingInformation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StudyOnboardingError("participant information must be an object")
  }
  const record = value as Record<string, unknown>
  const prolificId = typeof record.prolificId === "string" ? record.prolificId.trim() : ""
  if (!prolificId || prolificId.length > 200) {
    throw new StudyOnboardingError("A Prolific ID is required")
  }
  if (!Number.isInteger(record.age) || (record.age as number) < 18 || (record.age as number) > 120) {
    throw new StudyOnboardingError("Age must be a whole number from 18 to 120")
  }
  if (!isOneOf(record.gender, STUDY_ONBOARDING_GENDERS)) {
    throw new StudyOnboardingError("Select a valid gender option")
  }
  if (!isOneOf(record.agentMemoryExperience, STUDY_AGENT_MEMORY_EXPERIENCE)) {
    throw new StudyOnboardingError("Select a valid agent memory experience option")
  }
  if (!isOneOf(record.agentUseFrequency, STUDY_AGENT_USE_FREQUENCIES)) {
    throw new StudyOnboardingError("Select a valid agent use frequency option")
  }
  if (!Array.isArray(record.agentTools) || !record.agentTools.every((tool) => isOneOf(tool, STUDY_AGENT_TOOLS))) {
    throw new StudyOnboardingError("Select valid AI agent tools")
  }
  const selectedTools = new Set(record.agentTools as StudyAgentTool[])
  // Checkbox ordering is a browser detail, not a different participant
  // response. Persist the known-option order so post-consent exact retries
  // remain idempotent across renders and browsers.
  const agentTools = STUDY_AGENT_TOOLS.filter((tool) => selectedTools.has(tool))
  if (agentTools.length === 0 || selectedTools.size !== (record.agentTools as unknown[]).length) {
    throw new StudyOnboardingError("Select each AI agent tool at most once")
  }
  if (record.agentUseFrequency === "Never") {
    if (agentTools.length !== 1 || agentTools[0] !== "None") {
      throw new StudyOnboardingError("Never must be paired with None as the only AI agent tool")
    }
  } else if (agentTools.includes("None")) {
    throw new StudyOnboardingError("None is only available when AI agent use frequency is Never")
  }
  return {
    prolificId,
    age: record.age as number,
    gender: record.gender,
    agentMemoryExperience: record.agentMemoryExperience,
    agentUseFrequency: record.agentUseFrequency,
    agentTools,
  }
}

export class StudyOnboardingService {
  private readonly allocationParticipantId: string
  private readonly expectedProlificId: string
  private readonly now: () => string

  constructor(args: {
    store: StudyOnboardingStore
    allocationParticipantId: string
    expectedProlificId?: string
    now?: () => string
  }) {
    this.store = args.store
    this.allocationParticipantId = args.allocationParticipantId.trim()
    if (!this.allocationParticipantId) throw new Error("A server-owned study allocation participant ID is required")
    this.expectedProlificId = args.expectedProlificId?.trim() ?? ""
    this.now = args.now ?? (() => new Date().toISOString())
  }

  private readonly store: StudyOnboardingStore

  private record(): StudyParticipantOnboardingRecord | null {
    const record = this.store.getParticipantOnboarding()
    if (record && record.participantId !== this.allocationParticipantId) {
      throw new StudyOnboardingError("Stored onboarding does not match this study allocation", 409)
    }
    if (record && this.expectedProlificId && record.information.prolificId !== this.expectedProlificId) {
      throw new StudyOnboardingError("Stored Prolific ID does not match this verified study allocation", 409)
    }
    return record
  }

  status(): StudyOnboardingStatus {
    const record = this.record()
    if (!record) return {
      stage: "information",
      ...(this.expectedProlificId ? { prolificId: this.expectedProlificId } : {}),
    }
    if (record.consent?.version !== STUDY_ONBOARDING_CONSENT_VERSION) {
      return {
        stage: "consent",
        information: record.information,
        ...(this.expectedProlificId ? { prolificId: this.expectedProlificId } : {}),
      }
    }
    if (record.briefing?.version !== STUDY_ONBOARDING_BRIEFING_VERSION) {
      return {
        stage: "briefing",
        information: record.information,
        ...(this.expectedProlificId ? { prolificId: this.expectedProlificId } : {}),
      }
    }
    return {
      stage: "complete",
      information: record.information,
      ...(this.expectedProlificId ? { prolificId: this.expectedProlificId } : {}),
    }
  }

  saveInformation(value: unknown): StudyOnboardingStatus {
    const information = informationFrom(value)
    if (this.expectedProlificId && information.prolificId !== this.expectedProlificId) {
      throw new StudyOnboardingError("Prolific ID does not match this verified study allocation", 409)
    }
    const existing = this.record()
    if (existing?.consent) {
      if (JSON.stringify(existing.information) === JSON.stringify(information)) return this.status()
      throw new StudyOnboardingError("Study onboarding information cannot be changed after consent", 409)
    }
    this.store.saveParticipantOnboardingInformation({
      participantId: this.allocationParticipantId,
      information,
      submittedAt: this.now(),
    })
    return this.status()
  }

  recordConsent(): StudyOnboardingStatus {
    if (!this.record()) throw new StudyOnboardingError("Study onboarding information is required before consent", 409)
    this.store.recordParticipantOnboardingConsent({
      participantId: this.allocationParticipantId,
      version: STUDY_ONBOARDING_CONSENT_VERSION,
      acceptedAt: this.now(),
    })
    return this.status()
  }

  recordBriefing(): StudyOnboardingStatus {
    const existing = this.record()
    if (existing?.consent?.version !== STUDY_ONBOARDING_CONSENT_VERSION) {
      throw new StudyOnboardingError("Current study consent is required before briefing", 409)
    }
    this.store.recordParticipantOnboardingBriefing({
      participantId: this.allocationParticipantId,
      version: STUDY_ONBOARDING_BRIEFING_VERSION,
      completedAt: this.now(),
    })
    return this.status()
  }

  isBriefingComplete(): boolean {
    return this.status().stage === "complete"
  }
}
