// Experiment shell · the post-session quiz (MemoSync Experiment Final).
// A dedicated full-screen surface with NO way back into the app: once the
// quiz starts, the participant must not re-inspect the conversation, the
// memory panels, or the board, or the monitoring probe would be contaminated.
// Items are the memories injected during the task's time window (across all
// chats, with no manual session picking); per item three question groups yield
// D_i, A_i, and the participant's execution judgment. The full frozen cue is
// shown; O_i remains server-side and immutable.
import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { Button } from "../../components/ui/button"
import {
  getStudyTask,
  type StudyQuestionnaireAnswer,
  type StudyQuestionnaireAnswerV2,
  type StudyQuestionnaireItem,
  type StudyQuestionnaireVersion,
} from "../../../shared/studyTasks"
import {
  attentionCheckMemoryIndex,
  type PublicStudyAttentionCheck,
} from "../../../shared/studyAttentionChecks"
import type { RawTlxActivity, RawTlxDimensionId } from "../../../shared/studyScales"
import type { QuizQuestion } from "./studyQuizCopy"
import {
  parseStudyQuestionnairePayload,
  type StudyQuestionnairePayload,
} from "./studyQuestionnaireDraft"
import {
  applyVersionedStudyQuestionnaireField,
  buildVersionedStudyQuestionnaireAnswer,
  createVersionedStudyQuestionnaireDraft,
  type VersionedStudyQuestionnaireDraft,
} from "./studyQuestionnaireInstrument"
import {
  buildRawTlxResponse,
  buildSusResponse,
  parseStudyPostSessionPayload,
  type RawTlxDraft,
  type StudyPostSessionPayload,
  type StudyPostSessionStep,
  type SusDraft,
} from "./studyPostSession"
import {
  RawTlxForm,
  StudyCompleteSurface,
  StudyFinishSurface,
  StudyFreezingSurface,
  StudyLegacyMemoryQuestionnaireSurface,
  StudyMemoryQuestionnaireSurface,
  StudyNextSessionSurface,
  StudyNoFocusedMemorySurface,
  SusForm,
} from "./StudyPostSessionSurfaces"
import { recordStudyStageEntered, type StudyTimedStage } from "./studyTelemetry"

type Phase =
  | "loading"
  | "intro"
  | "freezing"
  | "quiz"
  | "submitting_questionnaire"
  | "monitoring_tlx"
  | "submitting_monitoring_tlx"
  | "control_tlx"
  | "submitting_control_tlx"
  | "next_session"
  | "sus"
  | "submitting_sus"
  | "complete"

interface StudyCompletionEligibilityPayload {
  taskId: string
  eligible: boolean
  missing: Array<{ code: string; message: string }>
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  return body?.error?.message ?? fallback
}

async function readQuestionnairePayload(res: Response, fallback: string): Promise<StudyQuestionnairePayload> {
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  const payload = parseStudyQuestionnairePayload(body?.data)
  if (!payload) throw new Error(fallback)
  return payload
}

async function readPostSessionPayload(res: Response, fallback: string): Promise<StudyPostSessionPayload> {
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  const payload = parseStudyPostSessionPayload(body?.data)
  if (!payload) throw new Error(fallback)
  return payload
}

async function getFrozenQuestionnaire(taskId: string, signal?: AbortSignal): Promise<StudyQuestionnairePayload | null> {
  const res = await fetch(`/api/study/questionnaire?taskId=${encodeURIComponent(taskId)}`, { signal })
  // The service uses 409 specifically for an active task with no freeze
  // snapshot yet. This read-only probe must return to the confirmation screen,
  // never turn that state into an automatic freeze.
  if (res.status === 404 || res.status === 409) return null
  if (!res.ok) throw new Error(await readError(res, `could not load the questions (${res.status})`))
  return readQuestionnairePayload(res, "the frozen questionnaire response was invalid")
}

async function getPostSession(taskId: string, signal?: AbortSignal): Promise<StudyPostSessionPayload> {
  const res = await fetch(`/api/study/post-session?taskId=${encodeURIComponent(taskId)}`, { signal })
  if (!res.ok) throw new Error(await readError(res, `could not load the remaining questions (${res.status})`))
  return readPostSessionPayload(res, "the post-session response was invalid")
}

