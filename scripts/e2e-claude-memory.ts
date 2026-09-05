// REAL end-to-end verification: a live Claude model, driven through the
// production `startClaudeSession`, must READ the versioned boot snapshot
// (delta-model injection, REDESIGN D1/D2), CALL the registered memory tools
// (mcp__memory__load_memory_detail / mcp__memory__propose_memory), use the
// returned content, and cite it. This is NOT a unit test — it makes a real
// model call, needs your Claude auth (~/.claude), and costs a few tokens:
//   bun run scripts/e2e-claude-memory.ts
//
// The propose_memory routing gate's LLM is STUBBED (route: new) — this script
// verifies the Claude-side behavior; the gate itself is unit-tested.
//
// Isolation: a throwaway temp git workspace (never touches your projects). Auth
// uses the real ~/.claude (OAuth lives there and isn't portable to a copy); the
// only side effect is a discardable session-history entry keyed to the temp cwd.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { MemoryService } from "../src/server/memory"
import { createCaptureService } from "../src/server/memory/capture"
import { startClaudeSession } from "../src/server/agent"

const MODEL = process.argv[2] || "claude-haiku-4-5-20251001"

for (const k of [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_EFFORT",
]) delete process.env[k]

const repo = mkdtempSync(join(tmpdir(), "memv2-workspace-"))
writeFileSync(join(repo, "README.md"), "# scratch repo for the memory E2E\n")
execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init", { cwd: repo, stdio: "ignore" })

const mem = new MemoryService({
  dbPath: join(mkdtempSync(join(tmpdir(), "memv2-mem-")), "m.sqlite"),
  dataDir: mkdtempSync(join(tmpdir(), "memv2-md-")),
})
mem.store.create({
  id: "M-07",
  content: "Only run MainTests (~19s) before pushing; never run the full suite.",
  detail: "The full suite takes ~40 minutes and flakes on CI-only fixtures. MainTests covers the push gate: `bun test src/main --bail`. CI runs the rest nightly.",
  scope: "project", type: "constraint", projectId: "testproj", topic: "Testing",
}, { actor: 'system' })
mem.store.create({ id: "M-03", content: "The dev server runs on port 5175.", scope: "project", type: "fact", projectId: "testproj" }, { actor: 'system' })

// Routing gate with a stubbed LLM: every agent proposal routes "new" —
// deterministic, so the E2E hinges only on the real model's behavior.
const capture = createCaptureService({
  memory: mem,
  callJson: async () => ({ decisions: [{ index: 0, route: "new", targetId: null }] }),
})

console.log(`starting real Claude session (model=${MODEL})…`)
const session = await startClaudeSession({
  localPath: repo, model: MODEL, planMode: false, sessionToken: null, forkSession: false,
  onToolRequest: async () => ({}), memory: mem, capture, projectId: "testproj", chatId: "e2e-1",
})

// The boot block is the D1 contract: versioned snapshot + supersession rule.
const bootBlock = session.memoryPlan?.block ?? ""
const bootOk =
  session.memoryPlan?.mode === "skills" &&
  bootBlock.includes("[M-07 v1]") &&
  bootBlock.includes("[M-03 v1]") &&
  bootBlock.includes("HIGHEST version")
console.log("BOOT_SNAPSHOT_OK", bootOk)

await session.sendPrompt(
  "Two tasks. (1) My testing constraint memory is marked [+detail]: use your load_memory_detail tool " +
  "to load its detailed form, then reply with the EXACT test command from it and cite the memory id " +
  "in [M-NN] form. Only use what the tool returns; do not guess. " +
  "(2) Remember this for future sessions: my deploy SSH key lives at ~/.ssh/id_ed25519_server — " +
  "propose it with your propose_memory tool (scope: personal, type: fact).",
)

const toolCalls: Array<{ kind: string; name?: string }> = []
let text = ""
const deadline = Date.now() + 180_000
for await (const ev of session.stream) {
  if (ev.type !== "transcript") continue
  const e: any = ev.entry
  if (e.kind === "tool_call" && e.tool) toolCalls.push({ kind: e.tool.toolKind, name: e.tool.toolName })
  if (e.kind === "assistant_text") text += e.text
  if (e.kind === "result" || e.kind === "interrupted") break
  if (Date.now() > deadline) { console.log("TIMEOUT"); break }
}

const memoryCalls = toolCalls.filter((t) => (t.name ?? "").startsWith("mcp__memory__"))
const detailUses = mem.store.getEvents("M-07").filter((e) => e.kind === "use" && e.meta?.via === "detail_load")
const candidates = mem.store.list({ status: "candidate" })
const proposedCandidate = candidates.find((c) => /id_ed25519_server|ssh/i.test(c.content))
console.log("MEMORY_TOOL_CALLS", JSON.stringify(memoryCalls.map((t) => t.name)))
console.log("DETAIL_LOADS_RECORDED", detailUses.length)
console.log("CANDIDATES", JSON.stringify(candidates.map((c) => ({ id: c.id, content: c.content.slice(0, 80), status: c.status }))))
console.log("ASSISTANT_TEXT", JSON.stringify(text.slice(0, 700)))
const calledDetail = memoryCalls.some((t) => t.name === "mcp__memory__load_memory_detail")
const calledPropose = memoryCalls.some((t) => t.name === "mcp__memory__propose_memory")
const citedAndUsedDetail = /\[M-07\]/.test(text) && /--bail|bun test src\/main/.test(text)
const proposalLanded = Boolean(proposedCandidate && proposedCandidate.status === "candidate")
const pass = bootOk && calledDetail && calledPropose && citedAndUsedDetail && proposalLanded
console.log(
  `E2E_RESULT: ${pass ? "PASS" : "FAIL"} — boot_snapshot=${bootOk} load_detail=${calledDetail} ` +
  `propose=${calledPropose} cited+detail_used=${citedAndUsedDetail} proposal_landed=${proposalLanded} use_events=${detailUses.length}`,
)
session.close()
process.exit(pass ? 0 : 1)
