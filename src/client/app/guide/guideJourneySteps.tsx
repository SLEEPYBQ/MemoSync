import type { ReactNode } from "react"
import type { TourStep } from "./GuideTour"
import {
  buildAutoSteps as buildSourceAutoSteps,
  buildMemoSyncSteps as buildSourceMemoSyncSteps,
  buildStaticSteps as buildSourceStaticSteps,
} from "./tourSteps"

type StepPatch = Partial<Omit<TourStep, "id" | "scene">>

type StepMap = Map<string, TourStep>

const BROWSER_STEP_IDS = [
  "shared.browser-open",
  "shared.browser-home",
  "shared.browser-server",
  "shared.browser-flow",
  "shared.browser-refresh",
  "shared.browser-troubleshoot",
  "shared.browser-iterate",
] as const

const POST_SESSION_STEP_IDS = [
  "task.finish",
  "task.finish-practice",
  "task.freeze",
  "task.memory-questionnaire",
  "task.monitoring-tlx",
  "task.control-tlx",
  "task.next-session",
  "task.sus",
  "task.complete",
] as const

const MEMOSYNC_STEP_IDS = [
  "memosync.opening-board",
  "memosync.long-term-card",
  "memosync.candidate-summary",
  "memosync.candidate-reopened",
  "memosync.board-library",
  "memosync.transfer",
  "memosync.checkup",
  "memosync.working-memory-ask",
  "memosync.working-memory",
  "memosync.streaming",
  "memosync.live-record",
  "memosync.interrupt",
  "memosync.recovery",
  "memosync.resumed",
  "memosync.citations",
  "memosync.audit",
  "memosync.enforce",
  "memosync.memory-record",
] as const

const AUTO_STEP_IDS = [
  "auto.memory",
  "auto.inspect",
  "shared.work-log",
  "shared.finished-reply",
] as const

const STATIC_STEP_IDS = [
  "static.notebook",
  "static.apply",
  "static.update",
  "shared.work-log",
  "shared.finished-reply",
] as const

