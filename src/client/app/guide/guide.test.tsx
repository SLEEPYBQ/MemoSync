import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { STUDY_GUIDE_VERSION } from "../../../shared/studyTasks"
import {
  canSkipGuide,
  completeStudyGuide,
  fetchStudyGuideStatus,
  hasSeenGuide,
  shouldAutoShowGuide,
} from "../../lib/guideState"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { browserPreviewFrameAttributes } from "../../components/chat-ui/BrowserPanel"
import { MemoryProposalsGate } from "../../components/messages/MemoryProposalsGate"
import { buildCandidateActivationScopePatch } from "../../components/messages/MemoryCandidatesMessage"
import { useTranscriptChatContext } from "../../components/messages/render-context"
import { buildResolvedTranscriptRows } from "../ChatTranscript"
import { GUIDE_BROWSER_DEMO_DOCUMENT } from "./guideDemoWorkspace"
import { TOUR_ANCHORS } from "./guideScenes"
import {
  GUIDE_CHAPTERS,
  GuideChapterHeading,
  GuidePrimaryButton,
  GuideSectionTabs,
  GuideTranscriptContextProvider,
  withResumeDecision,
} from "./GuideTour"
import { buildAutoSteps, buildMemoSyncSteps, buildStaticSteps } from "./tourSteps"

describe("guide auto-show", () => {
  test("auto-shows only in study mode and only before dismissal", () => {
    expect(shouldAutoShowGuide({ studyMode: true }, false)).toBe(true)
    expect(shouldAutoShowGuide({ studyMode: true }, true)).toBe(false)
    expect(shouldAutoShowGuide({ studyMode: false }, false)).toBe(false)
    expect(shouldAutoShowGuide(null, false)).toBe(false)
  })

  test("storage failures fail closed (guide may reshow, never crashes)", () => {
    expect(
      hasSeenGuide({
        getItem: () => {
          throw new Error("blocked")
        },
      })
    ).toBe(true)
  })

  test("does not let study participants bypass the required guide", () => {
    expect(canSkipGuide({ studyMode: true })).toBe(false)
    expect(canSkipGuide({ studyMode: false })).toBe(true)
  })

  test("uses server-side guide completion in study mode", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" })
      return Response.json({ data: { version: STUDY_GUIDE_VERSION, completed: init?.method === "POST" } })
    }
    expect(await fetchStudyGuideStatus(fetcher)).toEqual({ version: STUDY_GUIDE_VERSION, completed: false })
    expect(await completeStudyGuide(fetcher)).toEqual({ version: STUDY_GUIDE_VERSION, completed: true })
    expect(calls).toEqual([
      { url: "/api/study/guide-status", method: "GET" },
      { url: "/api/study/guide-complete", method: "POST" },
    ])
  })
})

function GuideProjectCandidateActivationProbe() {
  const { chatId, projectId } = useTranscriptChatContext()
  const activation = buildCandidateActivationScopePatch({
    scope: "project",
    contextProjectId: projectId,
    contextChatId: chatId,
  })
  return <span>{"error" in activation ? activation.error : activation.patch.projectId}</span>
}

describe("Guide Candidate project context", () => {
  test("accepts the Project-scoped Step 1 candidate in the demo project", () => {
    const html = renderToStaticMarkup(
      <GuideTranscriptContextProvider>
        <GuideProjectCandidateActivationProbe />
      </GuideTranscriptContextProvider>,
    )

    expect(html).toContain("guide-demo-shop")
    expect(html).not.toContain("Choose a project before accepting this memory.")
  })
})

