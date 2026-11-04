import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAppServerManager } from "./codex-app-server"
import type { EngineRuntime } from "./model-access/runtime"

// Opt in to a real native binary. All prompts, credentials and completions are
// synthetic, and every model request goes to a loopback-only Responses fixture.
const binary = process.env.MEMOSYNC_CODEX_TEST_BIN
const nativeTest = binary ? test : test.skip
nativeTest("native Codex catalog overrides cannot erase injected developer memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "memosync-codex-context-"))
  const home = join(root, "home"), codexHome = join(root, "codex"), cwd = join(root, "project")
  for (const dir of [home, codexHome, cwd, join(root, "tmp")]) mkdirSync(dir)
  const requests: any[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    requests.push(await request.json())
    const index = requests.length
    const item = { type: "message", id: `msg_local_${index}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `LOCAL_REPLY_${index}`, annotations: [] }] }
    const response = { id: `resp_local_${index}`, object: "response", status: "completed", output: [item],
      usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } }
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  const model = "gpt-6-astra"
  // Synthetic catalog using the model_messages.collaboration_modes shape from
  // Codex source f79b26ccbb3116b052544666a181012fb45dc49b. No native prompt text.
  const catalog = join(root, "models.json")
  writeFileSync(catalog, JSON.stringify({ models: [{
    slug: model, display_name: "Local context fixture", description: "Synthetic offline model",
    default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Local" }],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 1,
    context_window: 272000, input_modalities: ["text"], supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true, default_reasoning_summary: "none", support_verbosity: true, default_verbosity: "low",
    apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [], prefer_websockets: false,
    model_messages: { instructions_template: "STABLE_NATIVE_BASE", persistent_instructions: "STABLE_NATIVE_PERSISTENT",
      collaboration_modes: { default: "NATIVE_DEFAULT_OVERRIDE", plan: "NATIVE_PLAN_OVERRIDE" } },
  }] }))
  writeFileSync(join(codexHome, "config.toml"), [
    `model = ${JSON.stringify(model)}`, 'model_provider = "offline"',
    `model_catalog_json = ${JSON.stringify(catalog)}`, 'developer_instructions = "CONFIGURED_NATIVE_DEVELOPER"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
    'check_for_update_on_startup = false', 'cli_auth_credentials_store = "ephemeral"', 'project_doc_max_bytes = 0',
    '[features]', 'plugins = false', 'remote_control = false',
    '[memories]', 'generate_memories = false', 'use_memories = false',
    '[model_providers.offline]', 'name = "Offline local fixture"', `base_url = "http://127.0.0.1:${server.port}/v1"`,
    'wire_api = "responses"', 'env_key = "OFFLINE_SYNTHETIC_KEY"', 'requires_openai_auth = false', 'supports_websockets = false',
  ].join("\n"))
  const runtime: EngineRuntime = { engine: "codex", executable: { state: "ready", path: binary! }, args: ["app-server"], model, isolated: true,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: join(root, "tmp"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
      OFFLINE_SYNTHETIC_KEY: "synthetic-local-only" } }
  const manager = new CodexAppServerManager()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const token = await manager.startSession({ chatId: "native-context", cwd, model, runtime, sessionToken: null, sandbox: "read-only", signal: controller.signal })
    for (const [index, developerInstructions] of ["MEMORY_A", "MEMORY_B"].entries()) {
      const turn = await manager.startTurn({ chatId: "native-context", model, content: `USER_${index}`, developerInstructions,
        effort: "low", planMode: index === 1, onToolRequest: async () => ({}), signal: controller.signal })
      const events: any[] = []
      const cancel = () => { void turn.interrupt() }
      controller.signal.addEventListener("abort", cancel, { once: true })
      try { for await (const event of turn.stream) events.push(event) }
      finally { controller.signal.removeEventListener("abort", cancel) }
      controller.signal.throwIfAborted()
      expect(events.find(e => e.type === "session_token")?.sessionToken).toBe(token)
      expect(events.at(-1)?.entry).toMatchObject({ kind: "result", subtype: "success" })
      expect(events.some(e => e.entry?.kind === "status" && e.entry.status.includes("without developer priority"))).toBe(false)
    }
    expect(requests).toHaveLength(2)
    const [a, b] = requests
    const developerText = (body: any) => JSON.stringify(body.input.filter((item: any) => item.role === "developer"))
    expect(developerText(a)).toContain("CONFIGURED_NATIVE_DEVELOPER")
    expect(developerText(a)).toContain("NATIVE_DEFAULT_OVERRIDE")
    expect(developerText(a)).toContain("MEMORY_A")
    expect(developerText(b)).toContain("NATIVE_PLAN_OVERRIDE")
    expect(developerText(b)).toContain("MEMORY_B")
    expect(b.input.slice(0, a.input.length)).toEqual(a.input)
    expect(JSON.stringify(b.input)).toContain("LOCAL_REPLY_1")
    expect(b.instructions).toEqual(a.instructions)
    expect(b.tools).toEqual(a.tools)
  } finally {
    clearTimeout(timer)
    await manager.stopAll()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