function text(...paragraphs: ReactNode[]) {
  return <>{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</>
}

const SHARED_PATCHES: Record<string, StepPatch> = {
  "system.welcome": {
    title: "Practice a complete study session",
    body: text(
      <>This Guide follows one session from the task brief to the final questions.</>,
      <>The left side shows the controls used in the study. Any action you try here stays inside the Guide.</>,
    ),
  },
  "task.sessions": {
    title: "Complete four sessions in order",
    body: text(
      <>You will work on two projects: <strong>Apartment rentals</strong> and <strong>Car rentals</strong>. Each project has Session 1 and Session 2.</>,
      <>Start a new chat for every session. Session 2 continues the files from Session 1. Complete the questions after each session to unlock the next one.</>,
      <>The list on the left shows one completed session, one active session, and two sessions that are still locked.</>,
    ),
  },
  "task.instructions": {
    title: "Read the task brief first",
    body: text(
      <>Read each task brief yourself. Then explain the task to the coding agent in <strong>your own words</strong>.</>,
      <>Do not use copy/paste, browser developer tools, screenshots, files, or another tool to transfer all or a substantially verbatim part of the instructions to the agent. Describe the goal in your own words. A violation makes your participation ineligible for compensation.</>,
      <>Grading happens after the study, so no benchmark score appears during a session. The study team will notify you after grading and determine compensation at that time.</>,
      <>The left side shows the protected task-brief screen used in the formal study.</>,
    ),
  },
  "system.session-setup": {
    title: "Create a new chat for the session",
    body: text(
      <>After reading the brief, select <strong>New session chat</strong>. This opens an empty chat in the assigned project and sends no message.</>,
      <>Optional practice: select <strong>New session chat</strong>, or select <strong>Next</strong>.</>,
    ),
  },
  "system.empty-chat": {
    title: "The session chat starts empty",
    body: text(
      <>Nothing has been sent yet. Read the task, decide how to explain it, and write the first prompt when you are ready.</>,
    ),
  },
  "system.first-prompt": {
    title: "Send the first prompt",
    body: text(
      <>Type the task in your own words. <strong>Enter</strong> sends the prompt, and <strong>Shift+Enter</strong> starts a new line. You can leave the engine settings unchanged.</>,
      <>Optional practice: send the prepared Practice shop prompt, or select <strong>Next</strong>.</>,
    ),
  },
  "shared.work-log": {
    title: "Follow the agent's work",
    body: text(
      <>Grey rows show actions such as running commands and editing files. Select a row to inspect what happened.</>,
      <>You do not need to approve every row. Use the work log to monitor progress and investigate mistakes.</>,
    ),
  },
  "shared.finished-reply": {
    title: "Read the finished reply",
    body: text(
      <>The final reply summarizes the changes. Treat it as a report, then test the application yourself.</>,
      <>When something is missing or incorrect, describe what you observed and ask the agent to fix it.</>,
    ),
  },
  "shared.browser-open": {
    title: "Browser 1 · Test the application yourself",
    body: text(
      <>Browser opens the web application beside the chat. Use it after the agent starts the app and after every meaningful change.</>,
      <>A task is not complete just because the agent says the code is finished. Try the required interaction yourself.</>,
      <>Optional practice: select <strong>Browser</strong>, or select <strong>Next</strong>.</>,
    ),
  },
  "shared.browser-home": {
    title: "Browser 2 · Return to the server list",
    body: text(
      <>Select <strong>Home</strong> in the Browser toolbar to return to the Local Servers list.</>,
      <>Optional practice: select <strong>Home</strong>, or select <strong>Next</strong>.</>,
    ),
  },
  "shared.browser-server": {
    title: "Browser 3 · Choose the current project",
    body: text(
      <>Each Local Servers card belongs to a running server. The green dot marks a server from the current project.</>,
      <>Open the frontend card to use the application. An API card may show data instead of a visual page.</>,
    ),
  },
  "shared.browser-flow": {
    title: "Browser 4 · Try the complete task flow",
    body: text(
      <>Use the application like a normal website. Click controls, enter data, move between pages, and test the complete flow from the task brief.</>,
      <>Optional practice: open the frontend card and try the app, or select <strong>Next</strong>.</>,
    ),
  },
  "shared.browser-refresh": {
    title: "Browser 5 · Refresh after code changes",
    body: text(
      <>The page may update automatically after a code change. Select <strong>Refresh</strong> when it does not.</>,
      <>The study manages the address in this panel. You normally do not need to edit it.</>,
    ),
  },
  "shared.browser-troubleshoot": {
    title: "Browser 6 · Report a broken preview",
    body: text(
      <>When no server card appears, tell the agent: <strong>“I do not see a local server in the Browser panel. Please start the app and keep the server running.”</strong></>,
      <>When a page is blank or shows an error, refresh once. If the problem remains, tell the agent exactly what you see. Stay in the assigned project and use this Browser panel.</>,
    ),
  },
  "shared.browser-iterate": {
    title: "Browser 7 · Repeat until the feature works",
    body: (
      <>
        <p>For each requested feature:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Explain the goal to the agent.</li>
          <li>Let the agent inspect and change the code.</li>
          <li>Open the application in Browser.</li>
          <li>Try the required interaction.</li>
          <li>Describe any problem and ask for a fix.</li>
          <li>Repeat until you are satisfied.</li>
        </ol>
      </>
    ),
  },
  "shared.files": {
    title: "Inspect Files and Git",
    body: text(
      <>Files shows the project's folders and files. Select a file to read it, edit it, or search the project.</>,
      <>Git shows every file change as a diff. Use it to check what the agent changed.</>,
      <>Optional practice: open <strong>client/src/pages/CartPage.tsx</strong>, or select <strong>Next</strong>.</>,
    ),
  },
  "task.finish": {
    title: "Finish the session when the task is complete",
    body: text(
      <>When you are satisfied with the work, select <strong>Finish this session</strong> in the study bar.</>,
      <>The next screen asks you to confirm. After the final confirmation, the session becomes read-only and the questions begin.</>,
      <>You will complete a Memory questionnaire, Monitoring workload questions, and Control workload questions. The final session also includes the SUS usability questionnaire.</>,
      <>If you close the tab, reopening the study returns to the first unfinished step.</>,
    ),
  },
  "task.finish-practice": {
    title: "Practice the final confirmation",
    body: text(
      <>Optional practice: select <strong>Finish this session</strong> and follow the two confirmation screens, or select <strong>Next</strong>.</>,
      <>The controls in this Guide only change the practice preview. In a formal session, the final <strong>Yes</strong> cannot be undone.</>,
    ),
  },
  "task.freeze": {
    title: "The session freezes before the questions",
    body: text(
      <>After confirmation, the system waits for the current agent turn and memory work to finish. It then freezes the session state used by the questions.</>,
      <>Keep the page open. Once freezing starts, you cannot return to the chat or memory interface.</>,
    ),
  },
  "task.memory-questionnaire": {
    title: "First: the Memory questionnaire",
    body: text(
      <>The questionnaire lists each distinct memory that was actually focused during this session. For each one, report what you wanted remembered, what you believe the agent remembered, and whether the agent applied it in the session output.</>,
      <>The practice form is blank so the Guide does not suggest an answer. In the formal study, complete every required field.</>,
    ),
  },
  "task.monitoring-tlx": {
    title: "Then: Monitoring workload",
    body: text(
      <>This block asks about the effort involved in checking and understanding what the agent remembered.</>,
      <>The practice sliders are blank. In the formal study, move every slider before continuing.</>,
    ),
  },
  "task.control-tlx": {
    title: "Then: Control workload",
    body: text(
      <>This block asks about the effort involved in changing or updating what the agent remembered.</>,
      <>Submitting this block completes the session measurements and unlocks the next study step.</>,
    ),
  },
  "task.next-session": {
    title: "Continue to the next session",
    body: text(
      <>After the Memory questionnaire and both workload blocks are recorded, select <strong>Continue to next session</strong>.</>,
      <>Session 2 keeps the files produced in Session 1. The assigned project and session order do not change.</>,
    ),
  },
  "task.sus": {
    title: "After the final session: SUS",
    body: text(
      <>After the last session's workload questions, answer the ten SUS statements about the system used across the study.</>,
      <>The practice form is blank. In the formal study, answer every statement once.</>,
    ),
  },
  "task.complete": {
    title: "Preview the final completion page",
    body: text(
      <>This example shows the page that appears after the final SUS questionnaire is submitted.</>,
      <>Reaching this preview inside the Guide records nothing and does not mean the study is complete. In the actual study, tell the experimenter only when this page appears after your own final submission.</>,
    ),
  },
}

const MEMOSYNC_PATCHES: Record<string, StepPatch> = {
  "memosync.opening-board": {
    title: "Start-of-session Long-term Memory review",
    body: text(
      <>This example shows what appears after the first prompt is sent. In an actual session, MemoSync holds that prompt and opens the <strong>Memory Board</strong>.</>,
      <>The Memory Board gives the full view of <strong>Long-term Memory Management</strong>. Review the pending items, then select <strong>Continue with this message</strong>. MemoSync sends the same prompt after the review.</>,
      <>This opening review can include unfinished decisions from earlier work. After the prompt continues, the prompt may produce new memory suggestions inside the chat.</>,
      <>Long-term Memory Management has two synchronized views: the Memory Board and review cards inside the chat. A change in either view appears in the other.</>,
      <>Optional practice: explore the Memory Board controls, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.long-term-card": {
    title: "Step 1 · Review New Memory Candidates",
    body: text(
      <>Step 1 appears inside the chat when the current turn proposes a new Long-term Memory or a revision.</>,
      <><strong>Accept</strong> saves it, <strong>Edit</strong> changes it before saving, and <strong>Dismiss</strong> rejects it. Choose Session, Project, or Personal scope to control where it applies.</>,
      <>These actions update the same Long-term Memory shown on the Memory Board. Working Memory is selected separately before the turn starts.</>,
      <>Optional practice: try Accept, Edit, Dismiss, or Skip remaining. You can also select <strong>Next</strong>.</>,
    ),
  },
  "memosync.candidate-summary": {
    title: "Review the Step 1 summary",
    body: text(
      <>This example shows a settled Step 1 summary. In an actual session, the card becomes this summary after Step 1 continues.</>,
      <>Select <strong>Review again</strong> to reopen the same Candidate review. Saved and dismissed decisions remain visible.</>,
      <>Optional practice: select <strong>Review again</strong>, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.candidate-reopened": {
    title: "Undo or restore a Candidate decision",
    body: text(
      <>This example shows Step 1 reopened after Review again. In an actual session, it shows the current state of each Candidate.</>,
      <><strong>Undo accept</strong> returns a saved Candidate to review. <strong>Restore for review</strong> returns a dismissed non-sensitive Candidate.</>,
      <>Optional practice: try an inverse action, use Skip, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.board-library": {
    title: "The Memory Board and chat stay synchronized",
    body: text(
      <>The Memory Board shows the complete Long-term Memory view. The chat review cards keep the same decisions close to the current turn.</>,
      <>Personal memories can apply across projects. Project memories stay with one project. Session memories stay with one chat.</>,
      <>A dashed Candidate card marks its proposed destination. Accept, Undo, Dismiss, and Restore still happen in Step 1, and the result appears here with the same memory ID.</>,
      <>The Memory files section is a read-only Markdown view. Importing a memory file creates Candidates for Step 1.</>,
      <>Optional practice: inspect the three scope columns, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.transfer": {
    title: "Step 2 · Transfer Suggestions",
    body: text(
      <>Step 2 finds a useful memory from another project or chat and adapts it to the current context.</>,
      <>Compare the source memory, the abstract rule, and the adapted result. Choose the scope before saving.</>,
      <><strong>Bring in</strong> saves the adapted result to Long-term Memory. <strong>Not this one</strong> declines it for this project. <strong>Skip remaining</strong> leaves it for later review.</>,
      <>Working Memory later decides whether the saved result guides this turn.</>,
      <>Optional practice: try one decision, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.checkup": {
    title: "Step 3 · Review Suggested Changes to Existing Memories",
    body: text(
      <>Step 3 checks existing Long-term Memory for conflicts, repeated information, and outdated content.</>,
      <>Read the reason for each suggestion, then choose the appropriate fix. <strong>Skip remaining & continue</strong> leaves unresolved suggestions for later.</>,
      <>When nothing needs attention, Step 3 shows a short completed line and requires no action.</>,
      <>Optional practice: try a fix, use Skip, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.working-memory-ask": {
    title: "Working Memory for This Turn",
    body: text(
      <>Working Memory contains the memories selected to guide the turn you are about to start.</>,
      <>Review the selected memories and how MemoSync expects the agent to use each one. Add or remove memories when needed.</>,
      <>You can also ask MemoSync which memories matter or tell it what to add or remove. These changes affect this turn. Long-term Memory stays unchanged.</>,
      <>Optional practice: ask <strong>Which memories matter most for this cart task?</strong>, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.working-memory": {
    title: "Adjust Working Memory and start",
    body: text(
      <>Use the remove control, <strong>Add from memory pool</strong>, or the text box to adjust Working Memory.</>,
      <><strong>Start</strong> confirms the current list and begins the turn. An empty list starts without memory. <strong>Dismiss turn</strong> returns the prompt to the message box.</>,
      <>Optional practice: adjust the list and select Start, try Dismiss turn, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.streaming": {
    title: "Memory chips appear while the agent works",
    body: text(
      <>This example shows the agent working after Working Memory has been confirmed. In an actual session, selecting Start begins the turn and the earlier review cards become short receipts.</>,
      <>A chip such as <strong>M-02</strong> is the agent's live report that it referenced a memory while working. The Memory Use Audit later checks the effect.</>,
    ),
  },
  "memosync.live-record": {
    title: "The Memory Record updates during the turn",
    body: text(
      <>The <strong>Memory Record</strong> shows memory activity for each turn in this chat.</>,
      <>During execution, Reported Memory Use collects memory chips in first-seen order. Repeated citations increase the count instead of adding duplicate rows.</>,
      <>Hover a chip to read the memory. An eligible current-turn chip also provides the per-memory Stop control.</>,
    ),
  },
  "memosync.interrupt": {
    title: "Stop when a memory is used incorrectly",
    body: text(
      <>While the agent is working, an eligible memory chip has a red <strong>Stop</strong> control beside it.</>,
      <>Select Stop once to arm it, then select Confirm. The whole turn stops, and MemoSync records which memory caused the interruption.</>,
      <>The Stop control below the message box also stops the turn, but it does not identify a specific memory.</>,
      <>This illustration is read-only. Select <strong>Next</strong> to see the recovery flow.</>,
    ),
  },
  "memosync.recovery": {
    title: "Correct the problem and resume",
    body: text(
      <>The recovery card appears where the turn stopped and shows the relevant quote.</>,
      <>Write what the agent should do differently. You may adjust Working Memory and optionally enforce the flagged memory for the resumed turn.</>,
      <><strong>Send and resume</strong> continues from the stopped point. Completed work remains visible, and the earlier Long-term Memory review does not repeat.</>,
      <>Optional practice: enter a correction and resume, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.resumed": {
    title: "The agent continues after Resume",
    body: text(
      <>This example shows a continuation after Resume. In an actual session, the submitted correction guides the continuation and the earlier interrupted output remains visible.</>,
      <>In this example, the agent uses CartContext M-02 and keeps the confirmation dialog M-03.</>,
    ),
  },
  "memosync.citations": {
    title: "Hover a memory chip to read it",
    body: text(
      <>A memory chip uses the same ID shown in Working Memory and on the Memory Board.</>,
      <>Optional practice: hover M-02 or M-03 to read the Long-term Memory, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.audit": {
    title: "Memory Use Audit: check the effect",
    body: (
      <>
        <p>After the turn finishes, the Audit checks every Working Memory item:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Shaped this turn</strong>: the memory visibly changed the work.</li>
          <li><strong>Violated</strong>: applicable work went against the memory.</li>
          <li><strong>Not applicable this turn</strong>: the turn had no object the memory could apply to.</li>
          <li><strong>No visible effect</strong>: the memory was available, but no effect could be detected.</li>
        </ul>
        <p>In this cart example, M-02 shapes the shared cart action, M-03 shapes the confirmation dialog, M-07 has no image to apply to, and M-01 has no visible effect.</p>
        <p>Optional practice: select <strong>where used</strong> to jump to supporting evidence, or select <strong>Next</strong>.</p>
      </>
    ),
  },
  "memosync.enforce": {
    title: "Follow up after a violation",
    body: text(
      <>A violated row explains what went wrong and shows a safe follow-up when one is available.</>,
      <><strong>Enforce this next run</strong> requires a sound memory for one next turn. <strong>Draft a fix</strong> creates a corrected Candidate for later Step 1 review when the memory itself conflicts.</>,
      <>Optional practice: try Enforce on this example, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.memory-record": {
    title: "Review the complete Memory Record",
    body: text(
      <>Open the Memory Record with the brain icon in the top-right corner of the chat.</>,
      <>Each turn shows Long-term Memory review, Working Memory, reported memory use, interruptions, and the Memory Use Audit.</>,
      <>Select a stage to jump back to the matching card in the chat. Hover a stage to read more detail.</>,
      <>Optional practice: inspect a stage, or select <strong>Next</strong>.</>,
    ),
  },
  "memosync.recap": {
    title: "MemoSync follows one memory loop",
    body: (
      <>
        <p>Across each turn, MemoSync supports four connected activities:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li><strong>Review and decide</strong> changes to Long-term Memory.</li>
          <li><strong>Inspect and adjust</strong> Working Memory for This Turn.</li>
          <li><strong>Trace and interrupt</strong> how memory is used during execution.</li>
          <li><strong>Audit and follow up</strong> on the effect after execution.</li>
        </ol>
        <p>The Memory Board and chat review cards are synchronized views of Long-term Memory. The Memory Record shows the memory activity across turns.</p>
        <p>You can reopen the Guide from the sidebar.</p>
      </>
    ),
  },
}

const AUTO_PATCHES: Record<string, StepPatch> = {
  "auto.memory": {
    title: "Automatic memory for the current project",
    body: text(
      <>After a completed turn, Agent automatically captures useful preferences, decisions, and project facts.</>,
      <>Before the next turn, Agent uses the complete memory for the current project. There is no per-item selection or review step.</>,
    ),
  },
  "auto.inspect": {
    title: "Inspect or update automatic memory",
    body: text(
      <>The memory panel summarizes what Agent remembers for the current project.</>,
      <>Use <strong>Ask or update your memory</strong> to inspect the memory or request that Agent remember, change, or forget something.</>,
      <>Optional practice: try a request, or select <strong>Next</strong>.</>,
      <>The first project starts with empty memory. Its final memory is copied once into the second project. The two project copies then change independently.</>,
    ),
  },
  "auto.recap": {
    title: "Automatic-memory recap",
    body: text(
      <>Agent captures memory after completed turns and uses the full current-project memory on the next turn.</>,
      <>Use the memory panel to inspect it or request a change.</>,
    ),
  },
}

const STATIC_PATCHES: Record<string, StepPatch> = {
  "static.notebook": {
    title: "The shared Markdown memory",
    body: text(
      <>Static memory is stored in <strong>MEMORY.md</strong> and the eligible files under <strong>memory/*.md</strong>.</>,
      <>Before every turn, Agent receives the complete current text from these files. There is no per-item selection or review step.</>,
      <>Use <strong>Edit</strong> and <strong>Save</strong> to change the root memory file. Other memory files are available through Files.</>,
      <>Optional practice: edit the file, or select <strong>Next</strong>.</>,
      <>The first project starts with empty memory files. Their final contents are copied once into the second project. The two project copies then change independently.</>,
    ),
  },
  "static.apply": {
    title: "Agent uses the Markdown memory",
    body: text(
      <>Agent receives the memory text before the turn starts and follows it while working.</>,
      <>The transcript does not need a separate read-file action for this delivery.</>,
    ),
  },
  "static.update": {
    title: "Agent can update the memory files",
    body: text(
      <>When something is worth keeping, Agent can edit MEMORY.md. You can also ask Agent to change or remove a note.</>,
      <>The edit appears in Git like any other file change. Open the memory panel with the brain icon to read the current file.</>,
    ),
  },
  "static.recap": {
    title: "Static-memory recap",
    body: text(
      <>You and Agent share the Markdown memory files. Every turn receives their complete current text.</>,
      <>Memory edits remain visible in Files and Git.</>,
    ),
  },
}

function indexSteps(steps: TourStep[]): StepMap {
  return new Map(steps.map((step) => [step.id, step]))
}

function requireStep(steps: StepMap, id: string): TourStep {
  const step = steps.get(id)
  if (!step) throw new Error(`Guide journey is missing step ${id}`)
  return step
}

function patchedStep(
  steps: StepMap,
  id: string,
  conditionPatches: Record<string, StepPatch> = {},
  extra: StepPatch = {},
): TourStep {
  const source = requireStep(steps, id)
  return {
    ...source,
    ...(SHARED_PATCHES[id] ?? {}),
    ...(conditionPatches[id] ?? {}),
    ...extra,
  }
}

function practiceTaskStep(scene: TourStep["scene"]): TourStep {
  return {
    id: "shared.practice-task",
    chapter: "system_use",
    sharedAcrossConditions: true,
    title: "Practice task: add a Clear cart button",
    body: text(
      <>For the rest of this guide, we'll use one task, <strong>Practice shop</strong>, to demonstrate the study flow.</>,
      <>Add a Clear cart button to the cart page. Ask for confirmation before emptying the cart, and keep the rest of the cart working.</>,
      <>This practice project is separate from the four formal study sessions.</>,
    ),
    scene,
  }
}

function sharedStart(steps: StepMap): TourStep[] {
  const emptyChat = requireStep(steps, "system.empty-chat")
  return [
    patchedStep(steps, "system.welcome"),
    patchedStep(steps, "task.sessions", {}, { chapter: "experiment_workflow", sharedAcrossConditions: true }),
    patchedStep(steps, "task.instructions", {}, { chapter: "experiment_workflow", sharedAcrossConditions: true }),
    practiceTaskStep(emptyChat.scene),
    patchedStep(steps, "system.session-setup"),
    patchedStep(steps, "system.empty-chat"),
    patchedStep(steps, "system.first-prompt"),
  ]
}

function workspaceSteps(steps: StepMap): TourStep[] {
  return [
    ...BROWSER_STEP_IDS.map((id) => patchedStep(steps, id)),
    patchedStep(steps, "shared.files"),
  ]
}

function postSessionSteps(steps: StepMap): TourStep[] {
  return POST_SESSION_STEP_IDS.map((id) => patchedStep(steps, id, {}, {
    chapter: "experiment_workflow",
    sharedAcrossConditions: true,
  }))
}

export function buildMemoSyncSteps(): TourStep[] {
  const steps = indexSteps(buildSourceMemoSyncSteps())
  return [
    ...sharedStart(steps),
    ...MEMOSYNC_STEP_IDS.map((id) => patchedStep(steps, id, MEMOSYNC_PATCHES)),
    ...workspaceSteps(steps),
    patchedStep(steps, "memosync.recap", MEMOSYNC_PATCHES),
    ...postSessionSteps(steps),
  ]
}

export function buildAutoSteps(): TourStep[] {
  const steps = indexSteps(buildSourceAutoSteps())
  return [
    ...sharedStart(steps),
    ...AUTO_STEP_IDS.map((id) => patchedStep(steps, id, AUTO_PATCHES)),
    ...workspaceSteps(steps),
    patchedStep(steps, "auto.recap", AUTO_PATCHES),
    ...postSessionSteps(steps),
  ]
}

export function buildStaticSteps(): TourStep[] {
  const steps = indexSteps(buildSourceStaticSteps())
  return [
    ...sharedStart(steps),
    ...STATIC_STEP_IDS.map((id) => patchedStep(steps, id, STATIC_PATCHES)),
    ...workspaceSteps(steps),
    patchedStep(steps, "static.recap", STATIC_PATCHES),
    ...postSessionSteps(steps),
  ]
}
