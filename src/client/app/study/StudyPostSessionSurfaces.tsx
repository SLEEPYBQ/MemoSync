import { ArrowRight, Check, CheckCircle2, Circle, Loader2 } from "lucide-react"
import type { StudyQuestionnaireItem } from "../../../shared/studyTasks"
import type { PublicStudyAttentionCheck } from "../../../shared/studyAttentionChecks"
import {
  RAW_TLX_ACTIVITY_INSTRUCTIONS,
  RAW_TLX_DIMENSIONS,
  RAW_TLX_RATING_MAX,
  RAW_TLX_RATING_MIN,
  SUS_ITEMS,
  SUS_RATING_MAX,
  SUS_RATING_MIN,
  type RawTlxActivity,
  type RawTlxDimensionId,
  type SusItemId,
} from "../../../shared/studyScales"
import { Button } from "../../components/ui/button"
import { cn } from "../../lib/utils"
import {
  BELIEVED_CONTENT_PROMPT,
  CORRECTED_CONTENT_PROMPT,
  QUIZ_SECTIONS,
  UNKNOWN_ASSESSMENT_NOTE,
  type QuizQuestion,
} from "./studyQuizCopy"
import {
  buildStudyQuestionnaireAnswer,
  shouldShowStudyQuestion,
  type StudyQuestionnaireDraft,
} from "./studyQuestionnaireDraft"
import {
  buildLegacyStudyQuestionnaireAnswer,
  LEGACY_QUIZ_SECTIONS,
  type LegacyStudyQuestionnaireDraft,
} from "./studyQuestionnaireLegacy"
import {
  buildRawTlxResponse,
  buildSusResponse,
  type RawTlxDraft,
  type SusDraft,
} from "./studyPostSession"
import {
  STUDY_COMPLETION_CODE_INSTRUCTION,
  STUDY_COMPLETION_CODE_LABEL,
  STUDY_COMPLETION_MESSAGE,
  STUDY_COMPLETION_TITLE,
} from "./studyCompletionCopy"

function RadioRow({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
        selected
          ? "border-foreground/60 bg-muted text-foreground"
          : "border-border text-foreground/85 hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-foreground" : "border-muted-foreground/50",
        )}
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-foreground" /> : null}
      </span>
      {label}
    </button>
  )
}

export function StudyAttentionCheckQuestion({
  attentionCheck,
  selectedValue,
  submitting,
  onSelect,
}: {
  attentionCheck: PublicStudyAttentionCheck
  selectedValue: string | null
  submitting: boolean
  onSelect: (value: string) => void
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4 shadow-sm">
      <p className="text-sm font-medium leading-relaxed text-foreground">{attentionCheck.prompt}</p>
      <div className="mt-3 flex flex-col gap-1.5">
        {attentionCheck.options.map((option) => (
          <RadioRow
            key={option.value}
            label={option.label}
            selected={selectedValue === option.value}
            onSelect={() => { if (!submitting) onSelect(option.value) }}
          />
        ))}
      </div>
    </div>
  )
}

