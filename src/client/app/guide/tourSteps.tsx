import type { TourStep } from "./GuideTour"
import { buildAutoScenes, buildMemoSyncScenes, buildStaticScenes, TOUR_ANCHORS } from "./guideScenes"
import { GUIDE_BOARD_PENDING_DEMO } from "./guideBoardDemo"

type UnclassifiedTourStep = Omit<TourStep, "chapter" | "sharedAcrossConditions">

function classifySteps(
  chapter: TourStep["chapter"],
  sharedAcrossConditions: boolean,
  steps: UnclassifiedTourStep[],
): TourStep[] {
  return steps.map((step) => ({
    ...step,
    chapter,
    sharedAcrossConditions,
  }))
}

/**
 * Step content per study arm. Chapter 1 teaches system use through one shared
 * chat/Browser/Files subset plus the arm's real memory surface. Chapter 2 is
 * assembled by one shared experiment-workflow builder, so task/submission
 * instructions cannot drift between conditions. The demo advances WITH the
 * participant's clicks; the baselines call the app "Agent".
 *
 * The MemoSync steps walk the paper's 2x4 matrix in timeline order
 * (INTERACTION_REDESIGN_2026-08-07 §2): Reviewing / Accepting proposed
 * changes, Inspecting / Adjusting the injected set, Tracing / Interrupting
 * memory use, Auditing / Following Up on outcomes. Every surface is the real
 * production component; steps marked interactive can actually be tried.
 */

const DEMO_REVISE_REPLY =
  "Kept [M-02] (cart state) and [M-03] (confirmation dialog); they are the memories that touch this cart task. Say the word if you want [M-01] back in."

function composerStep(scene: TourStep["scene"]): UnclassifiedTourStep {
  return {
    id: "system.first-prompt",
    title: "Send the first prompt when you are ready",
    body: (
      <>
        <p>
          This is the real message box. You type here; <strong>Enter</strong> sends and{" "}
          <strong>Shift+Enter</strong> makes a new line. The small chips underneath show the
          engine settings used in this study; you can leave them alone.
        </p>
        <p>
          Optional practice: type a short request in your own words and send it to see the next
          local interface. Or select <strong>Next</strong> to continue the Guide without sending.
        </p>
      </>
    ),
    scene,
    target: { composer: true },
    interactive: true,
  }
}

function browserPanelSteps(scene: TourStep["scene"]): UnclassifiedTourStep[] {
  return [
    {
      id: "shared.browser-open",
      title: "Browser 1 · Test the application yourself",
      body: (
        <>
          <p>
            The Browser panel is where you try the web application that you and the coding
            assistant are building. It runs beside the chat, so you can inspect the result without
            leaving the study interface.
          </p>
          <p>
            Use it after the assistant starts the app and after every meaningful change. A task is
            not finished just because the assistant says the code is complete. Open the app and try
            the required interaction yourself.
          </p>
          <p>
            Optional practice: select <strong>Browser</strong> to open the local panel, or select
            <strong> Next</strong> to continue reading.
          </p>
        </>
      ),
      scene,
      target: { css: 'button[aria-label="Browser"]' },
      interactive: true,
    },
    {
      id: "shared.browser-home",
      title: "Browser 2 · Open the panel and return Home",
      body: (
        <>
          <p>
            This tutorial shows the real Browser panel. You can select <strong>Browser</strong> in
            the upper-right area of a chat whenever you need it.
          </p>
          <p>
            Optional practice: select the <strong>Home</strong> icon in the Browser toolbar to
            return to the Local Servers list, or select Next.
          </p>
        </>
      ),
      scene,
      panel: "browser",
      panelInteractive: true,
      target: { css: 'button[aria-label="Home"]' },
    },
    {
      id: "shared.browser-server",
      title: "Browser 3 · Choose the current-project frontend",
      body: (
        <>
          <p>
            Under <strong>Local Servers</strong>, each card is a web server currently running in
            the study workspace. Choose the card that belongs to your current project. The small
            green dot marks a server from the project you are working in, and the path on the right
            helps distinguish it from another project.
          </p>
          <p>
            Most tasks have one <strong>frontend card</strong> that opens the visible web
            application. A separate API card may show data instead of a visual page. Normally,
            open the frontend card first.
          </p>
          <p>Find that card here. The next step lets you open it and use the app.</p>
        </>
      ),
      scene,
      panel: "browser",
      target: { css: '[data-browser-server-card-current-project="true"]' },
    },
    {
      id: "shared.browser-flow",
      title: "Browser 4 · Try the complete required flow",
      body: (
        <>
          <p>
            Optional practice: select the frontend server card to open the application inside this
            panel. You can also select Next without opening it.
          </p>
          <p>
            Use it like a normal website: click buttons and links, enter data, navigate between
            pages, and check the exact flow required by the task instruction. Do not only look at
            the first screen.
          </p>
        </>
      ),
      scene,
      panel: "browser",
      panelInteractive: true,
      target: { css: '[data-browser-server-card-current-project="true"]' },
    },
    {
      id: "shared.browser-refresh",
      title: "Browser 5 · Refresh after code changes",
      body: (
        <>
          <p>
            After the assistant changes the code, the page may update automatically. If it does
            not, use <strong>Refresh</strong> in the Browser toolbar. Use Home only when you want
            to return to the server list.
          </p>
          <p>
            The address shown in this panel is managed by the study system. You normally do not
            need to type or edit it.
          </p>
          <p>Optional practice: try Refresh here, or select Next to continue.</p>
        </>
      ),
      scene,
      panel: "browser",
      panelInteractive: true,
      target: { css: 'button[aria-label="Refresh"]' },
    },
    {
      id: "shared.browser-troubleshoot",
      title: "Browser 6 · Report a missing or broken preview",
      body: (
        <>
          <p>
            If no card appears, tell the assistant: <strong>“I do not see a local server in the
            Browser panel. Please start the app and keep the server running.”</strong>
          </p>
          <p>
            If a card appears but the page is blank or shows an error, press Refresh once. If the
            problem remains, tell the assistant exactly what you see. Do not switch projects,
            create a new project, deploy the app elsewhere, or open localhost outside this panel.
          </p>
        </>
      ),
      scene,
      panel: "browser",
      target: { css: '[data-browser-panel="true"]' },
    },
    {
      id: "shared.browser-iterate",
      title: "Browser 7 · Repeat until the feature works",
      body: (
        <>
          <p>For each requested feature:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Explain the task to the assistant in your own words.</li>
            <li>Let the assistant inspect and change the code.</li>
            <li>Open the app in the Browser panel.</li>
            <li>Try the required interaction yourself.</li>
            <li>Describe any missing or incorrect behavior to the assistant.</li>
            <li>Repeat until you are satisfied, then finish the session.</li>
          </ol>
        </>
      ),
      scene,
      panel: "browser",
      target: { css: '[data-browser-panel="true"]' },
    },
  ]
}