describe("Guide optional practice navigation", () => {
  test("keeps the footer Next button enabled while real controls remain optional practice", () => {
    const html = renderToStaticMarkup(
      <GuidePrimaryButton label="Next" showArrow onClick={() => undefined} />,
    )
    const openingTag = html.slice(0, html.indexOf(">") + 1)

    expect(html).toContain(">Next")
    expect(openingTag).not.toMatch(/\sdisabled(?:=|\s|>)/)
  })

  test("describes real controls as optional practice instead of required Guide gates", () => {
    const allSteps = [...buildMemoSyncSteps(), ...buildAutoSteps(), ...buildStaticSteps()]
    const textById = new Map(allSteps.map((step) => [
      step.id,
      renderToStaticMarkup(<div>{step.body}</div>)
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    ]))
    const optionalPracticeSteps = [
      "system.session-setup",
      "system.first-prompt",
      "shared.browser-open",
      "shared.browser-home",
      "shared.browser-flow",
      "shared.browser-refresh",
      "shared.files",
      "memosync.opening-board",
      "memosync.long-term-card",
      "memosync.candidate-summary",
      "memosync.candidate-reopened",
      "memosync.board-library",
      "memosync.transfer",
      "memosync.checkup",
      "memosync.working-memory-ask",
      "memosync.working-memory",
      "memosync.recovery",
      "memosync.citations",
      "memosync.audit",
      "memosync.enforce",
      "memosync.memory-record",
      "auto.inspect",
      "static.notebook",
      "task.finish-practice",
    ]

    for (const id of optionalPracticeSteps) {
      expect(textById.get(id), id).toMatch(/Optional practice|You can|you can|select Next|Guide footer/)
    }

    const allCopy = [...textById.values()].join("\n")
    for (const coerciveOrFalseClaim of [
      "Complete the highlighted action",
      "Try the real flow now",
      "On M-04, press Accept",
      "Leave M-05 pending, then press",
      "Press Review again",
      "Keep M-04 accepted and press",
      "The assistant is waiting for you right now",
      "You pressed Start",
      "Try it now: press",
      "Practice the real submission path on the left. Press",
      "because you accepted the same ID",
    ]) {
      expect(allCopy).not.toContain(coerciveOrFalseClaim)
    }
  })
})

function stepsHtml(steps: ReturnType<typeof buildAutoSteps>): string {
  return steps
    .map((step) => `${step.title} ${renderToStaticMarkup(<div>{step.body}</div>)}`)
    .join("\n")
}

function stepFingerprint(step: ReturnType<typeof buildAutoSteps>[number]) {
  return {
    id: step.id,
    title: step.title,
    body: renderToStaticMarkup(<div>{step.body}</div>),
    target: step.target,
    interactive: step.interactive ?? false,
    panel: step.panel ?? null,
    panelInteractive: step.panelInteractive ?? false,
    postSessionPhase: step.postSessionPhase ?? null,
  }
}

function chapterSteps(
  steps: ReturnType<typeof buildAutoSteps>,
  chapter: "system_use" | "experiment_workflow",
) {
  return steps.filter((step) => step.chapter === chapter)
}

