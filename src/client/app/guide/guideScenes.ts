import type { TranscriptEntry } from "../../../shared/types"

/**
 * The guide's demo conversation, as a sequence of SCENES the participant
 * clicks through — each scene is the transcript at one real moment of a
 * turn (gates open one at a time, exactly like live usage). Content is
 * scripted to match the study task (a React + Fastify web shop), and every
 * entry uses the real transcript shapes rendered by the real components.
 */
export interface GuideScene {
  entries: TranscriptEntry[]
  /** Frozen streaming preview under the transcript (the "typing" moment). */
  streamingText?: string
  /** Footer status label for in-progress moments (e.g. "requesting"). */
  statusLabel?: string
}

let n = 0
function base(id?: string) {
  n += 1
  return { _id: id ?? `guide-${n}`, createdAt: 1_700_000_000_000 + n * 1000 }
}

function entry<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(value: T, id?: string): TranscriptEntry {
  return { ...base(id), ...value } as unknown as TranscriptEntry
}

/** Row anchors the spotlight points at (single rows use the entry id). */
export const TOUR_ANCHORS = {
  userPrompt: "demo-user-prompt",
  preview: "demo-preview",
  firstReply: "demo-first-reply",
  finalReply: "demo-final-reply",
  trace: "demo-trace",
  violatedReply: "demo-reply-violated",
  violatedTrace: "demo-trace-violated",
  interruptedReply: "demo-interrupted-reply",
  interruptCard: "demo-interrupt",
  resumedReply: "demo-resumed-reply",
  resumedTrace: "demo-resumed-trace",
} as const

export const GUIDE_DEMO_PROMPT =
  "Add a “Clear cart” button to the cart page. It should ask for confirmation before emptying the cart."

const MEMORIES = {
  stack: { id: "M-01", content: "The shop is React (client/src) + Fastify (server/routes); cart APIs live under /api/cart", scope: "project" },
  cartState: { id: "M-02", content: "Cart state lives in CartContext (client/src/cart/CartContext.tsx). Always change the cart through its actions", scope: "project" },
  confirmDialog: { id: "M-03", content: "Destructive actions get a small confirmation dialog first (user preference)", scope: "personal" },
  imageColors: { id: "M-07", content: "Generated product images should use vivid, high-contrast colors", scope: "personal" },
}