function filesPanelStep(scene: TourStep["scene"]): UnclassifiedTourStep {
  return {
    id: "shared.files",
    title: "The Files panel",
    body: (
      <>
        <p>
          The <strong>Files</strong> button opens this workbench. The tree on the right lists
          the project's folders; click a file to read it. You can edit and save, filter files
          by name, or flip the small magnifier toggle to search inside file contents.
        </p>
        <p>
          Optional practice: you can open <strong>client/src/pages/CartPage.tsx</strong> and find
          the new button, or select Next.
        </p>
        <p>
          Next to Files there is also a <strong>Git</strong> panel, where every change the
          assistant made appears as a diff you can review and commit.
        </p>
      </>
    ),
    scene,
    panel: "files",
    target: { panel: true },
    interactive: true,
  }
}

function baselineProjectCopyExplanation() {
  return (
    <p>
      Your first project starts with empty memory, shared by every chat and session in that
      project. Its final memory is copied once into the second project. After that, each project
      has a separate copy, so changing one does not change the other.
    </p>
  )
}

function studyContractSteps(scene: TourStep["scene"]): UnclassifiedTourStep[] {
  return [
    {
      id: "task.instructions",
      title: "Read the task instruction first",
      body: (
        <>
          <p>
            Read each task instruction yourself, then explain it to the agent in <strong>your own words</strong>.
            Do not copy, paste, closely reproduce, screenshot, or extract the instruction with browser
            developer tools, files, or another tool. A violation makes your participation ineligible for
            compensation.
          </p>
          <p>
            Grading runs after the study. Scores are not shown during a session. The study
            team will notify you after grading and determine compensation at that time.
          </p>
          <p>
            On the left is the brief exactly as you will read it, own-words warning included. The
            page itself blocks copying.
          </p>
        </>
      ),
      scene,
      panel: "studyBrief",
      target: { css: '[data-study-protected-instructions]' },
    },
    {
      id: "task.sessions",
      title: "How the study is organized",
      body: (
        <>
          <p>
            You will collaborate with the coding assistant to build two web applications. The
            <strong> Apartment rentals</strong> and <strong>Car rentals</strong> projects are already
            available, and the official benchmark starter code is initialized in each one.
          </p>
          <p>
            Each project has <strong>Session 1</strong> and <strong>Session 2</strong>. Start a new
            chat for each session, but keep working in the assigned project. Session 2 continues
            the files produced in Session 1; do not create, reset, or switch projects.
          </p>
          <p>
            Work iteratively: explain the goal, inspect what the assistant changes, run the app and
            tests, try the result, and ask for fixes until you are ready to finish the session.
          </p>
          <p>
            The list on the left is the real session screen: one session finished, the current one
            active, and the rest locked until their turn.
          </p>
        </>
      ),
      scene,
      panel: "studySessions",
      target: { css: '[data-guide-study-sessions="true"]' },
    },
    {
      id: "task.finish",
      title: "How to submit a session",
      body: (
        <>
          <p>
            A session only counts once you submit it. When you are satisfied with your work, press
            the bright <strong>"Finish this session"</strong> button in the study bar at the top of
            the app. It asks you to confirm, then the session <strong>freezes permanently</strong>:
            no more messages in it.
          </p>
          <p>
            The questions open right after the freeze: first the memory questionnaire, then two
            workload questionnaires. Answer them in one sitting; the next session stays locked
            until all are submitted. After the final session there is one short SUS usability
            questionnaire, and you are done. If you close the tab midway, reopening the app takes
            you back to the first unfinished step.
          </p>
          <p>
            Once the session freezes, its chat and memory panel are no longer available for
            inspection or changes. The questions use the frozen snapshot captured when you
            pressed Finish, so answer from your experience in the session.
          </p>
          <p>
            The bar on the left is the real study bar; the button sits there through every
            session.
          </p>
        </>
      ),
      scene,
      panel: "studySubmit",
      target: { css: '[data-study-finish-button="true"]' },
    },
  ]
}

