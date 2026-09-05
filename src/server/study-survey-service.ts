import { randomUUID } from "node:crypto"
import {
  calculateRawTlxScore,
  calculateSusScore,
  parseStudyRawTlxActivityResponse,
  parseStudySusResponse,
} from "../shared/studyScales"
import type { ExperimentLogger } from "./experiment/logger"
import type { NextSessionPreparer } from "./experiment/baseline-project-copy"
import type { StudyMemoryStore } from "./experiment/study-memory-store"
import type { StudyRegistry } from "./study-registry"

export type StudyPostSessionStep =
  | "memory_questionnaire"
  | "monitoring_tlx"
  | "control_tlx"
  | "next_session"
  | "sus"
  | "complete"

export interface PublicStudyPostSession {
  taskId: string
  snapshotId: string
  requiredStep: StudyPostSessionStep
  nextTaskId: string | null
  monitoringSubmitted: boolean
  controlSubmitted: boolean
  sessionCompleted: boolean
  susSubmitted: boolean
  /** Server-issued Prolific code; non-null only once the study is complete. */
  completionCode: string | null
  /** Server-configured Prolific return URL; terminal state only. */
  completionUrl: string | null
}

export class StudySurveyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "StudySurveyError"
  }
}

export class StudySurveyService {
  private readonly store: StudyMemoryStore
  private readonly registry: StudyRegistry
  private readonly logger: Pick<ExperimentLogger, "event">
  private readonly allocationParticipantId: string
  private readonly now: () => string
  private readonly randomId: () => string
  private readonly nextSessionPreparer: NextSessionPreparer | null
  private readonly completionUrl: string

  constructor(args: {
    store: StudyMemoryStore
    registry: StudyRegistry
    logger: Pick<ExperimentLogger, "event">
    /** Orchestrator-issued identity; empty means no formal allocation. */
    allocationParticipantId: string
    now?: () => string
    randomId?: () => string
    nextSessionPreparer: NextSessionPreparer | null
    completionUrl?: string
  }) {
    this.store = args.store
    this.registry = args.registry
    this.logger = args.logger
    this.allocationParticipantId = args.allocationParticipantId
    this.now = args.now ?? (() => new Date().toISOString())
    this.randomId = args.randomId ?? randomUUID
    this.nextSessionPreparer = args.nextSessionPreparer
    this.completionUrl = args.completionUrl?.trim() ?? ""
  }

  get(taskId: string): PublicStudyPostSession {
    const snapshot = this.store.getTaskFreezeSnapshot(taskId)
    if (!snapshot) throw new StudySurveyError("End the session before loading its questions.", 409)
    const questionnaire = this.store.getQuestionnaireSubmission(snapshot.snapshotId)
    const monitoring = this.store.getRawTlxSubmission(snapshot.snapshotId, "monitoring")
    const control = this.store.getRawTlxSubmission(snapshot.snapshotId, "control")
    const completion = this.store.getSessionCompletion(taskId)
    const sus = this.store.getSusSubmission()
    const activeTaskId = this.registry.activeTaskId()

    let requiredStep: StudyPostSessionStep
    let nextTaskId: string | null = null
    if (!questionnaire) requiredStep = "memory_questionnaire"
    else if (!monitoring) requiredStep = "monitoring_tlx"
    else if (!control) requiredStep = "control_tlx"
    else if (!completion) {
      throw new StudySurveyError("Session completion is inconsistent. Please let the experimenter know.", 503)
    } else if (activeTaskId !== null) {
      requiredStep = "next_session"
      nextTaskId = activeTaskId
    } else if (!sus) requiredStep = "sus"
    else requiredStep = "complete"

    // The real code exists only as the durable server receipt and is returned
    // only in the terminal complete state. A pre-receipt legacy SUS row is
    // repaired here from its original durable submission evidence so reload
    // and process restart cannot strand a completed participant without code.
    let receipt = null
    if (requiredStep === "complete") {
      if (!this.allocationParticipantId) {
        throw new StudySurveyError("This runtime has no allocation identity, so completion cannot be restored.", 503)
      }
      try {
        receipt = this.store.ensureCompletionReceipt(this.allocationParticipantId)
      } catch (error) {
        throw new StudySurveyError(
          error instanceof Error ? error.message : "Completion receipt could not be restored.",
          503,
        )
      }
      if (!receipt) {
        throw new StudySurveyError("Study completion is missing its SUS submission evidence.", 503)
      }
    }
    return {
      taskId,
      snapshotId: snapshot.snapshotId,
      requiredStep,
      nextTaskId,
      monitoringSubmitted: monitoring !== null,
      controlSubmitted: control !== null,
      sessionCompleted: completion !== null,
      susSubmitted: sus !== null,
      completionCode: receipt?.code ?? null,
      completionUrl: receipt && this.completionUrl ? this.completionUrl : null,
    }
  }