/** MemoSync arm: the full turn, gate by gate. */
export function buildMemoSyncScenes() {
  n = 0
  const empty: GuideScene = { entries: [] }
  const ask = [
    entry({ kind: "user_prompt", content: GUIDE_DEMO_PROMPT, attachments: [] }, TOUR_ANCHORS.userPrompt),
  ]

  // Step 1 open: candidates from the previous turn, waiting for review.
  const proposalsOpen = [
    ...ask,
    entry({ kind: "memory_proposals", proposalsId: "p1", turn: 2, pending: true, candidates: [] }),
    entry({
      kind: "memory_proposals_result",
      proposalsId: "p1",
      candidates: [
        { id: "M-04", content: "Product prices are formatted with the formatPrice helper (client/src/lib/money.ts)", type: "fact", scope: "project" },
        { id: "M-05", content: "Prefers no new npm dependencies. Use what the repo already has", type: "preference", scope: "personal" },
      ],
    }),
  ]

  // Step 1 settles with one accepted memory and one deferred Candidate. Its
  // real summary remains reopenable while Step 2 is pending. The same pending
  // scene lets the Transfer lesson show "it ran, then finished" rather than a
  // standing placeholder.
  const transferPending = [
    ...proposalsOpen,
    entry({ kind: "memory_proposals_decision", proposalsId: "p1", decision: "skipped" }),
    entry({ kind: "memory_transfer", transferId: "t1", turn: 2, pending: true, suggestions: [] }),
  ]
  // Encode finished, decode still running: Source/Encoder/Abstract rule are
  // on the card, the "In this project" cell shows its localizing skeleton.
  // The tour's timed reveal fills ONLY that landing cell (mentor 2026-08-15:
  // the beat is the localization landing, never a whole-card placeholder).
  const transferSuggestionBase = {
    sourceId: "M-11",
    sourceContent: "Destructive actions get a small confirmation dialog first",
    sourceScope: "personal",
    sourceVersion: 1,
    sourceLabel: "blog-platform",
    rule: "Confirm destructive actions before executing",
  }
  const transferEncoded = [
    ...transferPending,
    entry({
      kind: "memory_transfer_result",
      transferId: "t1",
      done: true,
      suggestions: [transferSuggestionBase],
    }),
  ]
  const transferOpen = [
    ...transferPending,
    entry({
      kind: "memory_transfer_result",
      transferId: "t1",
      done: true,
      suggestions: [
        {
          ...transferSuggestionBase,
          // `content` + `landing` are what flips the card to decoded — the
          // old demo data used a nonexistent `localized` field, which is why
          // the landing cell skeleton never resolved in the tour.
          content: "Ask for confirmation before emptying the cart",
          bound: ["emptying the cart"],
          suggestedScope: "project",
          landing: { route: "new" },
        },
      ],
    }),
  ]

  // Transfer handled → the library checkup opens with one finding.
  const checkupOpen = [
    ...transferOpen,
    entry({ kind: "memory_transfer_decision", transferId: "t1", decision: "handled" }),
    entry({ kind: "memory_checkup", checkupId: "c1", turn: 2, pending: true }),
    entry({
      kind: "memory_checkup_result",
      checkupId: "c1",
      suggestions: [
        {
          kind: "staleness",
          memoryId: "M-06",
          reason: "Points at pages/Cart.jsx, but the cart page moved to client/src/pages/CartPage.tsx in an earlier session.",
        },
      ],
    }),
  ]

  // Checkup handled → the injection preview gate opens (undecided: the
  // turn is genuinely waiting here, buttons visible).
  const previewOpen = [
    ...checkupOpen,
    entry({ kind: "memory_checkup_decision", checkupId: "c1", decision: "handled" }),
    entry(
      {
        kind: "memory_preview",
        previewId: "v1",
        turn: 2,
        task: GUIDE_DEMO_PROMPT,
        memories: [MEMORIES.stack, MEMORIES.cartState, MEMORIES.confirmDialog, MEMORIES.imageColors],
      },
      TOUR_ANCHORS.preview
    ),
    entry({
      kind: "memory_preview_relevance",
      previewId: "v1",
      revision: 0,
      relevant: [
        { id: "M-02", why: "Emptying the cart must go through CartContext's actions." },
        { id: "M-03", why: "“Ask for confirmation” matches the confirmation-dialog preference." },
      ],
    }),
  ]

  // Gate passed → the assistant is writing its first reply.
  const replying: TranscriptEntry[] = [
    ...previewOpen,
    entry({ kind: "memory_preview_decision", previewId: "v1", decision: "go_on", expectedUses: [] }),
  ]

  const firstReplyText =
    "I'll add the button to the cart page. The cart must be emptied through CartContext's actions [M-02], and I'll put a confirmation dialog in front of it [M-03]. Let me look at the cart code first."

  const tools = [
    ...replying,
    entry({ kind: "assistant_text", text: firstReplyText }, TOUR_ANCHORS.firstReply),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-1",
        toolKind: "bash",
        toolName: "Bash",
        input: { command: "ls client/src/cart client/src/pages", description: "Find the cart page and context" },
      },
    }),
    entry({
      kind: "tool_result",
      toolId: "tool-1",
      content: "client/src/cart:\nCartContext.tsx\ncartApi.ts\n\nclient/src/pages:\nCartPage.tsx\nCatalogPage.tsx\nCheckoutPage.tsx",
    }),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-2",
        toolKind: "edit_file",
        toolName: "Edit",
        input: {
          filePath: "client/src/pages/CartPage.tsx",
          oldString: "      <CartLineItems items={items} />",
          newString:
            "      <CartLineItems items={items} />\n      <ClearCartButton onConfirm={clearCart} />",
        },
      },
    }),
    entry({ kind: "tool_result", toolId: "tool-2", content: "Updated client/src/pages/CartPage.tsx" }),
  ]

  const final = [
    ...tools,
    entry(
      {
        kind: "assistant_text",
        text:
          "Done. The cart page now has a “Clear cart” button:\n\n- Clicking it opens a small confirmation dialog first [M-03].\n- Confirming calls CartContext's `clearCart` action [M-02], so the header badge and totals update everywhere.\n\nTry it: open the cart, add an item, and press “Clear cart”.",
      },
      TOUR_ANCHORS.finalReply
    ),
    entry({ kind: "result", subtype: "success", isError: false, durationMs: 74_000, result: "Added the Clear cart button." }),
    // The post-turn audit: verdicts on how each injected memory was used.
    entry(
      {
        kind: "memory_trace",
        turn: 2,
        status: "ok",
        summary:
          "Both key memories were followed: the cart change went through CartContext [M-02] and a confirmation dialog guards it [M-03].",
        labels: [
          {
            id: "M-02",
            label: "operational",
            cited: true,
            quote: "Confirming calls CartContext's clearCart action",
            note: "The cart is emptied through the context action, as the memory requires.",
          },
          {
            id: "M-03",
            label: "operational",
            cited: true,
            note: "A confirmation dialog now guards the destructive action.",
          },
          {
            id: "M-01",
            label: "injected_without_effect",
            note: "Available but not needed for this change.",
          },
          {
            id: "M-07",
            label: "not_applicable",
            missing: "No image was generated in this turn.",
            note: "The turn did not generate an image, so the color rule had no applicable object.",
          },
        ],
      },
      TOUR_ANCHORS.trace
    ),
  ]

  // Alternate ending for the violated-audit step: the reply CLAIMS to follow
  // the cart-context memory (inline [M-02] self-report) but actually bypassed
  // it — exactly the drift the audit exists to catch. Everything up to the
  // tool rows is the same turn.
  const auditViolated = [
    ...tools,
    entry(
      {
        kind: "assistant_text",
        text:
          "Done. The cart page now has a “Clear cart” button:\n\n- Clicking it opens a small confirmation dialog first [M-03].\n- Confirming sets the cart items to an empty array directly in the page state [M-02], which keeps the change small.\n\nTry it: open the cart, add an item, and press “Clear cart”.",
      },
      TOUR_ANCHORS.violatedReply
    ),
    entry({ kind: "result", subtype: "success", isError: false, durationMs: 74_000, result: "Added the Clear cart button." }),
    entry(
      {
        kind: "memory_trace",
        turn: 2,
        status: "ok",
        summary:
          "The dialog preference held [M-03], but the cart was emptied outside CartContext [M-02].",
        labels: [
          {
            id: "M-02",
            label: "violated",
            cited: true,
            cause: "not_followed",
            quote: "sets the cart items to an empty array directly in the page state",
            note: "the memory requires cart changes to go through CartContext's actions; the reply bypassed them",
          },
          {
            id: "M-03",
            label: "operational",
            cited: true,
            note: "A confirmation dialog guards the destructive action.",
          },
          {
            id: "M-01",
            label: "injected_without_effect",
            note: "Available but not needed for this change.",
          },
          {
            id: "M-07",
            label: "not_applicable",
            missing: "No image was generated in this turn.",
            note: "The turn did not generate an image, so the color rule had no applicable object.",
          },
        ],
      },
      TOUR_ANCHORS.violatedTrace
    ),
  ]

  // The wrong use is visible while the reply is still streaming. This is the
  // only scene that arms the current-turn citation Stop control.
  const interruptStreaming: GuideScene = {
    entries: replying,
    streamingText:
      "I'll add the confirmation, then set the cart items to an empty array directly in the page state [M-02].",
    statusLabel: "running",
  }

  // The participant stopped at the exact bad sentence. No result or audit is
  // appended to the interrupted attempt.
  const interruptOpen = [
    ...replying,
    entry(
      {
        kind: "assistant_text",
        text:
          "I'll add the confirmation, then set the cart items to an empty array directly in the page state [M-02].",
      },
      TOUR_ANCHORS.interruptedReply,
    ),
    entry({ kind: "interrupted" }),
    entry(
      {
        kind: "memory_interrupt",
        interruptId: "i1",
        memoryId: "M-02",
        turn: 2,
        quote: "Confirming sets the cart items to an empty array directly in the page state",
        prompt: GUIDE_DEMO_PROMPT,
        workingSet: [
          { id: "M-02", cited: true },
          { id: "M-03", cited: true },
          { id: "M-01", cited: false },
        ],
      },
      TOUR_ANCHORS.interruptCard
    ),
  ]

  // Resume is a continuation of the parked attempt. The resolution settles
  // the same recovery card, then the corrected continuation and its audit
  // appear without replaying Long-term or Working Memory gates.
  const resumed = [
    ...interruptOpen,
    entry({
      kind: "memory_interrupt_resolution",
      interruptId: "i1",
      correction: "Use CartContext's clearCart action instead of page-local state.",
      selectedIds: ["M-02", "M-03"],
      enforced: true,
    }),
    entry(
      {
        kind: "assistant_text",
        text:
          "Continuing from the stopped point: I corrected the implementation to call CartContext's clearCart action [M-02], while keeping the confirmation dialog [M-03].",
      },
      TOUR_ANCHORS.resumedReply,
    ),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-resume",
        toolKind: "edit_file",
        toolName: "Edit",
        input: {
          filePath: "client/src/pages/CartPage.tsx",
          oldString: "onConfirm={() => setItems([])}",
          newString: "onConfirm={clearCart}",
        },
      },
    }),
    entry({ kind: "tool_result", toolId: "tool-resume", content: "Updated client/src/pages/CartPage.tsx" }),
    entry({ kind: "result", subtype: "success", isError: false, durationMs: 31_000, result: "Resumed and corrected the cart flow." }),
  ]

  const resumedAudit = [
    ...resumed,
    entry(
      {
        kind: "memory_trace",
        turn: 2,
        status: "ok",
        summary: "The resumed continuation followed both working-memory items.",
        labels: [
          {
            id: "M-02",
            label: "operational",
            cited: true,
            quote: "call CartContext's clearCart action",
            note: "The resumed implementation uses the required shared cart action.",
          },
          {
            id: "M-03",
            label: "operational",
            cited: true,
            note: "The destructive action remains behind a confirmation dialog.",
          },
          {
            id: "M-01",
            label: "injected_without_effect",
            note: "Available to the resumed run but did not visibly change this fix.",
          },
          {
            id: "M-07",
            label: "not_applicable",
            missing: "No image was generated in this turn.",
            note: "The resumed turn did not generate an image.",
          },
        ],
      },
      TOUR_ANCHORS.resumedTrace,
    ),
  ]

  return {
    empty,
    ask: { entries: ask, statusLabel: "previewing_memory" } satisfies GuideScene,
    proposalsOpen: { entries: proposalsOpen } satisfies GuideScene,
    proposalsSettled: { entries: transferPending } satisfies GuideScene,
    transferPending: { entries: transferPending } satisfies GuideScene,
    transferEncoded: { entries: transferEncoded } satisfies GuideScene,
    transferOpen: { entries: transferOpen } satisfies GuideScene,
    checkupOpen: { entries: checkupOpen } satisfies GuideScene,
    previewOpen: { entries: previewOpen } satisfies GuideScene,
    replying: {
      entries: replying,
      streamingText: "I'll add the button to the cart page. The cart must be emptied through CartContext's actions [M-02], and I'll put a",
      statusLabel: "running",
    } satisfies GuideScene,
    tools: { entries: tools, statusLabel: "running" } satisfies GuideScene,
    final: { entries: final } satisfies GuideScene,
    auditViolated: { entries: auditViolated } satisfies GuideScene,
    interruptStreaming,
    interruptOpen: { entries: interruptOpen } satisfies GuideScene,
    resumed: { entries: resumed } satisfies GuideScene,
    resumedAudit: { entries: resumedAudit } satisfies GuideScene,
  }
}