function postSessionGuideSteps(scene: TourStep["scene"]): UnclassifiedTourStep[] {
  return [
    {
      id: "task.finish-practice",
      title: "Practice finishing a session",
      body: (
        <>
          <p>
            Optional practice: use <strong>Finish this session</strong> on the left to preview the
            real submission path. You can also select the Guide's Next button without using it.
          </p>
          <p>
            In the preview, <strong>End the session and start the questions</strong> opens a second
            confirmation. In the actual study, the final <strong>Yes</strong> is irreversible. Here
            those controls only advance this isolated preview to the freezing message.
          </p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      panelInteractive: true,
      postSessionPhase: "finish",
      target: { panel: true },
    },
    {
      id: "task.freeze",
      title: "Freeze creates the measurement boundary",
      body: (
        <>
          <p>
            After the final confirmation, the system waits for the current Claude turn and memory
            jobs to settle. It then freezes the questionnaire items and actual memory state together.
          </p>
          <p>
            Keep the page open. Once freezing begins, you cannot return to the chat or inspect the
            condition's memory surface. The next screens use this immutable snapshot.
          </p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      postSessionPhase: "freezing",
      target: { panel: true },
    },
    {
      id: "task.memory-questionnaire",
      title: "First: the Memory questionnaire",
      body: (
        <>
          <p>
            The first block asks about each distinct memory actually focused during this session.
            The full frozen memory text appears at the top. Answer what you wanted remembered, what
            you believe the agent remembered, and whether it appeared in the session output.
          </p>
          <p>
            This tutorial deliberately leaves the example blank and does not suggest answers. You
            can inspect it or select the Guide's Next button without answering. In the actual study,
            complete every required field for every memory before submitting.
          </p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      panelInteractive: true,
      postSessionPhase: "memory_questionnaire",
      target: { panel: true },
    },
    {
      id: "task.monitoring-tlx",
      title: "Then: Monitoring workload",
      body: (
        <>
          <p>
            Workload block 1 of 2 asks only about checking or understanding what the agent
            remembered. It keeps all six Raw TLX dimensions.
          </p>
          <p>
            The preview is blank on purpose. You can inspect it or select the Guide's Next button.
            In the actual study, touch every slider before continuing.
          </p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      panelInteractive: true,
      postSessionPhase: "monitoring_tlx",
      target: { panel: true },
    },
    {
      id: "task.control-tlx",
      title: "Then: Control workload",
      body: (
        <>
          <p>
            Workload block 2 of 2 asks only about actions you took to change or update what the
            agent remembered. It uses the same six dimensions.
          </p>
          <p>
            In the actual study, submitting this block completes the session measurements and
            unlocks the next step. The Guide's Next button does not require a preview submission.
          </p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      panelInteractive: true,
      postSessionPhase: "control_tlx",
      target: { panel: true },
    },
    {
      id: "task.next-session",
      title: "Non-final sessions continue here",
      body: (
        <>
          <p>
            After the Memory questionnaire and both workload blocks are durably recorded, a
            non-final session shows <strong>Continue to next session</strong>. The next session
            remains locked until this point.
          </p>
          <p>Session 2 continues the same project files; project order and session order stay assigned.</p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      panelInteractive: true,
      postSessionPhase: "next_session",
      target: { panel: true },
    },
    {
      id: "task.sus",
      title: "After the final session: SUS",
      body: (
        <>
          <p>
            The final session has no next-session button. After its two workload blocks, the standard
            ten-item SUS asks about the system used across the whole study.
          </p>
          <p>
            This preview is also blank. You can inspect it or select the Guide's Next button. In the
            actual study, answer every statement once, then submit the final questions.
          </p>
        </>
      ),
      scene,
      panel: "studyPostSession",
      panelInteractive: true,
      postSessionPhase: "sus",
      target: { panel: true },
    },
    {
      id: "task.complete",
      title: "Only this page means the study is complete",
      body: (
        <p>
          After SUS is recorded, the final completion page asks you to tell the experimenter. Earlier
          session-complete pages do not mean the whole study is finished.
        </p>
      ),
      scene,
      panel: "studyPostSession",
      postSessionPhase: "complete",
      target: { panel: true },
    },
  ]
}

interface SharedSystemScenes {
  empty: TourStep["scene"]
  ask: TourStep["scene"]
  active: TourStep["scene"]
  tools: TourStep["scene"]
  final: TourStep["scene"]
}

function sharedSystemOpeningSteps(scenes: SharedSystemScenes): TourStep[] {
  return classifySteps("system_use", true, [
    {
      id: "system.welcome",
      title: "Welcome to the coding assistant",
      body: (
        <>
          <p>
            The coding assistant can inspect files, write code, run commands, and explain what it
            changed. You describe the goal in plain language and keep guiding it until the app works.
          </p>
          <p>
            The conversation on the left uses the real chat components, paused at specific moments.
            Some lessons are live, so you can try the same controls you will use in the study.
          </p>
        </>
      ),
      scene: scenes.empty,
    },
    {
      id: "system.session-setup",
      title: "Create the session chat",
      body: (
        <>
          <p>
            After reading a task brief, the study shows this real setup surface. In the actual
            session, <strong>New session chat</strong> creates a fresh conversation in the assigned
            project and sends no message.
          </p>
          <p>
            Optional practice: select New session chat to see the local setup transition, or select
            Next. It does not create a participant chat or call a study API.
          </p>
        </>
      ),
      scene: scenes.empty,
      panel: "studySessionSetup",
      panelInteractive: true,
      target: { css: '[data-study-new-session-chat="true"]' },
    },
    {
      id: "system.empty-chat",
      title: "A new chat starts empty",
      body: (
        <>
          <p>
            This is the newly created conversation. Nothing has been sent and no memory review
            appears yet. Take a moment to decide how to describe the task.
          </p>
          <p>Select Next to read how the first prompt works.</p>
        </>
      ),
      scene: scenes.empty,
    },
    composerStep(scenes.empty),
  ])
}

function sharedSystemResultSteps(scenes: SharedSystemScenes): TourStep[] {
  return classifySteps("system_use", true, [
    {
      id: "shared.work-log",
      title: "Grey rows = the assistant working",
      body: (
        <>
          <p>
            Each grey row is a real action such as running a command or editing a file. Click a row
            in the study to inspect exactly what happened.
          </p>
          <p>You do not need to approve each row; use them to monitor the work and diagnose mistakes.</p>
        </>
      ),
      scene: scenes.tools,
      target: { rowKind: "tool-group", nth: 0 },
    },
    {
      id: "shared.finished-reply",
      title: "The finished reply",
      body: (
        <p>
          The final reply summarizes the change. Treat it as a report, then test the application
          yourself. If anything is off, describe the observed problem in your next message and ask
          the assistant to fix it.
        </p>
      ),
      scene: scenes.final,
      target: { rowId: TOUR_ANCHORS.finalReply },
    },
  ])
}

function sharedSystemWorkspaceSteps(scenes: SharedSystemScenes): TourStep[] {
  return classifySteps("system_use", true, [
    ...browserPanelSteps(scenes.final),
    filesPanelStep(scenes.final),
  ])
}

function experimentWorkflowSteps(scene: TourStep["scene"]): TourStep[] {
  return classifySteps("experiment_workflow", true, [
    ...studyContractSteps(scene),
    ...postSessionGuideSteps(scene),
  ])
}

export function buildMemoSyncSteps(): TourStep[] {
  const scenes = buildMemoSyncScenes()
  const sharedScenes: SharedSystemScenes = {
    empty: scenes.empty,
    ask: scenes.ask,
    active: scenes.replying,
    tools: scenes.tools,
    final: scenes.final,
  }
  return [
    ...sharedSystemOpeningSteps(sharedScenes),
    ...classifySteps("system_use", false, [
    {
      id: "memosync.opening-board",
      title: "Your first prompt opens Long-term Memory Management",
      body: (
        <>
          <p>
            This example shows what happens after a first prompt is sent. MemoSync holds that exact
            message and opens <strong>Long-term Memory Management</strong> over the still-visible
            chat. Creating the chat itself does not open this review.
          </p>
          <p>
            This is the same <strong>Memory Board</strong> used later in the session. It has one fixed
            order: <strong>Step 1 Candidate review</strong>, the three-column Memory Board,{" "}
            <strong>Step 2 Transfer</strong>, then <strong>Step 3 Suggested Changes</strong>.
          </p>
          <p>
            This opening Board has no Close button while review remains. There is no separate current
            review or library mode: the review stations and the Personal, Project, and Session
            columns live on this one page. The count at the top is server-authoritative, so search or
            filtering cannot hide unfinished work.
          </p>
          <p>
            During a session you can reopen the same board any time with the{" "}
            visible <strong>Go to Memory Board</strong> button on a Long-term review card or at the
            top of the Memory Record. Those mid-session views close with <strong>×</strong>.
          </p>
          <p>
            Optional practice: explore any of these local Board controls. The Guide's Next button
            always remains available. In an actual session, the held prompt can continue only after
            the server reports no pending Long-term review work; Working Memory is still selected
            separately for that turn.
          </p>
        </>
      ),
      scene: scenes.empty,
      panelInteractive: true,
      target: { panel: true },
      boardDemo: GUIDE_BOARD_PENDING_DEMO,
    },
    {
      id: "memosync.long-term-card",
      title: "Step 1 · Review New Memory Candidates",
      body: (
        <>
          <p>
            This is the real Step 1 gate in the main chat. It proposes a fact about the price helper
            and your no-new-dependencies preference before the assistant starts work.
          </p>
          <p>
            Optional practice: try <strong>Accept</strong> and <strong>Undo accept</strong> on M-04,
            or leave both rows unchanged. These are real canonical status changes inside the Guide's
            isolated memory store.
          </p>
          <p>
            You can also try <strong>Dismiss</strong>, <strong>Restore for review</strong>, or{" "}
            <strong>Skip remaining and continue</strong>. Accept changes saved Long-term Memory; the
            later Working Memory step still decides what guides one run. Select Next whenever you
            want to continue the Guide.
          </p>
        </>
      ),
      scene: scenes.proposalsOpen,
      target: { rowKind: "memory-changes-review", nth: 0 },
      interactive: true,
    },
    {
      id: "memosync.candidate-summary",
      title: "Step 1 settles into a summary",
      body: (
        <>
          <p>
            In the illustrated flow, Step 1 becomes a compact summary after it continues. Whatever
            Candidate states were chosen remain canonical; this summary does not create a second copy.
          </p>
          <p>
            Optional practice: select <strong>Review again</strong> to reopen Step 1. It refreshes
            downstream review work for this turn without rolling back prior Candidate decisions.
            Or select Next.
          </p>
        </>
      ),
      scene: scenes.proposalsSettled,
      target: { rowKind: "memory-changes-review", nth: 0 },
      interactive: true,
    },
    {
      id: "memosync.candidate-reopened",
      title: "What Step 1 looks like after reopening",
      body: (
        <>
          <p>
            This example shows the same production Candidate gate after it is reopened. Its current
            local decisions remain visible, including any available <strong>Undo accept</strong> or{" "}
            <strong>Restore for review</strong> inverse.
          </p>
          <p>
            Optional practice: inspect those inverse controls or use Skip. Select Next whenever you
            are ready; no Candidate action is required to continue the Guide.
          </p>
        </>
      ),
      scene: scenes.proposalsOpen,
      target: { rowKind: "memory-changes-review", nth: 0 },
      interactive: true,
    },
    {
      id: "memosync.board-library",
      title: "One Board: proposed destinations and saved memories",
      body: (
        <>
          <p>
            This is the same real production Memory Board shown at session opening and opened by{" "}
            <strong>Go to Memory Board</strong> during a chat. The Guide presents that one Board here,
            without adding a separate reopen-and-close lesson. Its Personal, Project, and Session
            columns are one projection of the canonical memory store.
          </p>
          <p>
            A Candidate appears in its intended column as a <strong>dashed placeholder</strong>. The
            placeholder has no Accept, Undo, Restore, or edit action; those decisions belong to Step
            1. An accepted Candidate appears as a colored saved-memory card with the same ID, and Undo
            returns that same ID to a dashed destination.
          </p>
          <p>
            The lower Memory files area remains a <strong>generated, read-only Markdown export</strong>
            of this same library. <strong>Import as candidates</strong> brings external memory text
            into Step 1 for review. Decisions and edits stay in the cards above.
          </p>
          <p>
            You can inspect the three columns. Select <strong>Next</strong> to read about the real
            Step 2 Transfer gate and Step 3 Suggested Changes gate.
          </p>
        </>
      ),
      scene: scenes.proposalsSettled,
      panel: "board",
      target: { css: '[data-memory-board-section="library"]' },
    },
    {
      id: "memosync.transfer",
      title: "Transfer: a note from another project",
      body: (
        <>
          <p>
            Step 1 is done, and now MemoSync suggests a note learned in a <em>different</em> project
            ("confirm destructive actions") that fits this task. <strong>Bring in</strong> copies it
            into this project's Visible Memory Pool. <strong>Not this one</strong> declines it for this project,
            so it will not be suggested here again. <strong>Skip remaining</strong> leaves the unhandled
            suggestions waiting for later review. The later Working Memory step separately decides
            whether a brought-in memory is focused for this turn.
          </p>
          <p>
            The card you just watched ran its search for a moment, then the suggestion landed and{" "}
            <strong>Bring in</strong> became clickable. In real use, the analysis may take a moment.
          </p>
          <p>
            This card only appears when something genuinely carries over. Many turns skip it.
            Optional practice: try either local decision, or select Next without deciding.
          </p>
        </>
      ),
      scene: scenes.transferEncoded,
      reveal: { afterMs: 2200, scene: scenes.transferOpen },
      target: { rowKind: "memory-changes-review", nth: 0 },
      interactive: true,
    },
    {
      id: "memosync.checkup",
      title: "Step 3 · Review changes to existing memories",
      body: (
        <>
          <p>
            Next, MemoSync scans its saved memories for problems: duplicates, conflicts, notes gone
            stale. Here it caught one, a note pointing at a file that moved.
          </p>
          <p>
            Each finding has its own fix buttons. In a real turn, <strong>Continue</strong> follows a
            decision on every pending row; <strong>Skip remaining &amp; continue</strong> defers an
            unresolved suggestion for later review. Most turns this step just says
            "✓ Nothing needs attention." Optional practice: try either local control, or select Next.
          </p>
        </>
      ),
      scene: scenes.checkupOpen,
      target: { rowKind: "memory-changes-review", nth: 0 },
      interactive: true,
    },
    {
      id: "memosync.working-memory-ask",
      title: "Ask the assistant to help choose Working Memory",
      body: (
        <>
          <p>
            This is the real Working Memory card. Before starting the run, you can ask the
            assistant which saved memories matter for this request or tell it what to change.
          </p>
          <p>
            Optional practice: type a question in{" "}
            <strong>Ask about the pool, or tell me what to change</strong> and use the round{" "}
            <strong>Send</strong> button. The reply and any practice changes stay inside this Guide.
          </p>
          <p>
            You can ask, <strong>Which memories matter most for this cart task?</strong>, or select
            Next without asking. The next step explains how <strong>Start</strong> confirms the final
            set in a real turn.
          </p>
        </>
      ),
      scene: scenes.previewOpen,
      target: { css: "[data-preview-ask]" },
      interactive: true,
      previewDemo: {
        poolExpanded: true,
        reviseReply: DEMO_REVISE_REPLY,
      },
    },
    {
      id: "memosync.working-memory",
      title: "The working memory: confirm before it starts",
      body: (
        <>
          <p>
            Last gate: MemoSync shows the exact memories it plans to use for <em>this</em> request,
            with the likely relevant ones highlighted and a one line reason each.
          </p>
          <p>
            This is separate from Long-term Memory Management. Removing or adding something here
            changes only this run; the saved Board does not change.
          </p>
          <p>
            Use <strong>×</strong>, <strong>Add from memory pool</strong>, or the plain-language box
            to adjust the set. A plain-language request re-curates the working memory in place.
          </p>
          <p>
            In a real turn, <strong>Start</strong> confirms the listed memories and begins the run;
            <strong> Dismiss turn</strong> cancels that turn entirely.
          </p>
          <p>
            Optional practice: try Start or Dismiss here, or select Next. Dismiss returns the same
            prompt to the composer; sending it again reopens this local practice card.
          </p>
        </>
      ),
      scene: scenes.previewOpen,
      target: { rowId: TOUR_ANCHORS.preview },
      interactive: true,
      // Demo mode from the first preview step: the production buttons and
      // Enter/Esc path settle only this local scene.
      previewDemo: {
        poolExpanded: true,
        reviseReply: DEMO_REVISE_REPLY,
      },
    },
    {
      id: "memosync.streaming",
      title: "The reply streams in",
      body: (
        <>
          <p>
            This example shows what follows Start. The gates collapse into one-line receipts and the reply starts{" "}
            <strong>streaming in word by word</strong> at the bottom. The spinner row underneath
            tells you it is still going.
          </p>
          <p>
            Notice the chips like <strong>M-02</strong> appearing in the text: the assistant is
            telling you, live, which memory it is applying right now.
          </p>
        </>
      ),
      scene: scenes.replying,
    },
    {
      id: "memosync.live-record",
      title: "The Memory Record updates live",
      body: (
        <>
          <p>
            Open the <strong>Memory Record</strong> while the assistant is still working. Its
            <strong> Reported Memory Use</strong> row immediately collects each cited memory in
            first-seen order. You do not have to wait for the final reply or the audit.
          </p>
          <p>
            Here, <strong>M-02</strong> already appears in the panel even though the streaming
            sentence has not become a finished transcript message yet. Repeated citations gain a
            count instead of creating duplicate rows.
          </p>
          <p>
            While a real turn is running, these live chips have the same hover details and
            per-memory stop entry as citations in the reply.
          </p>
        </>
      ),
      scene: scenes.replying,
      panel: "memoryRecord",
      target: { panel: true },
    },
    ]),
    ...classifySteps("system_use", false, [
    {
      id: "memosync.interrupt",
      title: "Or stop it the moment you see it",
      body: (
        <>
          <p>
            You do not have to wait for the audit. While the assistant is working, the{" "}
            <strong>M-NN</strong> chips stream into the reply in real time, and the same chips
            collect in the Memory Record panel on the right.
          </p>
          <p>
            While the assistant works, every eligible chip from this turn carries a small red
            stop button beside it. Press it once to arm it, then again to confirm.
          </p>
          <p>
            The square stop button under the message box still stops everything too; the chip route
            just also records <em>which memory</em> went wrong, so recovery starts prepared.
          </p>
          <p>This illustration is read-only. Select Next to see the recovery flow.</p>
        </>
      ),
      scene: scenes.interruptStreaming,
      target: { css: '[data-memory-interrupt="visible"]' },
      interruptPreview: true,
    },
    {
      id: "memosync.recovery",
      title: "Correct the run, optionally enforce, then resume",
      body: (
        <>
          <p>
            After a stop, this card appears at the interruption point and quotes{" "}
            <strong>where you stopped</strong>. It has one correction composer, the same one used
            in a real session.
          </p>
          <p>
            In <strong>Describe the problem or correction</strong>, write what the assistant should
            do differently. If the saved memory is still correct and must be followed in the
            continuation, you can optionally select{" "}
            <strong>Enforce this memory for the resumed run</strong>. That enforcement lasts for this
            resumed run only.
          </p>
          <p>
            Optional practice: edit the correction, adjust the Working Memory chips, and select
            <strong> Send and resume</strong>. Or select Next to read the illustrated continuation.
            In a real recovery, sending the correction is Resume: the assistant keeps completed work,
            continues from the stopped point, and does not replay the earlier review steps.
          </p>
        </>
      ),
      scene: scenes.interruptOpen,
      target: { rowId: TOUR_ANCHORS.interruptCard },
      interactive: true,
    },
    {
      id: "memosync.resumed",
      title: "The reply continues after Resume",
      body: (
        <>
          <p>
            This example continuation follows an interruption and Resume. Resume settles the recovery
            card and continues the same turn without replaying Long-term review or Working Memory.
          </p>
          <p>
            The corrected continuation now uses CartContext <strong>M-02</strong> and keeps the
            confirmation dialog <strong>M-03</strong>. The earlier stopped work remains visible.
          </p>
        </>
      ),
      scene: scenes.resumed,
      target: { rowId: TOUR_ANCHORS.resumedReply },
    },
    ]),
    ...classifySteps("system_use", false, [
    {
      id: "memosync.citations",
      title: "Citations: hover to read the memory",
      body: (
        <>
          <p>
            This example resumed reply cites the memories it relied on as chips like{" "}
            <strong>M-02</strong>, the same numbers shown in Working Memory.
          </p>
          <p>Optional practice: hover any chip to read the saved memory in place, or select Next.</p>
        </>
      ),
      scene: scenes.resumedAudit,
      target: { rowId: TOUR_ANCHORS.resumedReply },
      interactive: true,
    },
    {
      id: "memosync.audit",
      title: "After the resumed reply: the audit",
      body: (
        <>
          <p>
            This example audit runs only after the resumed continuation finishes. The interrupted
            attempt itself has no result and no audit.
          </p>
          <p>Every Working Memory item lands in one of four sections:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><em>Violated</em>: applicable work went against it.</li>
            <li><em>Shaped this turn</em>: it visibly changed the work.</li>
            <li><em>Not applicable</em>: the required object never appeared.</li>
            <li><em>No visible effect</em>: it applied but made no detectable difference.</li>
          </ul>
          <p>Optional practice: use <strong>where used</strong> to jump to the supporting sentence.</p>
        </>
      ),
      scene: scenes.resumedAudit,
      target: { rowId: TOUR_ANCHORS.resumedTrace },
      interactive: true,
    },
    {
      id: "memosync.enforce",
      title: "When a later audit finds a violation",
      body: (
        <>
          <p>
            This alternate audit shows a violated memory. Optional practice: use
            <strong> Enforce this next run</strong> to lock that memory into one next run as a hard
            instruction, or select Next. The lock lasts for only that one run, and this tutorial
            request stays inside its local sandbox.
          </p>
        </>
      ),
      scene: scenes.auditViolated,
      target: { rowId: TOUR_ANCHORS.violatedTrace },
      interactive: true,
    },
    {
      id: "memosync.memory-record",
      title: "The Memory Record",
      body: (
        <>
          <p>
            The <strong>brain icon</strong> in the top right corner of a chat opens this panel: the
            whole conversation replayed from memory's point of view, one block per turn.
          </p>
          <p>
            Each turn lists its stations: candidates, transfers, checkup, the working memory, where
            the reply cited memories, and the audit verdicts.
          </p>
          <p>
            Optional practice: hover a stage to read its details, or select it to jump the
            conversation on the left back to that card. You can also select Next.
          </p>
        </>
      ),
      scene: scenes.resumedAudit,
      panel: "memoryRecord",
      target: { panel: true },
      interactive: true,
    },
    ]),
    ...sharedSystemWorkspaceSteps({ ...sharedScenes, final: scenes.resumedAudit }),
    ...classifySteps("system_use", false, [
    {
      id: "memosync.recap",
      title: "MemoSync recap",
      body: (
        <>
          <p>Four things you can always do, at any point of a turn:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Review</strong> what it wants to remember (the step cards).
            </li>
            <li>
              <strong>Adjust</strong> the working memory before it starts (the confirmation card).
            </li>
            <li>
              <strong>Stop</strong> the assistant mid-task (the stop button, or a memory chip stop entry).
            </li>
            <li>
              <strong>Follow up</strong> on the audit after the reply.
            </li>
          </ul>
          <p>
            The Memory Record (brain icon) and the Memory board ("Memory" in the sidebar) are
            always there when you want the full picture.
          </p>
          <p>
            You can reopen this tour any time from <strong>"Guide"</strong> in the sidebar.
          </p>
        </>
      ),
      scene: scenes.resumedAudit,
    },
    ]),
    ...experimentWorkflowSteps(scenes.ask),
  ]
}

export function buildAutoSteps(): TourStep[] {
  const scenes = buildAutoScenes()
  const sharedScenes: SharedSystemScenes = {
    empty: scenes.empty,
    ask: scenes.ask,
    active: scenes.replying,
    tools: scenes.tools,
    final: scenes.final,
  }
  return [
    ...sharedSystemOpeningSteps(sharedScenes),
    ...classifySteps("system_use", false, [
      {
        id: "auto.memory",
        title: "Automatic project memory",
        body: (
          <>
            <p>
              After each completed turn, Agent <strong>automatically captures</strong> broadly useful
              preferences, decisions, and codebase facts. They join one project-local memory copy
              shared by every chat and session in the current project.
            </p>
            <p>
              Before every next turn, the system focuses the current project's{" "}
              <strong>complete plain Markdown block</strong>. It sends the whole block as text, with no
              relevance filter, participant selection, or per-item review step.
            </p>
          </>
        ),
        scene: scenes.replying,
      },
      {
        id: "auto.inspect",
        title: "Inspect and update Auto memory",
        body: (
          <>
            <p>
              This real sidebar shows a readable <strong>derived summary</strong> of the current
              project's memory copy. The summary is a monitoring view, not a second canonical store
              and not a substitute for the complete block focused on each turn.
            </p>
            <p>
              Use the input labelled <strong>Ask or update your memory</strong> to inspect the copy or
              tell Agent to remember, change, or forget something. Optional practice: try a request
              here, or select Next. The interaction stays isolated from participant memory.
            </p>
            {baselineProjectCopyExplanation()}
          </>
        ),
        scene: scenes.final,
        panel: "autoMemory",
        target: { panel: true },
        interactive: true,
      },
    ]),
    ...sharedSystemResultSteps(sharedScenes),
    ...sharedSystemWorkspaceSteps(sharedScenes),
    ...classifySteps("system_use", false, [
      {
        id: "auto.recap",
        title: "Automatic-memory recap",
        body: (
          <p>
            Agent captures memory after completed turns, focuses the full current-project block on
            the next turn, and lets you inspect or change the copy through the memory sidebar.
          </p>
        ),
        scene: scenes.final,
      },
    ]),
    ...experimentWorkflowSteps(scenes.ask),
  ]
}

export function buildStaticSteps(): TourStep[] {
  const scenes = buildStaticScenes()
  const sharedScenes: SharedSystemScenes = {
    empty: scenes.empty,
    ask: scenes.ask,
    active: scenes.tools,
    tools: scenes.tools,
    final: scenes.final,
  }
  return [
    ...sharedSystemOpeningSteps(sharedScenes),
    ...classifySteps("system_use", false, [
      {
        id: "static.notebook",
        title: "The shared Markdown notebook",
        body: (
          <>
            <p>
              Static memory is the workspace's <strong>exact Markdown text block</strong>: the root{" "}
              <strong>MEMORY.md</strong> plus every eligible file under <strong>memory/*.md</strong>.
              At the start of every turn, the system reads all current memory files and sends their
              contents to Claude as text as one complete block. It never sends file attachments or
              applies relevance, selection, or per-item review.
            </p>
            <p>
              This real sidebar shows the root file. Optional practice: use <strong>Edit</strong> and
              <strong> Save</strong> here, or select Next. In a real session, extra files can be
              inspected or edited through the Files panel.
            </p>
            {baselineProjectCopyExplanation()}
          </>
        ),
        scene: scenes.ask,
        panel: "staticMemory",
        target: { panel: true },
        interactive: true,
      },
      {
        id: "static.apply",
        title: "Agent applies the exact notebook",
        body: (
          <p>
            The reply follows the Markdown text sent with this turn. There is no fabricated read-file
            action in the transcript because the study system delivers the block before the run.
          </p>
        ),
        scene: scenes.tools,
        target: { rowId: TOUR_ANCHORS.firstReply },
      },
      {
        id: "static.update",
        title: "It updates the notebook too",
        body: (
          <>
            <p>
              When something is worth keeping, Agent edits MEMORY.md. Here it noted the new button.
              The file is yours as well: ask in chat to change or remove notes, and its edits show up
              in the Git panel like any other file change.
            </p>
            <p>
              To read the notes any time, open the <strong>memory panel</strong> (brain icon on the
              right side of a chat).
            </p>
          </>
        ),
        scene: scenes.tools,
        target: { rowKind: "tool-group", nth: 1 },
      },
    ]),
    ...sharedSystemResultSteps(sharedScenes),
    ...sharedSystemWorkspaceSteps(sharedScenes),
    ...classifySteps("system_use", false, [
      {
        id: "static.recap",
        title: "Static-memory recap",
        body: (
          <p>
            You and Agent share the project Markdown files directly. Every turn receives the complete
            current block, and edits remain visible in the workspace and Git history.
          </p>
        ),
        scene: scenes.final,
      },
    ]),
    ...experimentWorkflowSteps(scenes.ask),
  ]
}