async function getCompletionEligibility(taskId: string, signal?: AbortSignal): Promise<StudyCompletionEligibilityPayload> {
  const res = await fetch(`/api/study/completion-eligibility?taskId=${encodeURIComponent(taskId)}`, { signal })
  if (!res.ok) throw new Error(await readError(res, `could not check session readiness (${res.status})`))
  const body = await res.json().catch(() => null) as { data?: unknown } | null
  const data = body?.data
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the session readiness response was invalid")
  const record = data as Record<string, unknown>
  if (record.taskId !== taskId || typeof record.eligible !== "boolean" || !Array.isArray(record.missing)) {
    throw new Error("the session readiness response was invalid")
  }
  const missing = record.missing.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    return typeof entry.code === "string" && typeof entry.message === "string"
      ? [{ code: entry.code, message: entry.message }]
      : []
  })
  if (missing.length !== record.missing.length) throw new Error("the session readiness response was invalid")
  return { taskId, eligible: record.eligible, missing }
}

function phaseForPostSessionStep(step: StudyPostSessionStep): Phase {
  switch (step) {
    case "memory_questionnaire": return "quiz"
    case "monitoring_tlx": return "monitoring_tlx"
    case "control_tlx": return "control_tlx"
    case "next_session": return "next_session"
    case "sus": return "sus"
    case "complete": return "complete"
  }
}