/** Baseline B1 (auto): the same task, memory works invisibly. */
export function buildAutoScenes() {
  n = 100
  const empty: GuideScene = { entries: [] }
  const ask = [entry({ kind: "user_prompt", content: GUIDE_DEMO_PROMPT, attachments: [] }, TOUR_ANCHORS.userPrompt)]

  const firstReplyText =
    "I'll add the button to the cart page. From earlier sessions I know the cart state lives in CartContext, and you prefer a confirmation dialog before destructive actions. I'll follow both. Let me look at the cart code first."

  const replying: GuideScene = {
    entries: ask,
    streamingText:
      "I'll add the button to the cart page. From earlier sessions I know the cart state lives in CartContext, and you prefer a",
    statusLabel: "running",
  }

  const tools = [
    ...ask,
    entry({ kind: "assistant_text", text: firstReplyText }, TOUR_ANCHORS.firstReply),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-1",
        toolKind: "bash",
        toolName: "Bash",
        input: { command: "ls client/src/cart client/src/pages", description: "Find the cart page and context" },
      },
    }),
    entry({
      kind: "tool_result",
      toolId: "tool-1",
      content: "client/src/cart:\nCartContext.tsx\ncartApi.ts\n\nclient/src/pages:\nCartPage.tsx\nCatalogPage.tsx\nCheckoutPage.tsx",
    }),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-2",
        toolKind: "edit_file",
        toolName: "Edit",
        input: {
          filePath: "client/src/pages/CartPage.tsx",
          oldString: "      <CartLineItems items={items} />",
          newString:
            "      <CartLineItems items={items} />\n      <ClearCartButton onConfirm={clearCart} />",
        },
      },
    }),
    entry({ kind: "tool_result", toolId: "tool-2", content: "Updated client/src/pages/CartPage.tsx" }),
  ]

  const final = [
    ...tools,
    entry(
      {
        kind: "assistant_text",
        text:
          "Done. The cart page now has a “Clear cart” button:\n\n- Clicking it opens a small confirmation dialog first.\n- Confirming calls CartContext's `clearCart` action, so the header badge and totals update everywhere.\n\nTry it: open the cart, add an item, and press “Clear cart”.",
      },
      TOUR_ANCHORS.finalReply
    ),
    entry({ kind: "result", subtype: "success", isError: false, durationMs: 68_000, result: "Added the Clear cart button." }),
  ]

  return {
    empty,
    ask: { entries: ask, statusLabel: "requesting" } satisfies GuideScene,
    replying,
    tools: { entries: tools, statusLabel: "running" } satisfies GuideScene,
    final: { entries: final } satisfies GuideScene,
  }
}

