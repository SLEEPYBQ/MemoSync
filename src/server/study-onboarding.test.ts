import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import { StudyOnboardingError, StudyOnboardingService } from "./study-onboarding"
import {
  STUDY_ONBOARDING_BRIEFING_VERSION,
  STUDY_ONBOARDING_CONSENT_VERSION,
} from "../shared/studyOnboarding"

const dirs: string[] = []

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memosync-study-onboarding-"))
  dirs.push(dir)
  return new StudyMemoryStore(join(dir, "study.sqlite"))
}

const profile = {
  prolificId: "  60baf0123456789abcdef0123  ",
  age: 29,
  gender: "Woman",
  agentMemoryExperience: "Occasional",
  agentUseFrequency: "Weekly",
  agentTools: ["Claude Code", "Codex"],
} as const

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("StudyOnboardingService", () => {
  test("durably advances information, consent, and briefing for the allocated participant", () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-study-onboarding-"))
    dirs.push(dir)
    const dbPath = join(dir, "study.sqlite")
    const first = new StudyMemoryStore(dbPath)
    const service = new StudyOnboardingService({
      store: first,
      allocationParticipantId: "P-017",
      now: () => "2026-08-19T10:00:00.000Z",
    })

    expect(service.status()).toEqual({ stage: "information" })
    expect(service.saveInformation(profile)).toEqual(expect.objectContaining({
      stage: "consent",
      information: { ...profile, prolificId: "60baf0123456789abcdef0123" },
    }))
    expect(service.recordConsent()).toMatchObject({ stage: "briefing" })
    expect(service.recordBriefing()).toMatchObject({ stage: "complete" })
    expect(first.getParticipantOnboarding()).toMatchObject({
      participantId: "P-017",
      consent: { version: expect.any(String), acceptedAt: "2026-08-19T10:00:00.000Z" },
      briefing: { version: expect.any(String), completedAt: "2026-08-19T10:00:00.000Z" },
    })
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    const resumed = new StudyOnboardingService({ store: reopened, allocationParticipantId: "P-017" })
    expect(resumed.status()).toMatchObject({
      stage: "complete",
      information: { prolificId: "60baf0123456789abcdef0123", age: 29, agentTools: ["Claude Code", "Codex"] },
    })
    reopened.close()
  })

  test("fails closed for invalid profile data and refuses changes after consent while allowing exact retries", () => {
    const store = makeStore()
    const service = new StudyOnboardingService({ store, allocationParticipantId: "P-017" })

    expect(() => service.saveInformation({ ...profile, age: 17 })).toThrow(StudyOnboardingError)
    expect(() => service.saveInformation({ ...profile, agentUseFrequency: "Never", agentTools: ["Codex"] })).toThrow("None")
    expect(() => service.recordConsent()).toThrow("information")
    expect(() => service.recordBriefing()).toThrow("consent")

    service.saveInformation(profile)
    service.recordConsent()
    expect(service.saveInformation({ ...profile })).toMatchObject({ stage: "briefing" })
    expect(service.saveInformation({ ...profile, agentTools: ["Codex", "Claude Code"] })).toMatchObject({ stage: "briefing" })
    expect(() => service.saveInformation({ ...profile, age: 30 })).toThrow("cannot be changed")
  })

  test("binds a stored record to its server-owned allocation identity", () => {
    const store = makeStore()
    const first = new StudyOnboardingService({ store, allocationParticipantId: "P-017" })
    first.saveInformation(profile)
    const spoofed = new StudyOnboardingService({ store, allocationParticipantId: "P-018" })

    expect(() => spoofed.status()).toThrow("allocation")
  })

  test("prefills and enforces the Prolific ID verified by the orchestrator", () => {
    const store = makeStore()
    const expectedProlificId = "60baf0123456789abcdef0123"
    const service = new StudyOnboardingService({
      store,
      allocationParticipantId: "P-017",
      expectedProlificId,
    })

    expect(service.status()).toEqual({ stage: "information", prolificId: expectedProlificId })
    expect(() => service.saveInformation({
      ...profile,
      prolificId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    })).toThrow(/does not match/i)
    expect(service.saveInformation(profile)).toMatchObject({
      stage: "consent",
      prolificId: expectedProlificId,
      information: { prolificId: expectedProlificId },
    })

    const wrongAllocation = new StudyOnboardingService({
      store,
      allocationParticipantId: "P-017",
      expectedProlificId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    })
    expect(() => wrongAllocation.status()).toThrow(/stored Prolific ID does not match/i)
  })

  test("fails closed rather than projecting a corrupted stored enum", () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-study-onboarding-"))
    dirs.push(dir)
    const dbPath = join(dir, "study.sqlite")
    const first = new StudyMemoryStore(dbPath)
    new StudyOnboardingService({ store: first, allocationParticipantId: "P-017" }).saveInformation(profile)
    first.close()

    const tampered = new Database(dbPath)
    tampered.run("UPDATE study_participant_onboarding SET gender = 'Unknown enum'")
    tampered.close()

    const reopened = new StudyMemoryStore(dbPath)
    expect(() => reopened.getParticipantOnboarding()).toThrow("invalid")
    reopened.close()
  })

  test("fails closed when persisted profile or stage invariants are corrupted", () => {
    const corruptions = [
      "UPDATE study_participant_onboarding SET age = 5",
      "UPDATE study_participant_onboarding SET prolific_id = '   '",
      `UPDATE study_participant_onboarding SET prolific_id = '${"x".repeat(201)}'`,
      "UPDATE study_participant_onboarding SET information_submitted_at = ''",
      "UPDATE study_participant_onboarding SET information_submitted_at = 't'",
      "UPDATE study_participant_onboarding SET consent_version = '', consent_accepted_at = '2026-08-19T10:01:00.000Z'",
      "UPDATE study_participant_onboarding SET consent_version = 'consent-v1', consent_accepted_at = ''",
      "UPDATE study_participant_onboarding SET consent_version = 'consent-v1', consent_accepted_at = 't'",
      "UPDATE study_participant_onboarding SET briefing_version = 'briefing-v1', briefing_completed_at = 't'",
      "UPDATE study_participant_onboarding SET consent_version = 'consent-v1', consent_accepted_at = '2026-08-19T10:01:00.000Z', briefing_version = '', briefing_completed_at = '2026-08-19T10:02:00.000Z'",
      "UPDATE study_participant_onboarding SET consent_version = 'consent-v1', consent_accepted_at = '2026-08-19T10:01:00.000Z', briefing_version = 'briefing-v1', briefing_completed_at = ''",
      "UPDATE study_participant_onboarding SET consent_version = 'consent-v1', consent_accepted_at = '2026-08-19T10:01:00.000Z', briefing_version = 'briefing-v1', briefing_completed_at = 't'",
    ]

    for (const [index, sql] of corruptions.entries()) {
      const dir = mkdtempSync(join(tmpdir(), `memosync-study-onboarding-tamper-${index}-`))
      dirs.push(dir)
      const dbPath = join(dir, "study.sqlite")
      const first = new StudyMemoryStore(dbPath)
      new StudyOnboardingService({ store: first, allocationParticipantId: "P-017" }).saveInformation(profile)
      first.close()

      const tampered = new Database(dbPath)
      tampered.run(sql)
      tampered.close()

      const reopened = new StudyMemoryStore(dbPath)
      expect(() => reopened.getParticipantOnboarding()).toThrow("invalid")
      reopened.close()
    }
  })

  test("reopens stale consent and briefing versions without changing current retry timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "memosync-study-onboarding-version-"))
    dirs.push(dir)
    const dbPath = join(dir, "study.sqlite")
    const first = new StudyMemoryStore(dbPath)
    first.saveParticipantOnboardingInformation({
      participantId: "P-017",
      information: {
        ...profile,
        prolificId: profile.prolificId.trim(),
        agentTools: [...profile.agentTools],
      },
      submittedAt: "2026-08-19T09:00:00.000Z",
    })
    first.recordParticipantOnboardingConsent({
      participantId: "P-017",
      version: "2026-08-18-v0",
      acceptedAt: "2026-08-19T09:01:00.000Z",
    })
    first.recordParticipantOnboardingBriefing({
      participantId: "P-017",
      version: "2026-08-18-v0",
      completedAt: "2026-08-19T09:02:00.000Z",
    })
    first.close()

    const reopened = new StudyMemoryStore(dbPath)
    const times = [
      "2026-08-19T10:01:00.000Z",
      "2026-08-19T10:01:30.000Z",
      "2026-08-19T10:02:00.000Z",
      "2026-08-19T10:02:30.000Z",
    ]
    const service = new StudyOnboardingService({
      store: reopened,
      allocationParticipantId: "P-017",
      now: () => times.shift()!,
    })

    expect(service.status()).toMatchObject({ stage: "consent" })
    expect(service.recordConsent()).toMatchObject({ stage: "briefing" })
    expect(reopened.getParticipantOnboarding()).toMatchObject({
      consent: {
        version: STUDY_ONBOARDING_CONSENT_VERSION,
        acceptedAt: "2026-08-19T10:01:00.000Z",
      },
      briefing: null,
    })
    service.recordConsent()
    expect(reopened.getParticipantOnboarding()!.consent!.acceptedAt).toBe("2026-08-19T10:01:00.000Z")

    reopened.recordParticipantOnboardingBriefing({
      participantId: "P-017",
      version: "2026-08-18-v0",
      completedAt: "2026-08-19T09:02:00.000Z",
    })
    expect(service.status()).toMatchObject({ stage: "briefing" })
    expect(service.recordBriefing()).toMatchObject({ stage: "complete" })
    expect(reopened.getParticipantOnboarding()!.briefing).toEqual({
      version: STUDY_ONBOARDING_BRIEFING_VERSION,
      completedAt: "2026-08-19T10:02:00.000Z",
    })
    service.recordBriefing()
    expect(reopened.getParticipantOnboarding()!.briefing!.completedAt).toBe("2026-08-19T10:02:00.000Z")
    reopened.close()
  })
})
