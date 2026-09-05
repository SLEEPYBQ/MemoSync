import { useEffect, useState } from "react"
import type { StudyQuestionnaireItem } from "../../../shared/studyTasks"
import { applyStudyQuestionnaireField, type StudyQuestionnaireDraft } from "../study/studyQuestionnaireDraft"
import type { RawTlxDraft, SusDraft } from "../study/studyPostSession"
import { StudyDock } from "../study/StudyDock"
import {
  RawTlxForm,
  StudyCompleteSurface,
  StudyFinishSurface,
  StudyFreezingSurface,
  StudyMemoryQuestionnaireSurface,
  StudyNextSessionSurface,
  SusForm,
} from "../study/StudyPostSessionSurfaces"

export const GUIDE_POST_SESSION_PHASES = [
  "finish",
  "freezing",
  "memory_questionnaire",
  "monitoring_tlx",
  "control_tlx",
  "next_session",
  "sus",
  "complete",
] as const

export type GuidePostSessionPhase = (typeof GUIDE_POST_SESSION_PHASES)[number]

const DEMO_ITEM: StudyQuestionnaireItem = {
  probeId: "guide-memory-probe",
  snapshotId: "guide-frozen-snapshot",
  cue: "Ask for confirmation before destructive actions.",
}

const EMPTY_DRAFT: StudyQuestionnaireDraft = {
  probeId: DEMO_ITEM.probeId,
  snapshotId: DEMO_ITEM.snapshotId,
}

function FinishPractice() {
  const [stage, setStage] = useState<"dock" | "intro" | "confirm" | "freezing">("dock")
  if (stage === "dock") {
    return <StudyDock demo onDemoFinish={() => setStage("intro")} />
  }
  return (
    <div className="mx-auto w-full max-w-[640px] px-6 py-10">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Apartment rentals · Session 2 · End-of-session questions
      </div>
      {stage === "freezing" ? (
        <StudyFreezingSurface />
      ) : (
        <StudyFinishSurface
          taskTitle="Apartment rentals · Session 2"
          confirmArmed={stage === "confirm"}
          onArm={() => setStage("confirm")}
          onCancel={() => setStage("intro")}
          onConfirm={() => setStage("freezing")}
        />
      )}
    </div>
  )
}

/**
 * Guide-only local state/view host. It reuses the production questionnaire
 * surfaces but never owns transport and never preselects a measurement answer.
 * Every control updates tutorial-only state; Guide Next advances phases.
 */
export function GuidePostSessionJourney({ phase }: { phase: GuidePostSessionPhase }) {
  const [questionnaire, setQuestionnaire] = useState<StudyQuestionnaireDraft>(EMPTY_DRAFT)
  const [monitoring, setMonitoring] = useState<RawTlxDraft>({})
  const [control, setControl] = useState<RawTlxDraft>({})
  const [sus, setSus] = useState<SusDraft>({})
  const [receipt, setReceipt] = useState<string | null>(null)
  useEffect(() => setReceipt(null), [phase])
  if (phase === "finish") return <FinishPractice />
  return (
    <div className="mx-auto w-full max-w-[640px] px-6 py-10">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Apartment rentals · Session 2 · End-of-session questions
      </div>
      {phase === "freezing" ? <StudyFreezingSurface /> : null}
      {phase === "memory_questionnaire" ? (
        <StudyMemoryQuestionnaireSurface
          item={DEMO_ITEM}
          itemIndex={0}
          itemCount={1}
          draft={questionnaire}
          submitting={false}
          onField={(field, value) => setQuestionnaire((draft) => applyStudyQuestionnaireField(draft, field, value))}
          onTextField={(field, value) => setQuestionnaire((draft) => applyStudyQuestionnaireField(draft, field, value))}
          onBack={() => setReceipt("Returned to the previous local practice item.")}
          onContinue={() => setReceipt("Memory practice response recorded locally.")}
        />
      ) : null}
      {phase === "monitoring_tlx" ? (
        <RawTlxForm
          activity="monitoring"
          draft={monitoring}
          submitting={false}
          onChange={(dimension, rating) => setMonitoring((draft) => ({ ...draft, [dimension]: rating }))}
          onSubmit={() => setReceipt("Monitoring workload practice recorded locally.")}
        />
      ) : null}
      {phase === "control_tlx" ? (
        <RawTlxForm
          activity="control"
          draft={control}
          submitting={false}
          onChange={(dimension, rating) => setControl((draft) => ({ ...draft, [dimension]: rating }))}
          onSubmit={() => setReceipt("Control workload practice recorded locally.")}
        />
      ) : null}
      {phase === "next_session" ? (
        <StudyNextSessionSurface onContinue={() => setReceipt("Next-session practice completed locally.")} />
      ) : null}
      {phase === "sus" ? (
        <SusForm
          draft={sus}
          submitting={false}
          onChange={(item, rating) => setSus((draft) => ({ ...draft, [item]: rating }))}
          onSubmit={() => setReceipt("SUS practice recorded locally.")}
        />
      ) : null}
      {phase === "complete" ? (
        <div>
          <div
            data-guide-completion-preview="true"
            className="mt-6 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/30 dark:text-amber-100"
          >
            <p className="font-semibold">Guide preview</p>
            <p className="mt-1 text-pretty leading-relaxed">
              This practice page records nothing and does not mean the study is complete. In the actual study,
              the completion page appears only after you submit the final SUS questionnaire.
            </p>
          </div>
          <StudyCompleteSurface completionCode={null} />
        </div>
      ) : null}
      {receipt ? (
        <p className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
          {receipt}
        </p>
      ) : null}
    </div>
  )
}