describe("guide chapters", () => {
  const tours = [buildMemoSyncSteps(), buildAutoSteps(), buildStaticSteps()]

  test("the visible chapter heading names both sections and their order", () => {
    expect(GUIDE_CHAPTERS).toEqual([
      {
        id: "system_use",
        label: "System use",
        description: "Practice a session chat, the condition interface, Browser, and Files.",
      },
      {
        id: "experiment_workflow",
        label: "Task & submission",
        description: "Review task instructions, Finish, and every post-session form.",
      },
    ])
    const systemHeading = renderToStaticMarkup(
      <GuideChapterHeading chapter="system_use" currentStep={9} totalSteps={31} />,
    )
    expect(systemHeading).toContain("Section 1 of 2")
    expect(systemHeading).toContain("System use")
    expect(systemHeading).toContain("Step 9 of 31")
    expect(systemHeading).toContain("tabular-nums")
    expect(systemHeading).not.toContain("uppercase")
    expect(systemHeading).not.toContain("tracking-wide")

    const taskHeading = renderToStaticMarkup(
      <GuideChapterHeading chapter="experiment_workflow" currentStep={1} totalSteps={11} />,
    )
    expect(taskHeading).toContain("Section 2 of 2")
    expect(taskHeading).toContain("Task &amp; submission")
  })

  test("the two section controls are real accessible tabs with System selected by default", () => {
    const html = renderToStaticMarkup(
      <GuideSectionTabs active="system_use" onSelect={() => undefined} />,
    )
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html).toContain('id="guide-tab-system_use"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-controls="guide-panel-experiment_workflow"')
    expect(html).toContain("Task &amp; submission")
  })

  test("every tour moves once from System use into Experiment workflow", () => {
    for (const steps of tours) {
      expect(
        steps.every((step) => step.chapter === "system_use" || step.chapter === "experiment_workflow"),
      ).toBe(true)
      expect([...new Set(steps.map((step) => step.chapter))]).toEqual([
        "system_use",
        "experiment_workflow",
      ])
    }
  })

  test("all three conditions share one identical experiment workflow and real post-session sequence", () => {
    const workflows = tours.map((steps) => chapterSteps(steps, "experiment_workflow"))
    expect(workflows.every((steps) => steps.every((step) => step.sharedAcrossConditions === true))).toBe(true)
    expect(workflows[1]!.map(stepFingerprint)).toEqual(workflows[0]!.map(stepFingerprint))
    expect(workflows[2]!.map(stepFingerprint)).toEqual(workflows[0]!.map(stepFingerprint))

    for (const steps of workflows) {
      expect(steps.map((step) => step.postSessionPhase).filter(Boolean)).toEqual([
        "finish",
        "freezing",
        "memory_questionnaire",
        "monitoring_tlx",
        "control_tlx",
        "next_session",
        "sus",
        "complete",
      ])
      const html = stepsHtml(steps)
      expect(html).toContain("official benchmark starter code")
      expect(html).toContain("your own words")
      expect(html).not.toContain("FullStack-Bench")
      expect(html).toContain("compensation")
      expect(html).toContain("blank on purpose")
    }
  })

  test("the common System-use subset is identical while memory lessons remain arm-specific", () => {
    const systemChapters = tours.map((steps) => chapterSteps(steps, "system_use"))
    const shared = systemChapters.map((steps) => steps.filter((step) => step.sharedAcrossConditions))
    const commonIds = [
      "system.welcome",
      "system.session-setup",
      "system.empty-chat",
      "system.first-prompt",
      "shared.browser-open",
      "shared.files",
    ]
    const common = shared.map((steps) => steps.filter((step) => commonIds.includes(step.id)))
    expect(common[1]!.map(stepFingerprint)).toEqual(common[0]!.map(stepFingerprint))
    expect(common[2]!.map(stepFingerprint)).toEqual(common[0]!.map(stepFingerprint))
    expect(common[0]!.map((step) => step.title)).toEqual([
      "Welcome to the coding assistant",
      "Create the session chat",
      "A new chat starts empty",
      "Send the first prompt when you are ready",
      "Browser 1 · Test the application yourself",
      "The Files panel",
    ])
    expect(systemChapters.every((steps) => steps.some((step) => step.sharedAcrossConditions === false))).toBe(true)
  })

  test("condition-specific vocabulary cannot leak into a baseline arm", () => {
    const autoSteps = buildAutoSteps()
    const auto = stepsHtml(chapterSteps(autoSteps, "system_use"))
    expect(auto).toContain("complete plain Markdown block")
    expect(auto).toContain("automatically captures")
    expect(auto).toContain("derived summary")
    expect(auto).toContain("Ask or update your memory")
    expect(auto).toContain("copied once into the second project")
    for (const forbidden of ["MemoSync", "Memory Board", "working memory", "four-way audit", "interrupt and resume", "MEMORY.md"]) {
      expect(stepsHtml(autoSteps)).not.toContain(forbidden)
    }

    const staticSteps = buildStaticSteps()
    const staticGuide = stepsHtml(chapterSteps(staticSteps, "system_use"))
    expect(staticGuide).toContain("MEMORY.md")
    expect(staticGuide).toContain("memory/*.md")
    expect(staticGuide).toContain("exact Markdown text block")
    expect(staticGuide).toContain("Edit")
    expect(staticGuide).toContain("Save")
    expect(staticGuide).toContain("copied once into the second project")
    for (const forbidden of ["MemoSync", "Memory Board", "working memory", "four-way audit", "interrupt and resume", "automatically captures"]) {
      expect(stepsHtml(staticSteps)).not.toContain(forbidden)
    }
  })

  test("the current interaction lessons invalidate older Guide receipts", () => {
    expect(STUDY_GUIDE_VERSION).toBe("2026-08-22-v10")
  })

  test("every step has a unique stable id and belongs to exactly one section", () => {
    for (const steps of tours) {
      const ids = steps.map((step) => step.id)
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
      expect(steps.every((step) => (
        step.chapter === "system_use" || step.chapter === "experiment_workflow"
      ))).toBe(true)
    }
  })

  test("MemoSync System use follows the real session and memory interaction sequence", () => {
    const ids = chapterSteps(buildMemoSyncSteps(), "system_use").map((step) => step.id)
    const requiredOrder = [
      "system.session-setup",
      "system.empty-chat",
      "system.first-prompt",
      "memosync.opening-board",
      "memosync.long-term-card",
      "memosync.candidate-summary",
      "memosync.candidate-reopened",
      "memosync.board-library",
      "memosync.transfer",
      "memosync.checkup",
      "memosync.working-memory-ask",
      "memosync.working-memory",
      "memosync.live-record",
      "memosync.interrupt",
      "memosync.recovery",
      "memosync.resumed",
      "memosync.audit",
      "shared.browser-open",
      "shared.files",
    ]

    expect(requiredOrder.map((id) => ids.indexOf(id)).every((index) => index >= 0)).toBe(true)
    expect(requiredOrder.map((id) => ids.indexOf(id))).toEqual(
      [...requiredOrder.map((id) => ids.indexOf(id))].sort((a, b) => a - b),
    )
  })

  test("Task and submission contains only task instructions and post-session work", () => {
    for (const steps of tours) {
      const workflow = chapterSteps(steps, "experiment_workflow")
      expect(workflow[0]?.id).toBe("task.instructions")
      expect(workflow.map((step) => step.id)).toContain("task.finish")
      expect(workflow.map((step) => step.id)).toContain("task.complete")
      expect(workflow.some((step) => step.id.startsWith("memosync."))).toBe(false)
    }
  })
})