/** Baseline B2 (static): the same task, notes live in MEMORY.md. */
export function buildStaticScenes() {
  n = 200
  const empty: GuideScene = { entries: [] }
  const ask = [entry({ kind: "user_prompt", content: GUIDE_DEMO_PROMPT, attachments: [] }, TOUR_ANCHORS.userPrompt)]

  const firstReplyText =
    "The Markdown notes sent with this turn say the cart state lives in CartContext and that destructive actions need a confirmation dialog. I'll follow both."

  const tools = [
    ...ask,
    entry({ kind: "assistant_text", text: firstReplyText }, TOUR_ANCHORS.firstReply),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-1",
        toolKind: "edit_file",
        toolName: "Edit",
        input: {
          filePath: "client/src/pages/CartPage.tsx",
          oldString: "      <CartLineItems items={items} />",
          newString:
            "      <CartLineItems items={items} />\n      <ClearCartButton onConfirm={clearCart} />",
        },
      },
    }),
    entry({ kind: "tool_result", toolId: "tool-1", content: "Updated client/src/pages/CartPage.tsx" }),
    entry({ kind: "assistant_text", text: "The code change is in. I'll record the new stable project fact in the shared notebook." }),
    entry({
      kind: "tool_call",
      tool: {
        toolId: "tool-2",
        toolKind: "edit_file",
        toolName: "Edit",
        input: {
          filePath: "MEMORY.md",
          oldString: "# Project notes",
          newString: "# Project notes\n- Cart page has a Clear cart button (confirmation dialog → CartContext.clearCart)",
        },
      },
    }),
    entry({ kind: "tool_result", toolId: "tool-2", content: "Updated MEMORY.md" }),
  ]

  const final = [
    ...tools,
    entry(
      {
        kind: "assistant_text",
        text:
          "Done. The cart page now has a “Clear cart” button with a confirmation dialog, wired to CartContext's `clearCart` action. I also noted the new button in MEMORY.md for next time.\n\nTry it: open the cart, add an item, and press “Clear cart”.",
      },
      TOUR_ANCHORS.finalReply
    ),
    entry({ kind: "result", subtype: "success", isError: false, durationMs: 71_000, result: "Added the Clear cart button." }),
  ]

  return {
    empty,
    ask: { entries: ask, statusLabel: "requesting" } satisfies GuideScene,
    tools: { entries: tools, statusLabel: "running" } satisfies GuideScene,
    final: { entries: final } satisfies GuideScene,
  }
}

