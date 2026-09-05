import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, Eye, Flag, Loader2, LockKeyhole, Wrench } from "lucide-react"
import { Navigate, useNavigate } from "react-router-dom"
import {
  STUDY_AGENT_MEMORY_EXPERIENCE,
  STUDY_AGENT_TOOLS,
  STUDY_AGENT_USE_FREQUENCIES,
  STUDY_ONBOARDING_GENDERS,
  type StudyAgentTool,
  type StudyAgentUseFrequency,
} from "../../../../shared/studyOnboarding"
import { useConditionPolicyLoadFailed, useConditionPolicyResolved } from "../../../lib/conditionApi"
import {
  loadStudyOnboarding,
  saveStudyBriefing,
  saveStudyConsent,
  saveStudyInformation,
  type StudyOnboardingInformation,
  type StudyOnboardingState,
} from "./onboardingApi"
import { recordStudyStageEntered } from "../studyTelemetry"

const EXPERIENCE_OPTIONS = STUDY_AGENT_MEMORY_EXPERIENCE
const GENDER_OPTIONS = STUDY_ONBOARDING_GENDERS
const AGENT_FREQUENCY_OPTIONS = STUDY_AGENT_USE_FREQUENCIES
const AGENT_TOOL_OPTIONS = STUDY_AGENT_TOOLS

const EMPTY_INFORMATION: StudyOnboardingInformation = {
  prolificId: "",
  age: Number.NaN,
  gender: "" as StudyOnboardingInformation["gender"],
  agentMemoryExperience: "" as StudyOnboardingInformation["agentMemoryExperience"],
  agentUseFrequency: "" as StudyOnboardingInformation["agentUseFrequency"],
  agentTools: [],
}

function copyInformation(value: StudyOnboardingInformation | null, prolificId: string | null): StudyOnboardingInformation {
  return value
    ? { ...value, prolificId: prolificId ?? value.prolificId, agentTools: [...value.agentTools] }
    : { ...EMPTY_INFORMATION, prolificId: prolificId ?? "", agentTools: [] }
}

function isInformationReady(value: StudyOnboardingInformation): boolean {
  const toolsAreConsistent = value.agentUseFrequency === "Never"
    ? value.agentTools.length === 1 && value.agentTools[0] === "None"
    : !value.agentTools.includes("None")
  return value.prolificId.trim().length > 0
    && Number.isInteger(value.age)
    && value.age >= 18
    && value.age <= 120
    && Boolean(value.gender)
    && Boolean(value.agentMemoryExperience)
    && Boolean(value.agentUseFrequency)
    && value.agentTools.length > 0
    && toolsAreConsistent
}

function studyShell(children: ReactNode, maxWidth = "max-w-[860px]") {
  return (
    <main className="fixed inset-0 z-[60] overflow-y-auto bg-background px-5 py-5 sm:px-9 sm:py-9">
      <div className={`mx-auto flex min-h-full w-full ${maxWidth} items-center justify-center`}>
        {children}
      </div>
    </main>
  )
}

function StudyMark({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-slate-600">
      <span className="text-slate-400">{icon}</span>{children}
    </div>
  )
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`w-full rounded-[12px] border border-slate-200 bg-white px-5 py-7 shadow-[0_1px_1px_rgb(15_23_42/0.02)] sm:px-10 sm:py-8 ${className}`}>
      <div className="mb-7 h-[3px] w-10 rounded-full bg-rose-400" />
      {children}
    </section>
  )
}

function PageTitle({ children, description }: { children: ReactNode; description: ReactNode }) {
  return <><h1 className="text-[25px] font-semibold tracking-[-0.02em] text-slate-800 sm:text-[26px]">{children}</h1><p className="mt-2 text-[15px] leading-6 text-slate-500">{description}</p></>
}

function SelectInput<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | ""
  options: readonly T[]
  onChange: (value: T) => void
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-semibold text-slate-700">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-12 w-full rounded-[9px] border border-slate-200 bg-white px-3 text-[15px] text-slate-700 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200/60 disabled:cursor-not-allowed disabled:bg-slate-50"
      >
        <option value="" disabled>Select one</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