describe("tour blinding", () => {
  // Methodological invariant: baseline participants must never see the
  // MemoSync identity or any hint of a fuller system.
  test("baseline tours never mention MemoSync", () => {
    for (const steps of [buildAutoSteps(), buildStaticSteps()]) {
      const html = stepsHtml(steps)
      expect(html.includes("MemoSync")).toBe(false)
      expect(html).toContain("Agent")
    }
  })

  test("every arm explains the same experiment workflow and instruction rule", () => {
    for (const steps of [buildMemoSyncSteps(), buildAutoSteps(), buildStaticSteps()]) {
      const html = stepsHtml(steps)
      expect(html).toContain("official benchmark starter code")
      expect(html).toContain("Apartment rentals")
      expect(html).toContain("Car rentals")
      expect(html).toContain("Session 2")
      expect(html).toContain("your own words")
      expect(html).not.toContain("FullStack-Bench")
      expect(html).toContain("compensation")
      expect(html).toContain("memory questionnaire")
      expect(html).toContain("workload questionnaires")
      expect(html).toContain("SUS")
      expect(html).toContain("frozen snapshot")
      expect(html).toContain("memory panel")
    }
  })

  test("every arm teaches the same complete Browser workflow on real controls", () => {
    const tours = [buildMemoSyncSteps(), buildAutoSteps(), buildStaticSteps()]
    const browserSteps = tours.map((steps) => steps.filter((step) => step.title.startsWith("Browser ")))

    expect(browserSteps.map((steps) => steps.map((step) => step.title))).toEqual([
      [
        "Browser 1 · Test the application yourself",
        "Browser 2 · Open the panel and return Home",
        "Browser 3 · Choose the current-project frontend",
        "Browser 4 · Try the complete required flow",
        "Browser 5 · Refresh after code changes",
        "Browser 6 · Report a missing or broken preview",
        "Browser 7 · Repeat until the feature works",
      ],
      [
        "Browser 1 · Test the application yourself",
        "Browser 2 · Open the panel and return Home",
        "Browser 3 · Choose the current-project frontend",
        "Browser 4 · Try the complete required flow",
        "Browser 5 · Refresh after code changes",
        "Browser 6 · Report a missing or broken preview",
        "Browser 7 · Repeat until the feature works",
      ],
      [
        "Browser 1 · Test the application yourself",
        "Browser 2 · Open the panel and return Home",
        "Browser 3 · Choose the current-project frontend",
        "Browser 4 · Try the complete required flow",
        "Browser 5 · Refresh after code changes",
        "Browser 6 · Report a missing or broken preview",
        "Browser 7 · Repeat until the feature works",
      ],
    ])

    const rendered = browserSteps.map((steps) => stepsHtml(steps))
    expect(rendered[1]).toBe(rendered[0])
    expect(rendered[2]).toBe(rendered[0])
    expect(rendered[0]).toContain("Local Servers")
    expect(rendered[0]).toContain("small green dot")
    expect(rendered[0]).toContain("frontend card")
    expect(rendered[0]).toContain("Refresh")
    expect(rendered[0]).toContain("I do not see a local server")
    expect(rendered[0]).toContain("Do not only look at the first screen")
    expect(rendered[0]).not.toContain("play button")

    const targets = browserSteps[0].map((step) => step.target)
    expect(targets).toContainEqual({ css: 'button[aria-label="Browser"]' })
    expect(targets).toContainEqual({ css: 'button[aria-label="Home"]' })
    expect(targets).toContainEqual({ css: '[data-browser-server-card-current-project="true"]' })
    expect(targets).toContainEqual({ css: 'button[aria-label="Refresh"]' })
    expect(browserSteps[0][2]?.panelInteractive).not.toBe(true)
    expect(browserSteps[0][3]?.panelInteractive).toBe(true)
    expect(browserSteps[0][4]?.panelInteractive).toBe(true)
  })

  test("the interactive Browser lesson renders a local functional demo without a network preview", () => {
    const frame = browserPreviewFrameAttributes(
      "https://memosync.example.com/__memosync/preview/5173/",
      GUIDE_BROWSER_DEMO_DOCUMENT,
    )

    expect(frame.src).toBeUndefined()
    expect(frame.srcDoc).toBe(GUIDE_BROWSER_DEMO_DOCUMENT)
    expect(GUIDE_BROWSER_DEMO_DOCUMENT).toContain('data-guide-demo-app="true"')
    expect(GUIDE_BROWSER_DEMO_DOCUMENT).toContain('data-demo-action="add-to-cart"')
    expect(GUIDE_BROWSER_DEMO_DOCUMENT).toContain('data-demo-action="clear-cart"')
    expect(GUIDE_BROWSER_DEMO_DOCUMENT).toContain('data-demo-action="confirm-clear"')

    expect(browserPreviewFrameAttributes("https://example.com", undefined)).toEqual({
      src: "https://example.com",
      srcDoc: undefined,
    })
  })

  test("the MemoSync tour covers the gates, citations, adjustment, and the audit", () => {
    const html = stepsHtml(buildMemoSyncSteps())
    expect(html).toContain("MemoSync")
    expect(html).toContain("working memory")
    expect(html).toContain("changes to existing memories")
    expect(html).toContain("hover to read the memory")
    expect(html).toContain("re-curates the working memory")
    expect(html).toContain("the audit")
    // Follow-up UI on a violated verdict, and the click-to-jump affordance.
    expect(html).toContain("Enforce this next run")
    expect(html).toContain("where used")
    expect(html).toContain("Memory Record")
    expect(html).toContain("Memory board")
    expect(html).toContain("Long-term Memory Management")
    expect(html).toContain("declines it for this project")
    expect(html).toContain("Skip remaining")
    expect(html).toContain("only that one run")
    expect(html).toContain("generated, read-only Markdown export")
    expect(html).toContain("Import as candidates")
    expect(html).not.toContain("few seconds at most")
    expect(html).not.toContain("press <strong>Handled</strong>")
  })

  test("the MemoSync tour opens every real side surface", () => {
    const panels = new Set(buildMemoSyncSteps().map((step) => step.panel).filter(Boolean))
    expect(panels).toEqual(new Set(["studySessionSetup", "memoryRecord", "browser", "files", "board", "studySessions", "studyBrief", "studySubmit", "studyPostSession"]))
  })

  test("the session-opening Board demo uses the blocking gate with all durable backlog kinds", () => {
    const steps = buildMemoSyncSteps()
    const pending = steps.find((step) => step.id === "memosync.opening-board")

    expect(pending?.id).toBe("memosync.opening-board")
    expect(pending?.panel).toBeUndefined()
    expect(pending?.boardDemo?.blocking).toBe(true)
    expect(pending?.boardDemo?.interactive).toBe(true)
    expect(pending?.panelInteractive).toBe(true)
    expect(pending?.boardDemo?.status.pending).toEqual({
      candidates: 2,
      transfers: 1,
      checkups: 1,
      total: 4,
    })
    expect(pending?.boardDemo?.status.backlog.transfers[0]?.message).toMatchObject({ kind: "memory_transfer" })
    expect(pending?.boardDemo?.status.backlog.transfers[0]?.message.decision).toBeUndefined()
    expect(pending?.boardDemo?.status.backlog.checkups[0]?.message).toMatchObject({ kind: "memory_checkup" })
    expect(pending?.boardDemo?.status.backlog.checkups[0]?.message.decision).toBeUndefined()
    expect(pending?.boardDemo?.memoryItems.filter((item) => item.status === "candidate")).toHaveLength(2)

    const html = stepsHtml([pending!])
    expect(html).toContain("one fixed")
    expect(html).toContain("Step 1 Candidate review")
    expect(html).toContain("three-column Memory Board")
    expect(html).toContain("Step 2 Transfer")
    expect(html).toContain("Step 3 Suggested Changes")
    expect(html).not.toContain("Pending review stations")
    expect(html).not.toContain("Current turn review")
    expect(html).not.toContain("Full memory library")
    expect(html).toContain("Next button always remains available")
    expect(html).toContain("held prompt can continue only after")
  })

  test("the MemoSync tour renders the complete real post-session journey without answer priming", () => {
    const steps = buildMemoSyncSteps()
    const phases = steps
      .filter((step) => step.panel === "studyPostSession")
      .map((step) => step.postSessionPhase)
    expect(phases).toEqual([
      "finish",
      "freezing",
      "memory_questionnaire",
      "monitoring_tlx",
      "control_tlx",
      "next_session",
      "sus",
      "complete",
    ])
    const finish = steps.find((step) => step.postSessionPhase === "finish")
    expect(finish?.panelInteractive).toBe(true)
    for (const phase of ["memory_questionnaire", "monitoring_tlx", "control_tlx", "next_session", "sus"]) {
      expect(steps.find((step) => step.postSessionPhase === phase)?.panelInteractive).toBe(true)
    }
    expect(stepsHtml(steps.filter((step) => step.panel === "studyPostSession"))).toContain("blank on purpose")
  })

  test("the MemoSync tour has one Board lesson after Candidate reopen", () => {
    const steps = buildMemoSyncSteps()
    expect(steps.map((step) => step.id)).not.toContain("memosync.board-roundtrip")
    expect(stepsHtml(steps)).not.toContain("Reopen and close the same Board mid-session")
    const boardSteps = steps.filter((step) => step.panel === "board")
    expect(boardSteps.map((step) => step.id)).toEqual(["memosync.board-library"])
    expect(boardSteps[0]?.target).toEqual({ css: '[data-memory-board-section="library"]' })
    expect(stepsHtml(boardSteps)).toContain("dashed placeholder")
  })

  test("each baseline spotlights its real condition-specific memory panel", () => {
    expect(buildAutoSteps().some((step) => step.panel === "autoMemory" && step.interactive)).toBe(true)
    expect(buildStaticSteps().some((step) => step.panel === "staticMemory" && step.interactive)).toBe(true)
  })

  test("both baseline tours explain the same project-copy boundary", () => {
    for (const steps of [buildAutoSteps(), buildStaticSteps()]) {
      const html = stepsHtml(steps)
      expect(html).toContain("Your first project starts with empty memory")
      expect(html).toContain("copied once into the second project")
      expect(html).toContain("separate copy")
    }
  })

  test("the Static tour describes text focus and never fabricates a read-file action", () => {
    const steps = buildStaticSteps()
    expect(stepsHtml(steps)).toContain("sends their contents to Claude as text")
    for (const step of steps) {
      const toolCalls = step.scene.entries.filter((entry) => entry.kind === "tool_call") as Array<{
        tool?: { toolKind?: string; input?: { filePath?: string } }
      }>
      expect(toolCalls.some((entry) => (
        entry.tool?.toolKind === "read_file" && entry.tool.input?.filePath === "MEMORY.md"
      ))).toBe(false)
    }
  })

  test("the violated-audit step uses the production verdict without outcome impact", () => {
    const steps = buildMemoSyncSteps()
    const violatedStep = steps.find((step) => step.id === "memosync.enforce")
    expect(violatedStep).toBeDefined()
    const hydrated = processTranscriptMessages(violatedStep!.scene.entries)
    const trace = hydrated.find((m) => m.kind === "memory_trace") as
      | { labels?: Array<{ label: string; cause?: string; cited?: boolean; impact?: string }> }
      | undefined
    const violated = trace?.labels?.find((l) => l.label === "violated")
    expect(violated?.cited).toBe(true)
    expect(violated?.cause).toBe("not_followed")
    expect(violated?.impact).toBeUndefined()
  })

  test("the resumed audit plus its violation follow-up cover all four verdicts", () => {
    const auditStep = buildMemoSyncSteps().find((step) => step.id === "memosync.audit")
    const enforceStep = buildMemoSyncSteps().find((step) => step.id === "memosync.enforce")
    expect(auditStep).toBeDefined()
    expect(enforceStep).toBeDefined()
    const traces = [auditStep!, enforceStep!].flatMap((step) =>
      processTranscriptMessages(step.scene.entries).filter((message) => message.kind === "memory_trace")
    ) as Array<
      | { labels?: Array<{ label: string; missing?: string }> }
    >

    expect(new Set(traces.flatMap((trace) => trace.labels?.map((label) => label.label) ?? []))).toEqual(new Set([
      "violated",
      "operational",
      "not_applicable",
      "injected_without_effect",
    ]))
    const notApplicable = traces.flatMap((trace) => trace.labels ?? [])
      .find((label) => label.label === "not_applicable")
    expect(notApplicable?.missing).toBe("No image was generated in this turn.")
  })

  test("the Memory Record lesson shows an in-flight citation before a transcript reply exists", () => {
    const liveRecordStep = buildMemoSyncSteps().find((step) => step.title === "The Memory Record updates live")
    expect(liveRecordStep).toBeDefined()
    expect(liveRecordStep?.panel).toBe("memoryRecord")
    expect(liveRecordStep?.scene.streamingText).toContain("[M-02]")
    expect(liveRecordStep?.scene.entries.some((entry) => entry.kind === "assistant_text")).toBe(false)
  })

  test("interrupt, recovery, resume, and audit are one causal local trajectory", () => {
    const byId = new Map(buildMemoSyncSteps().map((step) => [step.id, step]))
    const interrupt = byId.get("memosync.interrupt")!
    const recovery = byId.get("memosync.recovery")!
    const resumed = byId.get("memosync.resumed")!
    const audit = byId.get("memosync.audit")!

    expect(interrupt.scene.streamingText).toContain("empty array directly")
    expect(interrupt.scene.streamingText).toContain("[M-02]")
    expect(interrupt.target).toEqual({ css: '[data-memory-interrupt="visible"]' })
    expect(interrupt.interactive).not.toBe(true)
    expect(interrupt.interruptDemo).not.toBe(true)
    expect(interrupt.interruptPreview).toBe(true)

    const parked = processTranscriptMessages(recovery.scene.entries)
    expect(parked.some((entry) => entry.kind === "memory_interrupt")).toBe(true)
    expect(parked.some((entry) => entry.kind === "result")).toBe(false)
    expect(parked.some((entry) => entry.kind === "memory_trace")).toBe(false)

    const continued = processTranscriptMessages(resumed.scene.entries)
    expect(continued.find((entry) => entry.kind === "memory_interrupt")).toMatchObject({
      resolution: {
        correction: "Use CartContext's clearCart action instead of page-local state.",
        selectedIds: ["M-02", "M-03"],
        enforced: true,
      },
    })
    expect(continued.some((entry) => entry.kind === "result")).toBe(true)
    expect(continued.some((entry) => entry.kind === "memory_trace")).toBe(false)
    expect(processTranscriptMessages(audit.scene.entries).some((entry) => entry.kind === "memory_trace")).toBe(true)
  })

  test("the settled recovery receipt reflects the local correction composer without a legacy action", () => {
    const scene = withResumeDecision(buildMemoSyncSteps().find((step) => step.id === "memosync.resumed")!.scene, {
      interruptId: "i1",
      correction: "Use CartContext's clearCart action.",
      selectedIds: ["M-03"],
      enforce: true,
    })
    const rawResolution = scene.entries.find((entry) => entry.kind === "memory_interrupt_resolution")
    expect(rawResolution && "action" in rawResolution).toBe(false)
    const interrupt = processTranscriptMessages(scene.entries)
      .find((entry) => entry.kind === "memory_interrupt")
    expect(interrupt).toMatchObject({
      resolution: {
        correction: "Use CartContext's clearCart action.",
        selectedIds: ["M-03"],
        enforced: true,
      },
    })
  })

  test("Working Memory teaches the real local Ask composer before the separate Start action", () => {
    const steps = buildMemoSyncSteps()
    const ids = steps.map((step) => step.id)
    const ask = steps.find((step) => step.id === "memosync.working-memory-ask")
    const start = steps.find((step) => step.id === "memosync.working-memory")

    expect(ask?.target).toEqual({ css: "[data-preview-ask]" })
    expect(ask?.interactive).toBe(true)
    expect(ask?.previewDemo?.reviseReply).toBeTruthy()
    expect(ids.indexOf("memosync.working-memory-ask")).toBe(ids.indexOf("memosync.working-memory") - 1)
    expect(start?.target).toEqual({ rowId: TOUR_ANCHORS.preview })

    const askPreview = processTranscriptMessages(ask!.scene.entries)
      .find((entry) => entry.kind === "memory_preview") as { decision?: string } | undefined
    expect(askPreview?.decision).toBeUndefined()
  })

  test("the recovery lesson mirrors the single production composer", () => {
    const recovery = buildMemoSyncSteps().find((step) => step.id === "memosync.recovery")
    const html = stepsHtml([recovery!])

    expect(html).toContain("Describe the problem or correction")
    expect(html).toContain("Enforce this memory for the resumed run")
    expect(html).toContain("Send and resume")
    expect(html).not.toContain("The memory itself is wrong")
    expect(html).not.toContain("It was used wrongly")
  })

  test("every preview-card lesson exposes its production controls in local demo mode", () => {
    for (const step of buildMemoSyncSteps()) {
      const hydrated = processTranscriptMessages(step.scene.entries)
      const preview = hydrated.find((m) => m.kind === "memory_preview") as { decision?: string } | undefined
      if (preview && preview.decision === undefined) {
        expect(step.previewDemo).toBeDefined()
        expect(step.interactive).toBe(true)
      }
    }
  })

  test("no step copy uses an em dash (user writing rule)", () => {
    for (const steps of [buildMemoSyncSteps(), buildAutoSteps(), buildStaticSteps()]) {
      expect(stepsHtml(steps).includes("—")).toBe(false)
    }
  })
})