  async submitRawTlx(input: {
    taskId: string
    snapshotId: string
    response: unknown
  }): Promise<PublicStudyPostSession> {
    const snapshot = this.store.getTaskFreezeSnapshot(input.taskId)
    if (!snapshot || snapshot.snapshotId !== input.snapshotId) {
      throw new StudySurveyError("This session snapshot is stale. Reload the questions.", 409)
    }
    const response = parseStudyRawTlxActivityResponse(input.response)
    if (!response) throw new StudySurveyError("Raw TLX response is malformed.", 400)

    const completionBefore = this.store.getSessionCompletion(input.taskId)
    if (response.activity === "control" && !completionBefore && this.nextSessionPreparer) {
      if (!this.store.getQuestionnaireSubmission(input.snapshotId)) {
        throw new StudySurveyError(`Memory questionnaire is not submitted for snapshot ${input.snapshotId}`, 409)
      }
      if (!this.store.getRawTlxSubmission(input.snapshotId, "monitoring")) {
        throw new StudySurveyError(`Monitoring Raw TLX is not submitted for snapshot ${input.snapshotId}`, 409)
      }
      const nextTaskId = this.registry.nextTaskIdAfter(input.taskId)
      if (nextTaskId) {
        try {
          await this.nextSessionPreparer.prepareNextSession({
            fromTaskId: input.taskId,
            toTaskId: nextTaskId,
            sourceFreezeRef: {
              taskId: snapshot.taskId,
              snapshotId: snapshot.snapshotId,
              frozenAt: snapshot.frozenAt,
            },
          })
        } catch (error) {
          throw new StudySurveyError(
            error instanceof Error ? error.message : "The next project's memory copy could not be prepared.",
            503,
          )
        }
      }
    }
    let result
    try {
      result = this.store.recordRawTlxSubmission({
        submissionId: this.randomId(),
        ...(response.activity === "control" ? { completionId: this.randomId() } : {}),
        snapshotId: input.snapshotId,
        submittedAt: this.now(),
        response,
      })
    } catch (error) {
      throw new StudySurveyError(error instanceof Error ? error.message : "Raw TLX submission failed.", 409)
    }

    if (result.created) {
      this.logger.event({
        type: "study.raw_tlx.submit",
        taskId: input.taskId,
        snapshotId: input.snapshotId,
        submissionId: result.submission.submissionId,
        activity: response.activity,
        ratings: response.ratings,
        score: calculateRawTlxScore(response.ratings),
      })
    }
    if (result.completion) {
      this.registry.noteSessionComplete(input.taskId, result.completion.completedAt)
      if (!completionBefore) {
        this.logger.event({
          type: "study.session.complete",
          taskId: input.taskId,
          snapshotId: input.snapshotId,
          completionId: result.completion.completionId,
        })
      }
    }
    return this.get(input.taskId)
  }

  submitSus(input: { taskId: string; response: unknown }): PublicStudyPostSession {
    if (this.registry.activeTaskId() !== null || !this.store.getSessionCompletion(input.taskId)) {
      throw new StudySurveyError("Complete every session before submitting SUS.", 409)
    }
    const response = parseStudySusResponse(input.response)
    if (!response) throw new StudySurveyError("SUS response is malformed.", 400)
    if (!this.allocationParticipantId) {
      throw new StudySurveyError("This runtime has no allocation identity, so completion cannot be recorded.", 503)
    }

    let result
    try {
      result = this.store.recordSusSubmission({
        submissionId: this.randomId(),
        submittedAt: this.now(),
        participantId: this.allocationParticipantId,
        response,
      })
    } catch (error) {
      throw new StudySurveyError(error instanceof Error ? error.message : "SUS submission failed.", 409)
    }
    this.registry.noteSusSubmit(result.submission.submittedAt)
    if (result.created) {
      this.logger.event({
        type: "study.sus.submit",
        taskId: input.taskId,
        submissionId: result.submission.submissionId,
        ratings: response.ratings,
        score: calculateSusScore(response.ratings),
      })
      this.logger.event({
        type: "study.completion.receipt",
        taskId: input.taskId,
        susSubmissionId: result.receipt.susSubmissionId,
        codeVersion: result.receipt.codeVersion,
        issuedAt: result.receipt.issuedAt,
      })
    }
    return this.get(input.taskId)
  }
}
