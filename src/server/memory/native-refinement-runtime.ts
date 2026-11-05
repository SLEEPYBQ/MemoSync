import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  NativeModelSelection,
  NativeTokenUsage,
} from "../../shared/native-memory";
import {
  resolveEngineRuntime,
  type EngineRuntime,
} from "../model-access/runtime";
import { executableLauncher } from "../model-access/launcher";
import { startOpencodeServer } from "../opencode-server";
import { buildRegistryModel } from "../pi-agent";
import { NativeMemoryError } from "./native-discovery";

export interface NativeModelRequest {
  model: NativeModelSelection;
  system: string;
  user: string;
  signal: AbortSignal;
}
export interface NativeModelResponse {
  value: Record<string, unknown>;
  usage?: NativeTokenUsage;
}
export type NativeModelCaller = (
  request: NativeModelRequest,
) => Promise<NativeModelResponse>;
export interface NativeRuntimeAudit {
  provider: string;
  ephemeral: boolean;
  memoryRead: false;
  memoryWrite: false;
  tools: false;
}
export function parseNativeModelJson(text: string): Record<string, unknown> {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "");
  const value = JSON.parse(clean);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-json");
  return value;
}
export const NATIVE_CODEX_CONFIG = {
  "memories.generate_memories": false,
  "memories.use_memories": false,
  "features.shell_tool": false,
  "features.view_image": false,
  "features.multi_agent": false,
  "features.plugins": false,
  "features.apps": false,
  "features.hooks": false,
  "features.multi_agent_v2": false,
  "features.deferred_executor": false,
  "features.code_mode": false,
  "features.send_message_to_user_async": false,
  "features.request_permissions_tool": false,
  "features.token_budget": false,
  "features.current_time_reminder": false,
  "features.sleep_tool": false,
  "features.image_generation": false,
  "features.tool_suggest": false,
  "tools.experimental_request_user_input.enabled": false,
  "tools.update_plan.enabled": false,
  "features.memories": false,
  web_search: "disabled",
  project_doc_max_bytes: 0,
  check_for_update_on_startup: false,
} as const;
/** Independent native runtimes, never a MemoSync chat or persistent analysis branch. */
export function createNativeModelCaller(
  deps: {
    resolve?: (model: NativeModelSelection) => Promise<EngineRuntime>;
    claudeQuery?: typeof query;
    audit?: (audit: NativeRuntimeAudit) => void;
    opencodeServer?: typeof startOpencodeServer;
  } = {},
): NativeModelCaller {
  return async (request) => {
    request.signal.throwIfAborted();
    const runtime = await (deps.resolve?.(request.model) ??
      resolveEngineRuntime({
        engine: request.model.provider,
        model: request.model.model,
        connectionId: request.model.connectionId,
      }));
    if (
      runtime.engine !== request.model.provider ||
      runtime.model.replace(/\[1m\]$/, "") !==
        request.model.model.replace(/\[1m\]$/, "")
    )
      throw new NativeMemoryError(
        409,
        "MODEL_MISMATCH",
        "Runtime did not select the requested model",
      );
    const dir = mkdtempSync(join(tmpdir(), "memosync-native-call-"));
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(480_000),
    ]);
    deps.audit?.({
      provider: runtime.engine,
      ephemeral: true,
      memoryRead: false,
      memoryWrite: false,
      tools: false,
    });
    try {
      if (runtime.engine === "codex")
        return await codexCall(runtime, { ...request, signal }, dir);
      if (runtime.engine === "claude")
        return await claudeCall(
          runtime,
          { ...request, signal },
          dir,
          deps.claudeQuery ?? query,
        );
      if (runtime.engine === "pi")
        return await piCall(runtime, { ...request, signal }, dir);
      return await opencodeCall(
        runtime,
        { ...request, signal },
        dir,
        deps.opencodeServer,
      );
    } catch (error) {
      if (signal.aborted && !request.signal.aborted)
        throw new NativeMemoryError(
          504,
          "NATIVE_TIMEOUT",
          "Native refinement exceeded its deadline",
        );
      if (request.signal.aborted)
        throw new NativeMemoryError(
          409,
          "CANCELLED",
          "Native refinement cancelled",
        );
      if (error instanceof NativeMemoryError) throw error;
      // Native errors can quote prompts or credentials. Never persist their text.
      throw new NativeMemoryError(
        502,
        "NATIVE_CALL_FAILED",
        "Native model call failed; check model availability and ephemeral-runtime support",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
async function claudeCall(
  runtime: EngineRuntime,
  request: NativeModelRequest,
  dir: string,
  run: typeof query,
): Promise<NativeModelResponse> {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  // Strictly replace settings and MCP sources; no native memory or project instructions.
  const options: Options = {
    cwd: dir,
    model: runtime.model,
    systemPrompt: request.system,
    env: {
      ...runtime.env,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    tools: [],
    allowedTools: [],
    disallowedTools: ["*"],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    settings: { disableAllHooks: true },
    persistSession: false,
    enableFileCheckpointing: false,
    maxTurns: 1,
    permissionMode: "dontAsk",
    canUseTool: async () => ({
      behavior: "deny",
      message: "Tools disabled for native-memory refinement",
    }),
    abortController,
    stderr: () => {},
    ...(runtime.executable.path
      ? { pathToClaudeCodeExecutable: runtime.executable.path }
      : {}),
    ...(request.model.effort
      ? { effort: request.model.effort as Options["effort"] }
      : {}),
  };
  let text = "",
    usage: NativeTokenUsage | undefined,
    completed = false;
  const stream = run({ prompt: request.user, options });
  try {
    for await (const event of stream) {
      request.signal.throwIfAborted();
      if (event.type === "assistant")
        for (const block of event.message.content) {
          if (block.type === "tool_use") throw new Error("unexpected-tool");
          if (block.type === "text") text += block.text;
        }
      if (event.type === "result") {
        if (event.subtype !== "success" || event.is_error)
          throw new Error("model-failed");
        completed = true;
        if (!text) text = event.result;
        usage = {
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cachedInputTokens: event.usage.cache_read_input_tokens,
        };
      }
    }
    if (!completed) throw new Error("incomplete");
    return { value: parseNativeModelJson(text), usage };
  } finally {
    stream.close();
    request.signal.removeEventListener("abort", abort);
  }
}
async function codexCall(
  runtime: EngineRuntime,
  request: NativeModelRequest,
  dir: string,
): Promise<NativeModelResponse> {
  const launcher =
    runtime.launcher ??
    (await executableLauncher(runtime.executable.path!, runtime.env));
  const overrides = Object.entries(NATIVE_CODEX_CONFIG).flatMap(([k, v]) => [
    "-c",
    `${k}=${JSON.stringify(v)}`,
  ]);
  const child = spawn(
    launcher.command,
    [...launcher.args, ...runtime.args, ...overrides],
    {
      cwd: dir,
      env: { ...runtime.env, RUST_LOG: "off" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let seq = 0,
    buffer = "",
    threadId = "",
    usage: NativeTokenUsage | undefined;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  let finish: ((v: NativeModelResponse) => void) | undefined,
    fail: ((e: Error) => void) | undefined;
  let text = "",
    finished = false;
  const completed = new Promise<NativeModelResponse>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Avoid an unhandled rejection during initialize/thread creation.
  void completed.catch(() => {});
  const rejectAll = () => {
    const error = new Error("codex-transport-ended");
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    fail?.(error);
  };
  const write = (v: unknown) => child.stdin!.write(JSON.stringify(v) + "\n");
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method, params });
    });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && !msg.method) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error)
          p?.reject(
            new NativeMemoryError(
              502,
              "NATIVE_RPC_REJECTED",
              "Native runtime rejected the ephemeral request",
            ),
          );
        else p?.resolve(msg.result);
        continue;
      }
      // No request is delegated to a user and no tool request is approved.
      if (msg.method && msg.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Tools and approvals are disabled" },
        });
        fail?.(new Error("unexpected-native-request"));
        continue;
      }
      if (
        msg.method === "item/completed" &&
        msg.params?.item?.type === "agentMessage"
      )
        text += msg.params.item.text ?? "";
      if (
        msg.method === "item/started" &&
        ![
          "userMessage",
          "agentMessage",
          "reasoning",
          "contextCompaction",
        ].includes(msg.params?.item?.type)
      )
        fail?.(new Error("unexpected-tool"));
      if (msg.method === "thread/tokenUsage/updated") {
        const t = msg.params?.tokenUsage?.total;
        if (t)
          usage = {
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            cachedInputTokens: t.cachedInputTokens,
            totalTokens: t.totalTokens,
          };
      }
      if (msg.method === "turn/completed") {
        finished = true;
        if (msg.params?.turn?.status !== "completed")
          fail?.(new Error("codex-turn-failed"));
        else
          try {
            finish?.({ value: parseNativeModelJson(text), usage });
          } catch {
            fail?.(
              new NativeMemoryError(
                502,
                "INVALID_MODEL_JSON",
                "Native model returned invalid JSON",
              ),
            );
          }
      }
    }
  });
  child.once("error", rejectAll);
  child.once("exit", () => {
    if (!finished) rejectAll();
  });
  const abort = () => {
    rejectAll();
    child.kill("SIGTERM");
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    await rpc("initialize", {
      clientInfo: { name: "memosync-native-refine", version: "2" },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized" });
    const config = await rpc("config/read", { includeLayers: false, cwd: dir });
    const disabled: Record<string, unknown> = { ...NATIVE_CODEX_CONFIG };
    // Recent Codex versions removed the apply_patch_freeform feature switch.
    // Preserve the selected model's actual metadata while removing every
    // model-advertised tool capability in a private, per-call catalog.
    const nativeHome =
      runtime.env.CODEX_HOME || join(runtime.env.HOME || homedir(), ".codex");
    const hostHome = join(homedir(), ".codex");
    const catalogPaths = [
      config?.config?.model_catalog_json,
      join(nativeHome, "models_cache.json"),
      join(nativeHome, "custom_models.json"),
      join(hostHome, "models_cache.json"),
      join(hostHome, "custom_models.json"),
    ];
    let selected: Record<string, unknown> | undefined;
    for (const path of catalogPaths) {
      if (typeof path !== "string") continue;
      try {
        const catalog = JSON.parse(readFileSync(path, "utf8"));
        selected = Array.isArray(catalog.models)
          ? catalog.models.find(
              (m: Record<string, unknown>) => m.slug === runtime.model,
            )
          : undefined;
        if (selected) break;
      } catch {}
    }
    if (!selected)
      throw new NativeMemoryError(
        503,
        "TOOLLESS_MODEL_METADATA_UNAVAILABLE",
        "Native model metadata is required to establish a tool-less Codex call",
      );
    const catalogPath = join(dir, "tool-less-model.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        models: [
          {
            ...selected,
            apply_patch_tool_type: null,
            experimental_supported_tools: [],
            include_skills_usage_instructions: false,
            include_plugin_usage_instructions: false,
            include_apps_usage_instructions: false,
            multi_agent_version: null,
            node_repl_disabled: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    disabled.model_catalog_json = catalogPath;
    for (const name of Object.keys(config?.config?.mcp_servers ?? {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name))
        throw new Error("unsupported-mcp-name");
      disabled[`mcp_servers.${name}.enabled`] = false;
    }
    const started = await rpc("thread/start", {
      model: runtime.model,
      cwd: dir,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: request.system,
      developerInstructions: "",
      config: disabled,
    });
    if (started.thread?.ephemeral !== true || started.thread?.path)
      throw new NativeMemoryError(
        502,
        "EPHEMERAL_UNCONFIRMED",
        "Native runtime did not confirm a pathless ephemeral thread",
      );
    threadId = started.thread.id;
    await rpc("turn/start", {
      threadId,
      model: runtime.model,
      input: [{ type: "text", text: request.user, text_elements: [] }],
      ...(request.model.effort ? { effort: request.model.effort } : {}),
    });
    return await completed;
  } finally {
    request.signal.removeEventListener("abort", abort);
    child.stdin?.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode) resolve();
      else {
        child.once("exit", () => resolve());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1000).unref();
      }
    });
  }
}
async function piCall(
  runtime: EngineRuntime,
  request: NativeModelRequest,
  dir: string,
): Promise<NativeModelResponse> {
  if (!runtime.piConnection) throw new Error("connection-required");
  const {
    ModelRuntime,
    SettingsManager,
    SessionManager,
    createAgentSession,
    createExtensionRuntime,
  } = await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_id, fn) => fn(undefined),
      delete: async () => {},
    },
    modelsPath: null,
  });
  modelRuntime.registerProvider("custom", { name: "MemoSync" });
  await modelRuntime.setRuntimeApiKey(
    "custom",
    runtime.piConnection.apiKey || "no-key",
  );
  const extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(),
    model: buildRegistryModel(runtime.piConnection, runtime.model),
    tools: [],
    noTools: "all",
    resourceLoader: {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => request.system,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    },
    ...(request.model.effort
      ? { thinkingLevel: request.model.effort as any }
      : {}),
  });
  let text = "",
    usage: NativeTokenUsage | undefined;
  const off = session.subscribe((event: any) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      text = (event.message.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      const u = event.message.usage;
      if (u)
        usage = {
          inputTokens: u.input,
          outputTokens: u.output,
          cachedInputTokens: u.cacheRead,
          totalTokens: u.totalTokens,
        };
    }
  });
  const abort = () => {
    void session.abort();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    await session.prompt(request.user);
    request.signal.throwIfAborted();
    return { value: parseNativeModelJson(text), usage };
  } finally {
    off();
    session.dispose();
    request.signal.removeEventListener("abort", abort);
  }
}
async function opencodeCall(
  runtime: EngineRuntime,
  request: NativeModelRequest,
  dir: string,
  startServer: typeof startOpencodeServer = startOpencodeServer,
): Promise<NativeModelResponse> {
  // OpenCode has no in-memory session API. A private disposable XDG database keeps
  // these sessions out of the account's history, and is erased after every call.
  const data = join(dir, "data");
  mkdirSync(join(data, "opencode"), { recursive: true });
  if (!runtime.connectionId) {
    const auth = join(
      runtime.env.XDG_DATA_HOME ||
        join(runtime.env.HOME || homedir(), ".local", "share"),
      "opencode",
      "auth.json",
    );
    if (existsSync(auth))
      copyFileSync(auth, join(data, "opencode", "auth.json"));
  }
  const env = { ...runtime.env };
  for (const name of Object.keys(env))
    if (name.startsWith("OPENCODE_")) delete env[name];
  const server = await startServer({
    executable: runtime.executable.path!,
    cwd: dir,
    env: {
      ...env,
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_STATE_HOME: join(dir, "state"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    config: {
      ...runtime.opencodeConfig,
      plugin: [],
      instructions: [],
      permission: { "*": "deny" },
      agent: {
        "native-refine": {
          mode: "primary",
          prompt: request.system,
          tools: { "*": false },
          permission: { "*": "deny" },
        },
      },
    },
    signal: request.signal,
  });
  const call = async (path: string, body: unknown) => {
    const res = await fetch(server.url + path, {
      method: "POST",
      headers: {
        authorization: server.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok) throw new Error("opencode-request-failed");
    return res.json() as Promise<any>;
  };
  try {
    const session = await call("/session", {
      title: "Ephemeral native refinement",
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    });
    const selected = runtime.connectionId
      ? `memosync/${runtime.model}`
      : runtime.model;
    const slash = selected.indexOf("/");
    if (slash < 1) throw new Error("provider-model-required");
    const result = await call(`/session/${session.id}/message`, {
      model: {
        providerID: selected.slice(0, slash),
        modelID: selected.slice(slash + 1),
      },
      agent: "native-refine",
      system: request.system,
      tools: { "*": false },
      parts: [{ type: "text", text: request.user }],
      ...(request.model.effort ? { variant: request.model.effort } : {}),
    });
    if (result.parts?.some((p: any) => p.type === "tool") || result.info?.error)
      throw new Error("opencode-failed");
    const text = (result.parts ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    const t = result.info?.tokens;
    return {
      value: parseNativeModelJson(text),
      usage: t
        ? {
            inputTokens: t.input,
            outputTokens: t.output,
            cachedInputTokens: t.cache?.read,
          }
        : undefined,
    };
  } finally {
    await server.close();
  }
}