function AgentToolField({ value, frequency, onChange }: {
  value: StudyAgentTool[]
  frequency: StudyAgentUseFrequency | ""
  onChange: (next: StudyAgentTool[]) => void
}) {
  const toggle = (tool: StudyAgentTool) => {
    const disabled = !frequency || (frequency === "Never" ? tool !== "None" : tool === "None")
    if (disabled) return
    if (tool === "None") {
      onChange(["None"])
      return
    }
    const next = value.includes(tool) ? value.filter((entry) => entry !== tool) : [...value.filter((entry) => entry !== "None"), tool]
    onChange(next)
  }
  return (
    <fieldset className="mt-6">
      <legend className="text-[13px] font-semibold text-slate-700">Which AI agent tools have you used? <span className="font-normal text-slate-500">Select all that apply</span></legend>
      <p className="mt-1 text-xs text-slate-500">Select your overall usage frequency first.</p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {AGENT_TOOL_OPTIONS.map((tool) => {
          const checked = value.includes(tool)
          const disabled = !frequency || (frequency === "Never" ? tool !== "None" : tool === "None")
          return (
            <label key={tool} className={`flex min-h-12 items-center gap-3 rounded-[9px] border px-3 text-[13px] font-medium transition ${disabled ? "cursor-not-allowed border-slate-100 text-slate-400" : checked ? "cursor-pointer border-slate-400 bg-slate-50 text-slate-800" : "cursor-pointer border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"}`}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(tool)} className="h-4 w-4 accent-slate-600" />
              {tool}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function InformationPage({ information, prolificId, saving, error, onSave }: {
  information: StudyOnboardingInformation | null
  prolificId: string | null
  saving: boolean
  error: string | null
  onSave: (information: StudyOnboardingInformation) => void
}) {
  const [form, setForm] = useState(() => copyInformation(information, prolificId))
  useEffect(() => setForm(copyInformation(information, prolificId)), [information, prolificId])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isInformationReady(form) && !saving) onSave({ ...form, prolificId: form.prolificId.trim() })
  }
  const setFrequency = (agentUseFrequency: StudyAgentUseFrequency) => setForm((current) => ({
    ...current,
    agentUseFrequency,
    agentTools: agentUseFrequency === "Never" ? ["None"] : current.agentTools.filter((tool) => tool !== "None"),
  }))

  return studyShell(
    <Panel>
      <StudyMark icon={<Bot className="h-[18px] w-[18px]" />}>Coding Agent Study</StudyMark>
      <PageTitle description="Please provide the information below before beginning the study.">Participant information</PageTitle>
      <form className="mt-8" onSubmit={submit}>
        <label className="block">
          <span className="mb-2 block text-[13px] font-semibold text-slate-700">Prolific ID</span>
          <input aria-label="Prolific ID" value={form.prolificId} readOnly={prolificId !== null} autoComplete="off" placeholder="Enter your Prolific ID" onChange={(event) => setForm((current) => ({ ...current, prolificId: event.target.value }))} className="h-12 w-full rounded-[9px] border border-slate-200 px-3 text-[15px] text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-200/60 read-only:bg-slate-50 read-only:text-slate-500" />
          {prolificId ? <span className="mt-1.5 block text-xs text-slate-500">Recorded automatically from your verified Prolific link.</span> : null}
        </label>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-[13px] font-semibold text-slate-700">Age</span>
            <input aria-label="Age" type="number" min="18" max="120" inputMode="numeric" value={Number.isFinite(form.age) ? form.age : ""} placeholder="Enter your age" onChange={(event) => setForm((current) => ({ ...current, age: event.target.value === "" ? Number.NaN : Number(event.target.value) }))} className="h-12 w-full rounded-[9px] border border-slate-200 px-3 text-[15px] text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-200/60" />
          </label>
          <SelectInput label="Gender" value={form.gender} options={GENDER_OPTIONS} onChange={(gender) => setForm((current) => ({ ...current, gender }))} />
        </div>
        <div className="mt-6"><SelectInput label="Experience using Agent Memory" value={form.agentMemoryExperience} options={EXPERIENCE_OPTIONS} onChange={(agentMemoryExperience) => setForm((current) => ({ ...current, agentMemoryExperience }))} /></div>
        <div className="mt-6"><SelectInput label="Overall frequency of using AI agent tools" value={form.agentUseFrequency} options={AGENT_FREQUENCY_OPTIONS} onChange={setFrequency} /></div>
        <AgentToolField frequency={form.agentUseFrequency} value={form.agentTools} onChange={(agentTools) => setForm((current) => ({ ...current, agentTools }))} />
        {error ? <p role="alert" className="mt-5 text-sm text-destructive">{error}</p> : null}
        <button type="submit" disabled={!isInformationReady(form) || saving} className="mt-8 inline-flex h-11 w-full items-center justify-center gap-2 rounded-[9px] bg-slate-600 px-4 text-[15px] font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "Continue"}<ArrowRight className="h-4 w-4" />
        </button>
      </form>
    </Panel>,
  )
}

function ConsentPage({ saving, error, onBack, onSave }: { saving: boolean; error: string | null; onBack: () => void; onSave: () => void }) {
  const [accepted, setAccepted] = useState(false)
  return studyShell(
    <Panel className="max-w-[860px]">
      <StudyMark icon={<LockKeyhole className="h-[18px] w-[18px]" />}>Consent</StudyMark>
      <PageTitle description="You will work with a coding agent across four assigned sessions and report how you inspect and manage its memory.">Before you begin</PageTitle>
      <div className="mt-7 divide-y divide-slate-200 border-y border-slate-200">
        <p className="py-4 text-[14px] leading-6 text-slate-600"><strong className="font-semibold text-slate-800">What you will do.</strong> Work with the coding agent on assigned projects, inspect and manage the memory interface available in your condition, and complete the end-of-session questionnaires.</p>
        <p className="py-4 text-[14px] leading-6 text-slate-600"><strong className="font-semibold text-slate-800">What we record.</strong> Your participant information, prompts, memory interactions, clicks, scrolling, timing, workspace activity, and questionnaire responses.</p>
        <p className="py-4 text-[14px] leading-6 text-slate-600"><strong className="font-semibold text-slate-800">Data handling.</strong> Your responses are stored on the study server using your Prolific ID. We do not ask for your name.</p>
        <p className="py-4 text-[14px] leading-6 text-slate-600"><strong className="font-semibold text-slate-800">Voluntary participation.</strong> You may stop at any time by closing this page.</p>
      </div>
      <label className="mt-6 flex cursor-pointer items-start gap-3 text-[14px] leading-6 text-slate-700"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-slate-600" />I have read the information above and consent to participate.</label>
      {error ? <p role="alert" className="mt-5 text-sm text-destructive">{error}</p> : null}
      <div className="mt-7 flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-[9px] border border-slate-200 px-4 text-[14px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed"><ArrowLeft className="h-4 w-4" />Back</button>
        <button type="button" disabled={!accepted || saving} onClick={onSave} className="inline-flex h-10 items-center gap-2 rounded-[9px] bg-slate-600 px-4 text-[14px] font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "I agree and continue"}</button>
      </div>
    </Panel>,
  )
}

function BriefingPage({ saving, error, onSave }: { saving: boolean; error: string | null; onSave: () => void }) {
  const steps = [
    { icon: <Wrench className="h-5 w-5" />, title: "Open the assigned project", text: "Read each assignment and work only in its provided project workspace." },
    { icon: <Eye className="h-5 w-5" />, title: "Inspect and manage agent memory", text: "Use the memory surface in this study condition to understand and, where available, change what guides the agent." },
    { icon: <Flag className="h-5 w-5" />, title: "Finish the session and submit", text: "Use Finish this session when you are done, then complete the memory questionnaire and both workload questionnaires." },
  ]
  return studyShell(
    <Panel>
      <StudyMark icon={<Eye className="h-[18px] w-[18px]" />}>Study briefing</StudyMark>
      <PageTitle description="You will collaborate with a coding agent on assigned projects. Your role is to use the system normally and report how the agent's memory supports your work.">Work with a coding agent across each assigned task</PageTitle>
      <div className="mt-7 grid border-y border-slate-200 sm:grid-cols-3 sm:divide-x sm:divide-slate-200">
        {steps.map((step, index) => <article key={step.title} className="relative border-b border-slate-200 px-5 py-6 last:border-b-0 sm:border-b-0 sm:first:pl-0 sm:last:pr-0">
          <span className="absolute left-5 top-6 inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-500 text-[11px] font-bold text-white sm:left-0">{index + 1}</span>
          <div className="ml-8 text-slate-400">{step.icon}</div>
          <h2 className="mt-4 text-[15px] font-semibold text-slate-800">{step.title}</h2>
          <p className="mt-2 text-[13px] leading-5 text-slate-500">{step.text}</p>
        </article>)}
      </div>
      <div className="mt-7 flex items-start gap-3 rounded-[9px] border border-amber-200 bg-amber-50/50 px-4 py-3 text-[13px] leading-5 text-amber-950"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />The guide will show the actual interface before you begin. Complete the guide to unlock your first assigned session.</div>
      {error ? <p role="alert" className="mt-5 text-sm text-destructive">{error}</p> : null}
      <button type="button" disabled={saving} onClick={onSave} className="mt-7 inline-flex h-11 items-center gap-2 rounded-[9px] bg-slate-600 px-4 text-[15px] font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Opening guide…" : "Open guide"}<ArrowRight className="h-4 w-4" /></button>
    </Panel>,
    "max-w-[1040px]",
  )
}

export function StudyOnboardingPage({ initialState }: { initialState?: StudyOnboardingState } = {}) {
  const navigate = useNavigate()
  const [state, setState] = useState<StudyOnboardingState | null>(initialState ?? null)
  const [loading, setLoading] = useState(initialState === undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialState !== undefined) return
    void loadStudyOnboarding().then(setState).catch(() => setError("Could not load your onboarding progress. Please retry or ask the experimenter for help.")).finally(() => setLoading(false))
  }, [initialState])

  useEffect(() => {
    if (state?.stage === "information") void recordStudyStageEntered("information")
  }, [state?.stage])

  const save = (operation: () => Promise<StudyOnboardingState>, goToGuide = false) => {
    if (saving) return
    setSaving(true)
    setError(null)
    void operation().then((next) => {
      setState(next)
      if (goToGuide && next.stage === "complete") navigate("/guide", { replace: true })
    }).catch(() => setError("Could not save this step. Your progress has not advanced. Please retry or ask the experimenter for help.")).finally(() => setSaving(false))
  }

  if (loading) return studyShell(<div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading participant information…</div>)
  if (state === null) return studyShell(<Panel><StudyMark icon={<Bot className="h-[18px] w-[18px]" />}>Coding Agent Study</StudyMark><PageTitle description="We could not load your saved onboarding progress.">Unable to load onboarding</PageTitle><p role="alert" className="mt-6 text-sm text-destructive">{error}</p><button type="button" onClick={() => window.location.reload()} className="mt-6 inline-flex h-10 items-center rounded-[9px] bg-slate-600 px-4 text-sm font-semibold text-white">Retry</button></Panel>)
  if (state.stage === "consent") return <ConsentPage saving={saving} error={error} onBack={() => setState({ ...state, stage: "information" })} onSave={() => save(() => saveStudyConsent())} />
  if (state.stage === "briefing") return <BriefingPage saving={saving} error={error} onSave={() => save(() => saveStudyBriefing(), true)} />
  if (state.stage === "complete") {
    return studyShell(<Panel><StudyMark icon={<Bot className="h-[18px] w-[18px]" />}>Coding Agent Study</StudyMark><PageTitle description="Your onboarding is complete.">Opening the guide</PageTitle><button type="button" onClick={() => navigate("/guide", { replace: true })} className="mt-6 inline-flex h-10 items-center gap-2 rounded-[9px] bg-slate-600 px-4 text-sm font-semibold text-white">Open guide <ArrowRight className="h-4 w-4" /></button></Panel>)
  }
  return <InformationPage information={state.information} prolificId={state.prolificId ?? null} saving={saving} error={error} onSave={(information) => save(() => saveStudyInformation(information))} />
}

/**
 * A top-level authenticated route rather than an AppLayout child. This keeps
 * the workspace, sidebar, dock, and Board out of both the visual tree and
 * the accessibility tree until the participant has finished onboarding.
 */
export function StudyOnboardingRoute() {
  const policy = useConditionPolicyResolved()
  const failed = useConditionPolicyLoadFailed()
  if (policy === null) {
    return studyShell(
      failed
        ? <Panel><StudyMark icon={<Bot className="h-[18px] w-[18px]" />}>Coding Agent Study</StudyMark><PageTitle description="No study interface has been shown.">Could not load the study condition</PageTitle><button type="button" onClick={() => window.location.reload()} className="mt-6 inline-flex h-10 items-center rounded-[9px] bg-slate-600 px-4 text-sm font-semibold text-white">Retry</button></Panel>
        : <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading study onboarding…</div>,
    )
  }
  if (!policy.studyMode) return <Navigate to="/" replace />
  return <StudyOnboardingPage />
}