export function StudyFinishSurface({
  taskTitle,
  confirmArmed,
  eligibility,
  error,
  onArm,
  onCancel,
  onConfirm,
}: {
  taskTitle: string
  confirmArmed: boolean
  eligibility?: {
    eligible: boolean
    missing: Array<{ code: string; message: string }>
  } | null
  error?: string | null
  onArm: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const requirements = [
    { code: "participant_prompt", label: "You sent at least one task prompt" },
    { code: "completed_agent_turn", label: "At least one agent run finished normally" },
    { code: "workspace_changed", label: "The assigned project contains a real change" },
    { code: "unresolved_memory_interrupt", label: "No stopped memory turn is waiting for Resume" },
  ]
  const missingCodes = new Set(eligibility?.missing.map((item) => item.code) ?? [])
  const eligibilityKnown = eligibility !== null
  const canFinish = eligibility === undefined || eligibility?.eligible === true
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">Finish this session</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The questions are about the work session you just finished. Please answer from
        memory; do not go back to the conversation.
      </p>
      <p className="mt-4 text-sm text-muted-foreground">
        Starting the questions <strong className="text-foreground">ends the session</strong>:
        your chats become read-only, and the next session opens only after the questions are
        submitted.
      </p>
      {eligibility !== undefined ? (
        <div className="mt-5 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Ready to finish?</h2>
            {!eligibilityKnown ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>
          <div className="mt-3 grid gap-2">
            {requirements.map((requirement) => {
              const ready = eligibilityKnown && !missingCodes.has(requirement.code)
              return (
                <div key={requirement.code} className="flex items-start gap-2.5 text-sm">
                  {ready
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className={ready ? "text-foreground" : "text-muted-foreground"}>{requirement.label}</span>
                </div>
              )
            })}
          </div>
          {eligibility?.missing.length ? (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {eligibility.missing.map((item) => item.message).join(" ")}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {confirmArmed ? (
        <div className="mt-5 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-foreground">
            End {taskTitle} now? This cannot be undone.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only continue if you are completely done working on this session's task.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>Go back</Button>
            <Button size="sm" disabled={!canFinish} onClick={onConfirm}>Yes, end the session and start the questions</Button>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <Button disabled={!canFinish} onClick={onArm}>End the session and start the questions</Button>
        </div>
      )}
    </>
  )
}

export function StudyFreezingSurface() {
  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Freezing this session
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Waiting for the current Claude turn and memory updates to settle, then preparing the
        immutable questions. Please keep this page open.
      </p>
    </div>
  )
}

function selectedValue(draft: StudyQuestionnaireDraft, field: QuizQuestion["field"]): string | undefined {
  switch (field) {
    case "desiredContent": return draft.desiredRating === undefined ? undefined : String(draft.desiredRating)
    case "desiredScope": return draft.desiredScope
    case "believedContent": return draft.assessedRating === undefined ? undefined : String(draft.assessedRating)
    case "believedScope": return draft.believedScope
    case "execution": return draft.execution === undefined ? undefined : String(draft.execution)
  }
}

export function StudyMemoryQuestionnaireSurface({
  item,
  itemIndex,
  itemCount,
  draft,
  attentionCheck = null,
  attentionCheckAnswer = null,
  submitting,
  onField,
  onTextField,
  onAttentionCheckAnswer = () => {},
  onBack,
  onContinue,
}: {
  item: StudyQuestionnaireItem
  itemIndex: number
  itemCount: number
  draft: StudyQuestionnaireDraft
  attentionCheck?: PublicStudyAttentionCheck | null
  attentionCheckAnswer?: string | null
  submitting: boolean
  onField: (field: QuizQuestion["field"], value: string) => void
  onTextField: (field: "correctedContent" | "believedContentText", value: string) => void
  onAttentionCheckAnswer?: (value: string) => void
  onBack: () => void
  onContinue: () => void
}) {
  const itemComplete = Boolean(buildStudyQuestionnaireAnswer(draft))
    && (!attentionCheck || Boolean(attentionCheckAnswer))
  const isLast = itemIndex === itemCount - 1
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">Memory {itemIndex + 1} of {itemCount}</h1>
      <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{item.cue}</p>
      </div>
      <div className="mt-6 flex flex-col gap-7">
        {QUIZ_SECTIONS.map((section, sectionIndex) => (
          <div key={section.title} className="contents">
            <div>
            <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
            <div className="mt-3 flex flex-col gap-4">
              {section.questions.map((question) => {
                if (!shouldShowStudyQuestion(draft, question.field)) return null
                return (
                  <div key={question.field}>
                    <p className="text-sm text-foreground/90">{question.prompt}</p>
                    {question.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{question.hint}</p> : null}
                    <div className="mt-2 flex flex-col gap-1.5">
                      {question.options.map((option) => (
                        <RadioRow
                          key={option.value}
                          label={option.label}
                          selected={selectedValue(draft, question.field) === option.value}
                          onSelect={() => onField(question.field, option.value)}
                        />
                      ))}
                    </div>
                    {question.field === "desiredContent"
                    && draft.desiredRating !== undefined
                    && draft.desiredRating !== 5 ? (
                      <label className="mt-3 block text-sm text-foreground/90">
                        {CORRECTED_CONTENT_PROMPT} <span className="text-muted-foreground">(optional)</span>
                        <textarea
                          rows={4}
                          value={draft.correctedContent ?? ""}
                          disabled={submitting}
                          onChange={(event) => onTextField("correctedContent", event.target.value)}
                          placeholder="Write the content you wanted the agent to remember"
                          className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/60"
                        />
                      </label>
                    ) : null}
                    {question.field === "believedContent"
                    && typeof draft.assessedRating === "number"
                    && draft.assessedRating >= 2
                    && draft.assessedRating <= 4 ? (
                      <label className="mt-3 block text-sm text-foreground/90">
                        {BELIEVED_CONTENT_PROMPT} <span className="text-muted-foreground">(optional)</span>
                        <textarea
                          rows={4}
                          value={draft.believedContent ?? ""}
                          disabled={submitting}
                          onChange={(event) => onTextField("believedContentText", event.target.value)}
                          placeholder="Write what you believe the agent remembers"
                          className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/60"
                        />
                      </label>
                    ) : null}
                    {question.field === "believedContent" && draft.assessedRating === "unknown" ? (
                      <p className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        {UNKNOWN_ASSESSMENT_NOTE}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
            </div>
            {sectionIndex === 1 && attentionCheck ? (
              <StudyAttentionCheckQuestion
                attentionCheck={attentionCheck}
                selectedValue={attentionCheckAnswer}
                submitting={submitting}
                onSelect={onAttentionCheckAnswer}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-center justify-between gap-3">
        <Button variant="outline" disabled={itemIndex === 0 || submitting} onClick={onBack}>Back</Button>
        <Button disabled={!itemComplete || submitting} onClick={onContinue}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isLast ? "Submit answers" : "Next"}
        </Button>
      </div>
    </>
  )
}

function selectedLegacyValue(
  draft: LegacyStudyQuestionnaireDraft,
  field: QuizQuestion["field"],
): string | undefined {
  switch (field) {
    case "desiredContent": return draft.desiredKind
    case "desiredScope": return draft.desiredScope
    case "believedContent": return draft.assessedKind
    case "believedScope": return draft.believedScope
    case "execution": return draft.execution
  }
}

function shouldShowLegacyQuestion(
  draft: LegacyStudyQuestionnaireDraft,
  field: QuizQuestion["field"],
): boolean {
  if (field === "desiredScope") {
    return draft.desiredKind !== undefined && draft.desiredKind !== "not_intended"
  }
  if (field === "believedScope") {
    return draft.assessedKind !== undefined && draft.assessedKind !== "not_remembered"
  }
  return true
}

/** Frozen v1 compatibility surface. It intentionally preserves the old
 * categorical instrument for an unfinished legacy snapshot; it never maps
 * old categories onto the v2 ordinal scale. */
export function StudyLegacyMemoryQuestionnaireSurface({
  item,
  itemIndex,
  itemCount,
  draft,
  attentionCheck = null,
  attentionCheckAnswer = null,
  submitting,
  onField,
  onTextField,
  onAttentionCheckAnswer = () => {},
  onBack,
  onContinue,
}: {
  item: StudyQuestionnaireItem
  itemIndex: number
  itemCount: number
  draft: LegacyStudyQuestionnaireDraft
  attentionCheck?: PublicStudyAttentionCheck | null
  attentionCheckAnswer?: string | null
  submitting: boolean
  onField: (field: QuizQuestion["field"], value: string) => void
  onTextField: (field: "correctedContent" | "believedContentText", value: string) => void
  onAttentionCheckAnswer?: (value: string) => void
  onBack: () => void
  onContinue: () => void
}) {
  const itemComplete = Boolean(buildLegacyStudyQuestionnaireAnswer(draft))
    && (!attentionCheck || Boolean(attentionCheckAnswer))
  const isLast = itemIndex === itemCount - 1
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">Memory {itemIndex + 1} of {itemCount}</h1>
      <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{item.cue}</p>
      </div>
      <div className="mt-6 flex flex-col gap-7">
        {LEGACY_QUIZ_SECTIONS.map((section, sectionIndex) => (
          <div key={section.title} className="contents">
            <div>
            <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
            <div className="mt-3 flex flex-col gap-4">
              {section.questions.map((question) => {
                if (!shouldShowLegacyQuestion(draft, question.field)) return null
                return (
                  <div key={question.field}>
                    <p className="text-sm text-foreground/90">{question.prompt}</p>
                    {question.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{question.hint}</p> : null}
                    <div className="mt-2 flex flex-col gap-1.5">
                      {question.options.map((option) => (
                        <RadioRow
                          key={option.value}
                          label={option.label}
                          selected={selectedLegacyValue(draft, question.field) === option.value}
                          onSelect={() => onField(question.field, option.value)}
                        />
                      ))}
                    </div>
                    {question.field === "desiredContent" && draft.desiredKind === "needs_edit" ? (
                      <label className="mt-3 block text-sm text-foreground/90">
                        What did you want the agent to remember instead?
                        <textarea
                          required
                          rows={4}
                          value={draft.correctedContent ?? ""}
                          disabled={submitting}
                          onChange={(event) => onTextField("correctedContent", event.target.value)}
                          className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-foreground/60"
                        />
                      </label>
                    ) : null}
                    {question.field === "believedContent" && draft.assessedKind === "partial_or_distorted" ? (
                      <label className="mt-3 block text-sm text-foreground/90">
                        What do you believe the agent currently remembers?
                        <textarea
                          required
                          rows={4}
                          value={draft.believedContent ?? ""}
                          disabled={submitting}
                          onChange={(event) => onTextField("believedContentText", event.target.value)}
                          className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-foreground/60"
                        />
                      </label>
                    ) : null}
                  </div>
                )
              })}
            </div>
            </div>
            {sectionIndex === 1 && attentionCheck ? (
              <StudyAttentionCheckQuestion
                attentionCheck={attentionCheck}
                selectedValue={attentionCheckAnswer}
                submitting={submitting}
                onSelect={onAttentionCheckAnswer}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-center justify-between gap-3">
        <Button variant="outline" disabled={itemIndex === 0 || submitting} onClick={onBack}>Back</Button>
        <Button disabled={!itemComplete || submitting} onClick={onContinue}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isLast ? "Submit answers" : "Next"}
        </Button>
      </div>
    </>
  )
}

export function StudyNoFocusedMemorySurface({
  attentionCheck,
  attentionCheckAnswer,
  submitting,
  onAttentionCheckAnswer,
  onSubmit,
}: {
  attentionCheck: PublicStudyAttentionCheck | null
  attentionCheckAnswer: string | null
  submitting: boolean
  onAttentionCheckAnswer: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="mt-8">
      <h1 className="text-2xl font-semibold text-foreground">No focused memory items</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No distinct memory item was focused or injected during this task window, so there
        are no item-level questions to answer. You can still finish this questionnaire.
      </p>
      {attentionCheck ? (
        <div className="mt-6">
          <StudyAttentionCheckQuestion
            attentionCheck={attentionCheck}
            selectedValue={attentionCheckAnswer}
            submitting={submitting}
            onSelect={onAttentionCheckAnswer}
          />
        </div>
      ) : null}
      <Button className="mt-5" disabled={submitting || !attentionCheckAnswer} onClick={onSubmit}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Submit memory answers
      </Button>
    </div>
  )
}

export function RawTlxForm({
  activity,
  draft,
  submitting,
  onChange,
  onSubmit,
}: {
  activity: RawTlxActivity
  draft: RawTlxDraft
  submitting: boolean
  onChange: (dimension: RawTlxDimensionId, rating: number) => void
  onSubmit: () => void
}) {
  const response = buildRawTlxResponse(activity, draft)
  const activityLabel = activity === "monitoring" ? "Monitoring" : "Control"
  const sequenceLabel = activity === "monitoring" ? "1 of 2" : "2 of 2"
  return (
    <div className="mt-8">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workload questions · {sequenceLabel}</div>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">{activityLabel} workload</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{RAW_TLX_ACTIVITY_INSTRUCTIONS[activity]}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Click or move every slider before continuing. A higher number means closer to the label on the right.
      </p>
      <div className="mt-6 flex flex-col gap-4">
        {RAW_TLX_DIMENSIONS.map((dimension) => {
          const rating = draft[dimension.id]
          const answered = rating !== undefined
          return (
            <label key={dimension.id} className="rounded-xl border border-border bg-card px-4 py-4">
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-foreground">{dimension.label}</span>
                <span className={cn("font-mono text-sm", answered ? "text-foreground" : "text-muted-foreground")}>
                  {answered ? rating : "Not answered"}
                </span>
              </span>
              <span className="mt-1 block text-sm text-foreground/85">{dimension.prompt}</span>
              <input
                type="range"
                min={RAW_TLX_RATING_MIN}
                max={RAW_TLX_RATING_MAX}
                step={5}
                value={rating ?? 50}
                disabled={submitting}
                aria-label={dimension.label}
                aria-valuetext={answered ? undefined : "Not answered"}
                data-answered={answered}
                onPointerDown={() => { if (rating === undefined) onChange(dimension.id, 50) }}
                onChange={(event) => onChange(dimension.id, Number(event.target.value))}
                onPointerUp={(event) => onChange(dimension.id, Number(event.currentTarget.value))}
                className={cn(
                  "mt-4 h-4 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed",
                  "[&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted",
                  "[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground",
                  "[&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted",
                  "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground",
                  // The internal 50 only anchors the first pointer interaction.
                  // A fully neutral track plus an invisible thumb prevents that
                  // anchor from looking like a preselected midpoint answer.
                  !answered
                    && "opacity-70 [&::-moz-range-thumb]:opacity-0 [&::-webkit-slider-thumb]:opacity-0",
                )}
              />
              <span className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>{dimension.lowAnchor}</span><span>{dimension.highAnchor}</span>
              </span>
            </label>
          )
        })}
      </div>
      <Button className="mt-6" disabled={!response || submitting} onClick={onSubmit}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {activity === "monitoring" ? "Continue to control workload" : "Submit session workload"}
      </Button>
    </div>
  )
}

const SUS_RATING_LABELS: Record<number, string> = {
  1: "Strongly disagree",
  2: "Disagree",
  3: "Neither agree nor disagree",
  4: "Agree",
  5: "Strongly agree",
}

export function SusForm({
  draft,
  submitting,
  onChange,
  onSubmit,
}: {
  draft: SusDraft
  submitting: boolean
  onChange: (itemId: SusItemId, rating: number) => void
  onSubmit: () => void
}) {
  const response = buildSusResponse(draft)
  const ratings = Array.from({ length: SUS_RATING_MAX - SUS_RATING_MIN + 1 }, (_, index) => SUS_RATING_MIN + index)
  return (
    <div className="mt-8">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Final questions</div>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">System usability</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Think about the system you used throughout this study. Choose one response for every statement.
      </p>
      <div className="mt-6 flex flex-col gap-4">
        {SUS_ITEMS.map((item, index) => (
          <fieldset key={item.id} className="rounded-xl border border-border bg-card px-4 py-4">
            <legend className="px-1 text-sm font-medium leading-relaxed text-foreground">{index + 1}. {item.statement}</legend>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
              {ratings.map((rating) => (
                <button
                  key={rating}
                  type="button"
                  disabled={submitting}
                  aria-pressed={draft[item.id] === rating}
                  onClick={() => onChange(item.id, rating)}
                  className={cn(
                    "rounded-lg border px-2 py-2 text-xs leading-tight transition-colors",
                    draft[item.id] === rating
                      ? "border-foreground/60 bg-muted text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <span className="block font-mono text-sm text-foreground">{rating}</span>
                  {SUS_RATING_LABELS[rating]}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <Button className="mt-6" disabled={!response || submitting} onClick={onSubmit}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Submit final questions
      </Button>
    </div>
  )
}

export function StudyNextSessionSurface({ onContinue, disabled = false }: { onContinue: () => void; disabled?: boolean }) {
  return (
    <div className="mt-8 flex flex-col items-start gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-5 w-5 text-emerald-600" />
      </span>
      <h1 className="text-2xl font-semibold text-foreground">Session complete</h1>
      <p className="text-sm text-muted-foreground">Your answers are recorded. Continue to the next session when you are ready.</p>
      <Button className="mt-2 gap-1.5" disabled={disabled} onClick={onContinue}>
        Continue to next session <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

export function StudyCompleteSurface({
  completionCode,
  completionUrl = null,
}: {
  completionCode: string | null
  completionUrl?: string | null
}) {
  // The code value is server-owned: it arrives only in the production
  // post-session payload after the final SUS is durably accepted. The Guide
  // preview passes null and therefore never renders a usable code.
  return (
    <div className="mt-8 flex flex-col items-start gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-5 w-5 text-emerald-600" />
      </span>
      <h1 className="text-2xl font-semibold text-foreground">{STUDY_COMPLETION_TITLE}</h1>
      {completionCode ? (
        <div className="w-full rounded-xl border border-border bg-card px-4 py-3" data-completion-code={completionCode}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {STUDY_COMPLETION_CODE_LABEL}
          </p>
          <p className="mt-1 select-all font-mono text-xl font-semibold tracking-widest text-foreground">
            {completionCode}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{STUDY_COMPLETION_CODE_INSTRUCTION}</p>
        </div>
      ) : null}
      {completionUrl ? (
        <a
          href={completionUrl}
          rel="noreferrer"
          className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Return to Prolific <ArrowRight className="h-4 w-4" />
        </a>
      ) : null}
      <p className="text-sm text-muted-foreground">{STUDY_COMPLETION_MESSAGE}</p>
    </div>
  )
}