export function StudyQuizPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const task = taskId ? getStudyTask(taskId) : undefined

  const [phase, setPhase] = useState<Phase>("loading")
  const [error, setError] = useState<string | null>(null)
  const [snapshotId, setSnapshotId] = useState<string | null>(null)
  const [questionnaireVersion, setQuestionnaireVersion] = useState<StudyQuestionnaireVersion | null>(null)
  const [items, setItems] = useState<StudyQuestionnaireItem[] | null>(null)
  const [attentionCheck, setAttentionCheck] = useState<PublicStudyAttentionCheck | null>(null)
  const [attentionCheckAnswer, setAttentionCheckAnswer] = useState<string | null>(null)
  const [itemIndex, setItemIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, VersionedStudyQuestionnaireDraft>>({})
  const [postSession, setPostSession] = useState<StudyPostSessionPayload | null>(null)
  const [monitoringTlx, setMonitoringTlx] = useState<RawTlxDraft>({})
  const [controlTlx, setControlTlx] = useState<RawTlxDraft>({})
  const [sus, setSus] = useState<SusDraft>({})
  const [eligibility, setEligibility] = useState<StudyCompletionEligibilityPayload | null>(null)
  const freezeInFlight = useRef(false)
  // Ending a session is irreversible — one stray click must not do it
  // (it happened during piloting). The button arms a confirm step instead.
  const [confirmArmed, setConfirmArmed] = useState(false)

  const installQuestionnaire = useCallback((payload: StudyQuestionnairePayload) => {
    setSnapshotId(payload.snapshotId)
    setQuestionnaireVersion(payload.questionnaireVersion)
    setAttentionCheck(payload.attentionCheck)
    setAttentionCheckAnswer(null)
    setItems(payload.items)
    setItemIndex(0)
    setDrafts({})
    setError(null)
  }, [])

  const installPostSession = useCallback((payload: StudyPostSessionPayload) => {
    setPostSession(payload)
    setSnapshotId(payload.snapshotId)
    setError(null)
    setPhase(phaseForPostSessionStep(payload.requiredStep))
  }, [])

  const openQuestionnaire = useCallback(async (
    payload: StudyQuestionnairePayload,
    signal?: AbortSignal,
  ) => {
    installQuestionnaire(payload)
    if (!payload.submitted) {
      setPhase("quiz")
      return
    }
    if (!taskId) return
    const remaining = await getPostSession(taskId, signal)
    if (remaining.taskId !== taskId || remaining.snapshotId !== payload.snapshotId) {
      throw new Error("the post-session questions do not match this frozen session")
    }
    installPostSession(remaining)
  }, [installPostSession, installQuestionnaire, taskId])

  const loadExistingQuestionnaire = useCallback(async () => {
    if (!taskId) return
    setPhase("loading")
    setError(null)
    try {
      const payload = await getFrozenQuestionnaire(taskId)
      if (payload) await openQuestionnaire(payload)
      else setPhase("intro")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "could not load the questions")
    }
  }, [openQuestionnaire, taskId])

  // Reload only restores an already-frozen questionnaire. A missing snapshot
  // returns to the confirmation screen; GET never ends an active session.
  useEffect(() => {
    if (!taskId || !task) return
    const controller = new AbortController()
    setPhase("loading")
    setError(null)
    void getFrozenQuestionnaire(taskId, controller.signal)
      .then(async (payload) => {
        if (payload) await openQuestionnaire(payload, controller.signal)
        else setPhase("intro")
      })
      .catch((caught) => {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : "could not load the questions")
      })
    return () => controller.abort()
  }, [openQuestionnaire, task, taskId])

  useEffect(() => {
    if (phase !== "intro" || !taskId) return
    setEligibility(null)
    setConfirmArmed(false)
    let disposed = false
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const next = await getCompletionEligibility(taskId, controller.signal)
        if (!disposed) {
          setEligibility(next)
          setError(null)
        }
      } catch (caught) {
        if (!disposed && !controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "could not check session readiness")
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => {
      disposed = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [phase, taskId])

  // No accidental escape while the session is freezing or answers are pending.
  useEffect(() => {
    if (phase === "loading" || phase === "intro" || phase === "next_session" || phase === "complete") return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [phase])

  // Each item and each post-session block starts at its top; the preceding
  // memory questionnaire or scale may leave this full-screen surface mid-scroll.
  useEffect(() => {
    document.querySelector("[data-study-quiz-scroll]")?.scrollTo({ top: 0 })
  }, [itemIndex, phase])

  useEffect(() => {
    if (!taskId) return
    const stage: StudyTimedStage | null = phase === "quiz"
      ? "memory_questionnaire"
      : phase === "monitoring_tlx"
        ? "monitoring_tlx"
        : phase === "control_tlx"
          ? "control_tlx"
          : phase === "sus"
            ? "sus"
            : null
    if (stage) void recordStudyStageEntered(stage, stage === "sus" ? undefined : taskId)
  }, [phase, taskId])

  // Ending the session comes first: the task's window closes server-side (no
  // more prompts anywhere until the questionnaire is in), then the questions
  // open over everything injected during that window.
  const startQuiz = useCallback(async () => {
    if (!taskId || freezeInFlight.current) return
    freezeInFlight.current = true
    setPhase("freezing")
    setError(null)
    try {
      const res = await fetch("/api/study/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      })
      if (!res.ok) throw new Error(await readError(res, `could not end the session (${res.status})`))
      let payload: StudyQuestionnairePayload | null = null
      try {
        payload = await readQuestionnairePayload(res, "the freeze response was invalid")
      } catch {
        // A freeze implementation may return only the snapshot id. GET is the
        // canonical reload path and reads the same immutable snapshot.
        payload = await getFrozenQuestionnaire(taskId)
      }
      if (!payload) throw new Error("the session ended, but its questionnaire is not ready yet")
      await openQuestionnaire(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "failed to end the session")
      setPhase("intro")
      setConfirmArmed(true)
    } finally {
      freezeInFlight.current = false
    }
  }, [openQuestionnaire, taskId])

  const item = items?.[itemIndex]
  const draft = item
    ? drafts[item.probeId]
      ?? (questionnaireVersion ? createVersionedStudyQuestionnaireDraft(questionnaireVersion, item) : null)
    : null
  const isLast = items !== null && itemIndex === items.length - 1
  const attentionCheckIndex = items ? attentionCheckMemoryIndex(items.length) : null
  const visibleAttentionCheck = attentionCheckIndex === itemIndex ? attentionCheck : null

  const setField = useCallback(
    (field: QuizQuestion["field"] | "correctedContent" | "believedContentText", value: string) => {
      if (!item || !questionnaireVersion) return
      setDrafts((current) => ({
        ...current,
        [item.probeId]: applyVersionedStudyQuestionnaireField(
          current[item.probeId] ?? createVersionedStudyQuestionnaireDraft(questionnaireVersion, item),
          field,
          value,
        ),
      }))
    },
    [item, questionnaireVersion]
  )

  const submit = useCallback(async () => {
    if (!taskId || !snapshotId || !items || !questionnaireVersion || !attentionCheck) return
    if (!attentionCheckAnswer) {
      setError("Please answer the attention check before submitting.")
      return
    }
    const answers: Array<StudyQuestionnaireAnswer | StudyQuestionnaireAnswerV2> = []
    for (const entry of items) {
      const answer = buildVersionedStudyQuestionnaireAnswer(
        drafts[entry.probeId] ?? createVersionedStudyQuestionnaireDraft(questionnaireVersion, entry)
      )
      if (!answer) {
        setError("Please complete every required response before submitting.")
        return
      }
      answers.push(answer)
    }
    setPhase("submitting_questionnaire")
    setError(null)
    let questionnaireRecorded = false
    try {
      const res = await fetch("/api/study/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          snapshotId,
          answers,
          attentionCheck: {
            checkId: attentionCheck.checkId,
            selectedValue: attentionCheckAnswer,
          },
        }),
      })
      if (!res.ok) throw new Error(await readError(res, `submit failed (${res.status})`))
      questionnaireRecorded = true
      const remaining = await getPostSession(taskId)
      if (remaining.taskId !== taskId || remaining.snapshotId !== snapshotId) {
        throw new Error("the workload questions do not match this frozen session")
      }
      installPostSession(remaining)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "submit failed")
      // Once POST succeeded, never reopen editable D/A/E answers just because
      // loading the next step failed. The retry path reloads durable state.
      setPhase(questionnaireRecorded ? "loading" : "quiz")
    }
  }, [attentionCheck, attentionCheckAnswer, drafts, installPostSession, items, questionnaireVersion, snapshotId, taskId])

  const setTlxRating = useCallback((
    activity: RawTlxActivity,
    dimension: RawTlxDimensionId,
    rating: number,
  ) => {
    const update = (current: RawTlxDraft) => ({ ...current, [dimension]: rating })
    if (activity === "monitoring") setMonitoringTlx(update)
    else setControlTlx(update)
  }, [])

  const submitTlx = useCallback(async (activity: RawTlxActivity) => {
    if (!taskId || !snapshotId) return
    const response = buildRawTlxResponse(activity, activity === "monitoring" ? monitoringTlx : controlTlx)
    if (!response) {
      setError("Please rate all six workload dimensions before continuing.")
      return
    }
    setPhase(activity === "monitoring" ? "submitting_monitoring_tlx" : "submitting_control_tlx")
    setError(null)
    let workloadRecorded = false
    try {
      const res = await fetch("/api/study/raw-tlx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, snapshotId, response }),
      })
      if (!res.ok) throw new Error(await readError(res, `submit failed (${res.status})`))
      workloadRecorded = true
      const remaining = await readPostSessionPayload(res, "the workload submission response was invalid")
      if (remaining.taskId !== taskId || remaining.snapshotId !== snapshotId) {
        throw new Error("the workload submission does not match this frozen session")
      }
      installPostSession(remaining)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "workload submission failed")
      setPhase(workloadRecorded ? "loading" : activity === "monitoring" ? "monitoring_tlx" : "control_tlx")
    }
  }, [controlTlx, installPostSession, monitoringTlx, snapshotId, taskId])

  const submitSus = useCallback(async () => {
    if (!taskId) return
    const response = buildSusResponse(sus)
    if (!response) {
      setError("Please answer all ten usability statements before submitting.")
      return
    }
    setPhase("submitting_sus")
    setError(null)
    let susRecorded = false
    try {
      const res = await fetch("/api/study/sus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, response }),
      })
      if (!res.ok) throw new Error(await readError(res, `submit failed (${res.status})`))
      susRecorded = true
      const remaining = await readPostSessionPayload(res, "the usability submission response was invalid")
      if (remaining.taskId !== taskId || remaining.requiredStep !== "complete") {
        throw new Error("the study completion response was invalid")
      }
      installPostSession(remaining)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "usability submission failed")
      setPhase(susRecorded ? "loading" : "sus")
    }
  }, [installPostSession, sus, taskId])

  if (!task) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Unknown task.</p>
      </div>
    )
  }

  return (
    <div data-study-quiz-scroll className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-12">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {task.title} · End-of-session questions
        </div>

        {phase === "loading" ? (
          error ? (
            <div className="mt-6">
              <h1 className="text-2xl font-semibold text-foreground">Could not load the questions</h1>
              <p className="mt-2 text-sm text-destructive">{error}</p>
              <Button className="mt-4" onClick={() => void loadExistingQuestionnaire()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking for an existing frozen questionnaire...
            </div>
          )
        ) : null}

        {phase === "intro" ? (
          <StudyFinishSurface
            taskTitle={task.title}
            confirmArmed={confirmArmed}
            eligibility={eligibility?.taskId === taskId ? eligibility : null}
            error={error}
            onArm={() => setConfirmArmed(true)}
            onCancel={() => setConfirmArmed(false)}
            onConfirm={() => void startQuiz()}
          />
        ) : null}

        {phase === "freezing" ? <StudyFreezingSurface /> : null}

        {(phase === "quiz" || phase === "submitting_questionnaire") && items !== null ? (
          items.length === 0 ? (
            <StudyNoFocusedMemorySurface
              attentionCheck={attentionCheck}
              attentionCheckAnswer={attentionCheckAnswer}
              submitting={phase === "submitting_questionnaire"}
              onAttentionCheckAnswer={setAttentionCheckAnswer}
              onSubmit={() => void submit()}
            />
          ) : item && draft ? (
            draft.questionnaireVersion === 1 ? (
              <StudyLegacyMemoryQuestionnaireSurface
                item={item}
                itemIndex={itemIndex}
                itemCount={items.length}
                draft={draft.draft}
                attentionCheck={visibleAttentionCheck}
                attentionCheckAnswer={attentionCheckAnswer}
                submitting={phase === "submitting_questionnaire"}
                onField={setField}
                onTextField={setField}
                onAttentionCheckAnswer={setAttentionCheckAnswer}
                onBack={() => setItemIndex((current) => Math.max(0, current - 1))}
                onContinue={() => (isLast ? void submit() : setItemIndex((current) => current + 1))}
              />
            ) : (
              <StudyMemoryQuestionnaireSurface
                item={item}
                itemIndex={itemIndex}
                itemCount={items.length}
                draft={draft.draft}
                attentionCheck={visibleAttentionCheck}
                attentionCheckAnswer={attentionCheckAnswer}
                submitting={phase === "submitting_questionnaire"}
                onField={setField}
                onTextField={setField}
                onAttentionCheckAnswer={setAttentionCheckAnswer}
                onBack={() => setItemIndex((current) => Math.max(0, current - 1))}
                onContinue={() => (isLast ? void submit() : setItemIndex((current) => current + 1))}
              />
            )
          ) : null
        ) : null}

        {phase === "monitoring_tlx" || phase === "submitting_monitoring_tlx" ? (
          <RawTlxForm
            activity="monitoring"
            draft={monitoringTlx}
            submitting={phase === "submitting_monitoring_tlx"}
            onChange={(dimension, rating) => setTlxRating("monitoring", dimension, rating)}
            onSubmit={() => void submitTlx("monitoring")}
          />
        ) : null}

        {phase === "control_tlx" || phase === "submitting_control_tlx" ? (
          <RawTlxForm
            activity="control"
            draft={controlTlx}
            submitting={phase === "submitting_control_tlx"}
            onChange={(dimension, rating) => setTlxRating("control", dimension, rating)}
            onSubmit={() => void submitTlx("control")}
          />
        ) : null}

        {phase === "next_session" ? (
          <StudyNextSessionSurface
            disabled={!postSession?.nextTaskId}
            onContinue={() => {
              if (postSession?.nextTaskId) navigate(`/study/${postSession.nextTaskId}`, { replace: true })
            }}
          />
        ) : null}

        {phase === "sus" || phase === "submitting_sus" ? (
          <SusForm
            draft={sus}
            submitting={phase === "submitting_sus"}
            onChange={(itemId, rating) => setSus((current) => ({ ...current, [itemId]: rating }))}
            onSubmit={() => void submitSus()}
          />
        ) : null}

        {phase === "complete" ? <StudyCompleteSurface completionCode={postSession?.completionCode ?? null} completionUrl={postSession?.completionUrl ?? null} /> : null}

        {error && phase !== "loading" ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  )
}
