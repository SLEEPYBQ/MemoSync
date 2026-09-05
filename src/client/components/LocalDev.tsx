import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  ArrowLeftRight,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CodeXml,
  Copy,
  Folder,
  Inbox,
  Loader2,
  Monitor,
  Plus,
  Terminal,
} from "lucide-react"
import { DISPLAY_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { LocalProjectsSnapshot } from "../../shared/types"
import type { SocketStatus } from "../app/socket"
import type { AppState } from "../app/useAppState"
import { PageHeader } from "../app/PageHeader"
import { getPathBasename } from "../lib/formatters"
import { landingHeadline, resolveLandingProjectPath, summarizeMemoriesForLanding } from "../lib/landing"
import { MEMORY_SCOPE_TEXT_CLASSES } from "../lib/memoryCitations"
import { memoriesApi } from "../lib/memoriesApi"
import { useConditionPolicy, type ConditionPolicy } from "../lib/conditionApi"
import { useMemoryStore } from "../stores/memoryStore"
import { BrandIcon } from "./BrandMark"
import { ChatInput } from "./chat-ui/ChatInput"
import { InputPopover, PopoverMenuItem } from "./chat-ui/ChatPreferenceControls"
import { NewProjectModal } from "./NewProjectModal"
import { Button } from "./ui/button"

interface LocalDevProps {
  connectionStatus: SocketStatus
  ready: boolean
  snapshot: LocalProjectsSnapshot | null
  commandError: string | null
  newProjectOpen: boolean
  onNewProjectOpenChange: (open: boolean) => void
  onCreateProject: (project: { mode: "new" | "existing"; localPath: string; title: string }) => Promise<void>
  onSend: AppState["handleSend"]
  availableProviders: AppState["availableProviders"]
  /** localPath → projectId for projects the server already knows (enables attachment uploads pre-send). */
  projectIdByPath: Record<string, string>
}

export function LandingProjectMenu({
  projectPaths,
  selectedPath,
  onPickPath,
  onAddProject,
}: {
  projectPaths: string[]
  selectedPath: string | null
  onPickPath: (path: string) => void
  onAddProject: () => void
}) {
  return (
    <>
      {projectPaths.map((path) => (
        <PopoverMenuItem
          key={path}
          selected={path === selectedPath}
          icon={<Folder className="h-4 w-4 text-muted-foreground" />}
          label={getPathBasename(path)}
          description={path}
          onClick={() => onPickPath(path)}
        />
      ))}
      <PopoverMenuItem
        selected={false}
        icon={<Plus className="h-4 w-4 text-muted-foreground" />}
        label="Add project…"
        onClick={onAddProject}
      />
    </>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
      onClick={() => void handleCopy()}
    >
      {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center group bg-background border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm">
      <pre className="inline-flex items-center gap-2 overflow-x-auto">
        <ChevronRight className="inline h-4 w-4 opacity-40" />
        <code>{children}</code>
      </pre>
      <CopyButton text={children} />
    </div>
  )
}

function InfoCard({ children }: { children: ReactNode }) {
  return <div className="bg-card border border-border rounded-2xl p-4">{children}</div>
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
      {children}
    </h2>
  )
}

function HowItWorksItem({
  icon: Icon,
  title,
  subtitle,
  iconClassName,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle: string
  iconClassName?: string
}) {
  return (
    <div className="flex flex-col items-center gap-0">
      <div className="p-3 mb-2 rounded-xl bg-background border border-border">
        <Icon className={iconClassName || "h-8 w-8 text-muted-foreground"} />
      </div>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </div>
  )
}

function HowItWorksConnector() {
  return <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
}

function Step({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-3">
          <div className="flex-shrink-0 flex items-center justify-center font-medium text-logo">{number}.</div>
          <h3 className="font-medium text-foreground mb-2">{title}</h3>
        </div>
        <div className="text-muted-foreground text-sm space-y-3">{children}</div>
      </div>
    </div>
  )
}

// Landing counts come from the shared memory store plus one needs-attention
// probe per visit — the same sources the sidebar badge polls.
function useLandingMemorySummary(enabled: boolean) {
  const items = useMemoryStore((s) => s.items)
  const status = useMemoryStore((s) => s.status)
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [attentionCount, setAttentionCount] = useState(0)

  useEffect(() => {
    if (!enabled) return
    if (status === "idle") void loadAll()
    let disposed = false
    const probe = () => {
      void memoriesApi
        .needsAttention()
        .then((attention) => {
          if (!disposed) setAttentionCount(attention.items.length)
        })
        .catch(() => {
          // keep the last count — a missed probe must not blank the card
        })
    }
    probe()
    // Poll like the sidebar badge (60s) so a conflict raised while the user
    // lingers on the landing surfaces here too, instead of a stale green check
    // that contradicts the sidebar red dot (BUG LAND-4).
    const interval = window.setInterval(() => {
      if (!document.hidden) probe()
    }, 60_000)
    const onFocus = () => probe()
    window.addEventListener("focus", onFocus)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener("focus", onFocus)
    }
  }, [enabled, status, loadAll])

  const summary = useMemo(() => summarizeMemoriesForLanding(items), [items])
  return { summary, attentionCount }
}

