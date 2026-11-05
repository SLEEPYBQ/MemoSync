import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeModelCaller } from "./native-refinement-runtime";
import type { EngineRuntime } from "../model-access/runtime";

it("confirms a pathless ephemeral Codex thread, disables configured MCP, rejects native tools, and records usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-fake-rpc-")),
    script = join(dir, "fake.ts"),
    trace = join(dir, "trace.jsonl");
  writeFileSync(
    join(dir, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "synthetic",
          display_name: "Synthetic",
          apply_patch_tool_type: "freeform",
          experimental_supported_tools: ["clock"],
        },
      ],
    }),
  );
  writeFileSync(
    script,
    `import{appendFileSync}from'node:fs';let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);const m=JSON.parse(line);if(m.method==='thread/start')m.syntheticCatalog=JSON.parse(require('node:fs').readFileSync(m.params.config.model_catalog_json,'utf8'));appendFileSync(process.env.SYNTHETIC_TRACE!,JSON.stringify(m)+'\\n');if(!m.id)continue;let result:any={};if(m.method==='config/read')result={config:{mcp_servers:{synthetic:{enabled:true}}}};if(m.method==='thread/start')result={thread:{id:'ephemeral-test',ephemeral:true,path:null}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({method:'item/completed',params:{item:{type:'agentMessage',text:'{"units":[]}'}}}));console.log(JSON.stringify({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:9,outputTokens:2,totalTokens:11}}}}));console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));}}});`,
  );
  const runtime: EngineRuntime = {
    engine: "codex",
    model: "synthetic",
    executable: { state: "ready", path: process.execPath },
    launcher: { command: process.execPath, args: [] },
    args: [script],
    env: { ...process.env, SYNTHETIC_TRACE: trace, CODEX_HOME: dir },
    isolated: true,
  };
  try {
    const result = await createNativeModelCaller({
      resolve: async () => runtime,
    })({
      model: { provider: "codex", model: "synthetic" },
      system: "Synthetic system",
      user: "Synthetic user",
      signal: new AbortController().signal,
    });
    expect(result.usage?.totalTokens).toBe(11);
    const messages = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
      start = messages.find((m) => m.method === "thread/start");
    expect(start.params.ephemeral).toBe(true);
    expect(start.syntheticCatalog.models[0].apply_patch_tool_type).toBeNull();
    expect(
      start.syntheticCatalog.models[0].experimental_supported_tools,
    ).toEqual([]);
    expect(start.params.config["features.hooks"]).toBe(false);
    expect(start.params.baseInstructions).toBe("Synthetic system");
    expect(start.params.config["mcp_servers.synthetic.enabled"]).toBe(false);
    expect(start.params.config["memories.generate_memories"]).toBe(false);
    expect(start.params.config["memories.use_memories"]).toBe(false);
    expect(messages.some((m) => /resume|fork/.test(m.method ?? ""))).toBe(
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("runs the native Pi SDK entirely in memory with no tools against a synthetic loopback endpoint", async () => {
  let toolCount = -1;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as any;
      toolCount = body.tools?.length ?? 0;
      const completion = {
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: "synthetic",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: '{"units":[]}' },
            finish_reason: null,
          },
        ],
      };
      const done = {
        ...completion,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      };
      return new Response(
        `data: ${JSON.stringify(completion)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const runtime: EngineRuntime = {
    engine: "pi",
    model: "synthetic",
    args: [],
    env: {},
    isolated: true,
    executable: { state: "not-needed" },
    piConnection: {
      provider: "custom",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "synthetic-loopback-only",
      protocol: "openai-chat",
    },
  };
  try {
    const result = await createNativeModelCaller({
      resolve: async () => runtime,
    })({
      model: { provider: "pi", model: "synthetic" },
      system: "Synthetic system",
      user: "Synthetic user",
      signal: new AbortController().signal,
    });
    expect(result.value.units).toEqual([]);
    expect(toolCount).toBe(0);
  } finally {
    server.stop(true);
  }
}, 15000);

it("isolates OpenCode history/config, disables plugins and tools, and removes the private profile", async () => {
  let launch: any,
    sessionBody: any,
    promptBody: any,
    closed = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/session") {
        sessionBody = await req.json();
        return Response.json({ id: "synthetic-session" });
      }
      promptBody = await req.json();
      return Response.json({
        parts: [{ type: "text", text: '{"units":[]}' }],
        info: { tokens: { input: 3, output: 2 } },
      });
    },
  });
  const runtime: EngineRuntime = {
    engine: "opencode",
    model: "synthetic",
    connectionId: "loopback-only",
    env: {
      OPENCODE_CONFIG: "/outside/config.json",
      OPENCODE_CONFIG_DIR: "/outside",
      MEMOSYNC_MODEL_API_KEY: "synthetic-only",
    },
    args: [],
    isolated: true,
    executable: { state: "ready", path: "/synthetic/opencode" },
    opencodeConfig: { provider: { memosync: {} } },
  };
  const caller = createNativeModelCaller({
    resolve: async () => runtime,
    opencodeServer: (async (args: any) => {
      launch = args;
      return {
        url: `http://127.0.0.1:${server.port}`,
        authorization: "synthetic-only",
        close: async () => {
          closed = true;
        },
      };
    }) as any,
  });
  try {
    await caller({
      model: {
        provider: "opencode",
        model: "synthetic",
        connectionId: "loopback-only",
      },
      system: "Synthetic system",
      user: "Synthetic source",
      signal: new AbortController().signal,
    });
    expect(launch.env.OPENCODE_CONFIG).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(launch.env.XDG_DATA_HOME.startsWith(launch.cwd)).toBe(true);
    expect(launch.config.plugin).toEqual([]);
    expect(launch.config.permission).toEqual({ "*": "deny" });
    expect(promptBody.tools).toEqual({ "*": false });
    expect(sessionBody.permission[0].action).toBe("deny");
    expect(closed).toBe(true);
    expect(await Bun.file(launch.cwd).exists()).toBe(false);
  } finally {
    server.stop(true);
  }
});