/**
 * Demo memories seeded into the client memory store while the tour is open —
 * candidate cards and citation chips resolve content by id from the store,
 * so without these the demo would render "dismissed" tombstones. Removed on
 * tour unmount; loadAll() replacing them mid-tour is healed by the tour's
 * re-seed effect.
 */
export const DEMO_MEMORY_ITEMS = [
  {
    id: "M-01",
    content: "The shop is React (client/src) + Fastify (server/routes); cart APIs live under /api/cart",
    scope: "project",
    type: "fact",
    status: "active",
  },
  {
    id: "M-02",
    content: "Cart state lives in CartContext (client/src/cart/CartContext.tsx). Always change the cart through its actions",
    scope: "project",
    type: "constraint",
    status: "active",
  },
  {
    id: "M-03",
    content: "Destructive actions get a small confirmation dialog first (user preference)",
    scope: "personal",
    type: "preference",
    status: "active",
  },
  {
    id: "M-04",
    content: "Product prices are formatted with the formatPrice helper (client/src/lib/money.ts)",
    scope: "project",
    type: "fact",
    status: "candidate",
  },
  {
    id: "M-05",
    content: "Prefers no new npm dependencies. Use what the repo already has",
    scope: "personal",
    type: "preference",
    status: "candidate",
  },
  {
    id: "M-06",
    content: "The cart page lives at pages/Cart.jsx",
    scope: "project",
    type: "fact",
    status: "active",
  },
  {
    id: "M-07",
    content: "Generated product images should use vivid, high-contrast colors",
    scope: "personal",
    type: "preference",
    status: "active",
  },
].map((item) => ({
  abstractionLevel: "concrete",
  sensitive: false,
  createdAt: "2026-08-10T09:00:00.000Z",
  updatedAt: "2026-08-10T09:00:00.000Z",
  usageCount: 2,
  reinforcedCount: 1,
  version: 1,
  citedInCurrentSession: 0,
  ...item,
})) as unknown as import("../../lib/memoriesApi").MemoryItem[]