function CardBadge({ count, countTitle }: { count: number; countTitle: string }) {
  if (count > 0) {
    return (
      <span
        title={countTitle}
        className="absolute right-3 top-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-medium leading-none text-white"
      >
        {count}
      </span>
    )
  }
  return (
    <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500">
      <Check className="h-3 w-3 text-white" />
    </span>
  )
}

function FeatureCard({
  icon: Icon,
  title,
  description,
  badge,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  description: ReactNode
  badge?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex w-full flex-col items-start gap-1.5 rounded-2xl border border-border bg-card p-4 pr-10 text-left shadow-sm transition-colors hover:border-primary/30 hover:bg-muted/50 sm:w-[240px]"
    >
      {badge}
      <Icon className="mb-1 h-5 w-5 text-muted-foreground" />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs leading-5 text-muted-foreground">{description}</span>
    </button>
  )
}

export function LocalDev(props: LocalDevProps) {
  const conditionPolicy = useConditionPolicy()
  return <LocalDevContent {...props} conditionPolicy={conditionPolicy} />
}

export function LocalDevContent({
  connectionStatus,
  ready,
  snapshot,
  commandError,
  newProjectOpen,
  onNewProjectOpenChange,
  onCreateProject,
  onSend,
  availableProviders,
  projectIdByPath,
  conditionPolicy,
}: LocalDevProps & { conditionPolicy: ConditionPolicy }) {
  const navigate = useNavigate()
  // Baseline arms strip the landing down to the hero + composer: no feature
  // cards ("Add a project" stays reachable from the composer's project picker
  // and the sidebar), and the hero centers in the freed space.
  const studyNeutral = conditionPolicy.condition !== "memosync"
  const projects = useMemo(() => snapshot?.projects ?? [], [snapshot?.projects])
  const projectPaths = useMemo(() => projects.map((project) => project.localPath), [projects])
  const isConnecting = connectionStatus === "connecting" || !ready
  const isConnected = connectionStatus === "connected" && ready

  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [openingAssignment, setOpeningAssignment] = useState(false)
  const [assignmentError, setAssignmentError] = useState<string | null>(null)
  const selectedPath = resolveLandingProjectPath(projectPaths, pickedPath)
  const selectedName = selectedPath ? getPathBasename(selectedPath) : null
  const machineName = snapshot?.machine.displayName ?? "this machine"

  const { summary, attentionCount } = useLandingMemorySummary(isConnected && conditionPolicy.boardVisible)
  const showCandidatesCard = conditionPolicy.boardVisible && conditionPolicy.capture === "review"

  const composerElementRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (isConnected && selectedPath) composerElementRef.current?.focus()
  }, [isConnected, selectedPath])

  async function openActiveStudyAssignment() {
    if (openingAssignment) return
    setOpeningAssignment(true)
    setAssignmentError(null)
    try {
      const response = await fetch("/api/study/progress", { cache: "no-store" })
      if (!response.ok) throw new Error(`request failed (${response.status})`)
      const payload = (await response.json()) as { data?: { activeTaskId?: string | null } }
      const activeTaskId = payload.data?.activeTaskId
      if (!activeTaskId) throw new Error("no active assignment")
      navigate(`/study/${encodeURIComponent(activeTaskId)}`)
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : "could not open assignment")
    } finally {
      setOpeningAssignment(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">
      {!isConnected ? (
        <>
          <PageHeader
            narrow
            icon={CodeXml}
            title={isConnecting ? `Connecting ${DISPLAY_NAME}` : `Connect ${DISPLAY_NAME}`}
            subtitle={isConnecting
              ? `${DISPLAY_NAME} is starting up and loading your local projects.`
              : `Run ${DISPLAY_NAME} directly on your machine with full access to your local files and agent project history.`}
          />
          <div className="max-w-2xl w-full mx-auto pb-12 px-6">
            <SectionHeader>Status</SectionHeader>
            <div className="mb-8">
              <InfoCard>
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                  <span className="text-sm text-muted-foreground">
                    {isConnecting ? (
                      `Connecting to your local ${DISPLAY_NAME} server...`
                    ) : (
                      <>
                        Not connected. Run <code className="bg-background border border-border rounded-md mx-0.5 p-1 font-mono text-xs text-foreground">{getCliInvocation()}</code> from any terminal on this machine.
                      </>
                    )}
                  </span>
                </div>
              </InfoCard>
            </div>

            {!isConnecting ? (
              <div className="mb-10">
              <SectionHeader>How it works</SectionHeader>
              <InfoCard>
                <div className="flex items-center justify-around gap-6 py-4 px-2">
                  <HowItWorksItem icon={Terminal} title={`${DISPLAY_NAME} CLI`} subtitle="On Your Machine" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={Monitor} title={`${DISPLAY_NAME} Server`} subtitle="Local WebSocket" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={CodeXml} title={`${DISPLAY_NAME} UI`} subtitle="Project Chat" />
                </div>
              </InfoCard>
              </div>
            ) : null}

            {!isConnecting ? (
              <div className="mb-10">
              <SectionHeader>Setup</SectionHeader>
              <InfoCard>
                <div className="space-y-4">
                  <Step number={1} title={`Start ${DISPLAY_NAME}`}>
                    <p>Run this command in your terminal:</p>
                    <CodeBlock>{getCliInvocation()}</CodeBlock>
                  </Step>

                  <Step number={2} title="Open the local UI">
                    <p>{DISPLAY_NAME} serves the app locally and opens the Local Projects page in an app-style browser window.</p>
                    <CodeBlock>http://localhost:3210/local</CodeBlock>
                  </Step>

                  <div className="mt-8">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Notes</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("").trim()}</code>
                        <span className="text-muted-foreground">Start in the current directory</span>
                      </div>
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("--no-open")}</code>
                        <span className="text-muted-foreground">Start the server without opening the browser</span>
                      </div>
                    </div>
                  </div>
                </div>
              </InfoCard>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div
          className={
            studyNeutral
              ? "flex flex-1 flex-col items-center justify-center px-4 pb-12 sm:px-6"
              : "flex flex-1 flex-col items-center justify-start px-4 pb-12 pt-[12vh] sm:px-6 sm:pt-[16vh]"
          }
        >
          <div className="flex w-full max-w-3xl flex-col items-center">
            <BrandIcon animated="loop" className="mb-5 size-14" />
            <h1 className="mb-8 text-balance text-center text-3xl font-medium tracking-tight text-foreground sm:text-[34px] sm:leading-tight">
              {landingHeadline(selectedName)}
            </h1>

            <div className="w-full">
              {conditionPolicy.studyMode ? (
                <div className="rounded-2xl border border-border bg-card px-5 py-4 text-center text-sm text-muted-foreground">
                  <p>Open the active task assignment to begin. The assigned project and starter are managed by the study.</p>
                  <Button
                    className="mt-3"
                    disabled={openingAssignment}
                    onClick={() => void openActiveStudyAssignment()}
                  >
                    {openingAssignment ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Open current assignment
                  </Button>
                  {assignmentError ? <p className="mt-2 text-xs text-destructive">Could not open the assignment: {assignmentError}</p> : null}
                </div>
              ) : (
              <ChatInput
                key="landing"
                onSubmit={(value, options) => {
                  if (!selectedPath) return Promise.reject(new Error("Open a project first"))
                  return onSend(value, { ...options, projectLocalPath: selectedPath })
                }}
                disabled={!selectedPath}
                chatId={null}
                draftKey="landing"
                projectId={selectedPath ? projectIdByPath[selectedPath] ?? null : null}
                inputElementRef={composerElementRef}
                activeProvider={null}
                availableProviders={availableProviders}
                leadingControls={
                  <>
                    <InputPopover
                      trigger={
                        <>
                          <Folder className="h-3.5 w-3.5" />
                          <span>{selectedName ?? "No project yet"}</span>
                          <ChevronDown className="h-3 w-3 opacity-60" />
                        </>
                      }
                    >
                      {(close) => (
                        <LandingProjectMenu
                          projectPaths={projectPaths}
                          selectedPath={selectedPath}
                          onPickPath={(path) => {
                            setPickedPath(path)
                            close()
                          }}
                          onAddProject={() => {
                            close()
                            onNewProjectOpenChange(true)
                          }}
                        />
                      )}
                    </InputPopover>
                    <span className="flex items-center gap-1.5 whitespace-nowrap px-2 py-1 text-sm text-muted-foreground/70">
                      <Monitor className="h-3.5 w-3.5 shrink-0" />
                      <span>{machineName}</span>
                    </span>
                  </>
                }
              />
              )}
            </div>

            {commandError ? (
              <div className="mt-4 w-full max-w-[840px] rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {commandError}
              </div>
            ) : null}

            {studyNeutral || conditionPolicy.studyMode ? null : (
            <div className="mt-12 flex w-full flex-wrap justify-center gap-3">
              {conditionPolicy.boardVisible ? (
                <FeatureCard
                  icon={BrainCircuit}
                  title="Memory Board"
                  description={
                    <>
                      {summary.active} active —{" "}
                      <span className={MEMORY_SCOPE_TEXT_CLASSES.personal}>{summary.byScope.personal} personal</span>
                      {" · "}
                      <span className={MEMORY_SCOPE_TEXT_CLASSES.project}>{summary.byScope.project} project</span>
                      {" · "}
                      <span className={MEMORY_SCOPE_TEXT_CLASSES.session}>{summary.byScope.session} session</span>
                    </>
                  }
                  badge={<CardBadge count={attentionCount} countTitle={`${attentionCount} ${attentionCount === 1 ? "memory needs" : "memories need"} attention`} />}
                  onClick={() => navigate("/memory")}
                />
              ) : null}
              {showCandidatesCard ? (
                <FeatureCard
                  icon={Inbox}
                  title="Review candidates"
                  description={
                    summary.candidates > 0
                      ? `${summary.candidates} proposed ${summary.candidates === 1 ? "memory is" : "memories are"} waiting for your decision`
                      : "Proposed memories wait here for review before they become active"
                  }
                  badge={<CardBadge count={summary.candidates} countTitle={`${summary.candidates} to review`} />}
                  onClick={() => navigate("/memory?focus=candidates")}
                />
              ) : null}
              <FeatureCard
                icon={Plus}
                title="Add a project"
                description={`Create or open a folder on ${machineName}`}
                onClick={() => onNewProjectOpenChange(true)}
              />
            </div>
            )}
          </div>
        </div>
      )}

      {!conditionPolicy.studyMode ? <NewProjectModal
        open={newProjectOpen}
        onOpenChange={onNewProjectOpenChange}
        onConfirm={(project) => {
          void onCreateProject(project)
        }}
      /> : null}

      <div className="py-4 text-center">
        <span className="text-xs text-muted-foreground/50">v{SDK_CLIENT_APP.split("/")[1]}</span>
      </div>
    </div>
  )
}