describe("tour scenes", () => {
  const allTours = [buildMemoSyncSteps(), buildAutoSteps(), buildStaticSteps()]

  test("every scene hydrates through the real transcript pipeline", () => {
    for (const steps of allTours) {
      for (const step of steps) {
        expect(() => processTranscriptMessages(step.scene.entries)).not.toThrow()
      }
    }
  })

  test("every row-id target exists in its own step's scene", () => {
    for (const steps of allTours) {
      for (const step of steps) {
        if (!step.target || !("rowId" in step.target)) continue
        const ids = new Set(step.scene.entries.map((entry) => entry._id))
        expect(ids.has(step.target.rowId)).toBe(true)
      }
    }
  })

  test("the memosync preview step shows an OPEN gate (undecided, last visible)", () => {
    const steps = buildMemoSyncSteps()
    const previewStep = steps.find((step) => step.target && "rowId" in step.target && step.target.rowId === TOUR_ANCHORS.preview)
    expect(previewStep).toBeDefined()
    const hydrated = processTranscriptMessages(previewStep!.scene.entries)
    const preview = hydrated.find((m) => m.kind === "memory_preview") as { decision?: string } | undefined
    // Undecided = the gate renders fully open with its buttons — the moment
    // the step teaches. (A decided gate collapses to a receipt line.)
    expect(preview?.decision).toBeUndefined()
    const last = hydrated[hydrated.length - 1]
    expect(last?.kind).toBe("memory_preview")
  })

  test("the real Step 1 gate settles, exposes Review again, and reopens before the Board", () => {
    const steps = buildMemoSyncSteps()
    const proposalsStep = steps.find((step) => step.id === "memosync.long-term-card")
    const summaryStep = steps.find((step) => step.id === "memosync.candidate-summary")
    const reopenedStep = steps.find((step) => step.id === "memosync.candidate-reopened")
    expect(proposalsStep?.target).toEqual({ rowKind: "memory-changes-review", nth: 0 })

    const open = processTranscriptMessages(proposalsStep!.scene.entries)
    const proposals = open.find((m) => m.kind === "memory_proposals") as
      | { decision?: string; candidates?: unknown[]; pending?: boolean }
      | undefined
    expect(proposals?.decision).toBeUndefined()
    expect(proposals?.candidates?.length).toBe(2)
    expect(proposals?.pending).toBe(false)

    const summary = processTranscriptMessages(summaryStep!.scene.entries)
    const summaryProposal = summary.find((message) => message.kind === "memory_proposals") as
      | Parameters<typeof MemoryProposalsGate>[0]["message"]
      | undefined
    expect(summaryProposal?.decision).toBe("skipped")
    const rows = buildResolvedTranscriptRows(summary, {
      isLoading: false,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })
    const reviewRow = rows.find((row) => row.kind === "memory-changes-review")
    expect(reviewRow).toMatchObject({ kind: "memory-changes-review", canReopenProposals: true })
    const summaryHtml = renderToStaticMarkup(
      <MemoryProposalsGate
        message={summaryProposal!}
        stale={false}
        onRespond={() => undefined}
        canReopen
        onReopen={() => undefined}
      />,
    )
    expect(summaryHtml).toContain("Review again")

    const reopened = processTranscriptMessages(reopenedStep!.scene.entries)
      .find((message) => message.kind === "memory_proposals") as { decision?: string } | undefined
    expect(reopened?.decision).toBeUndefined()
  })
})
