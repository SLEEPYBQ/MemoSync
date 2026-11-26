import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAntigravityModels } from "./model-access/antigravity-account"
import { AntigravityAgentManager, translateAntigravityTool } from "./antigravity-agent"
import type { EngineRuntime } from "./model-access/runtime"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("antigravity account model parsing", () => {
  it("parses the CLI TSV catalog without inventing models", () => {
    expect(parseAntigravityModels("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6-medium\tClaude Sonnet 4.6 (Medium)\n")).toEqual([
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", supportsReasoning: true, supportsImages: true },
      { id: "claude-sonnet-4-6-medium", label: "Claude Sonnet 4.6 (Medium)", supportsReasoning: true, supportsImages: true },
    ])
  })
  it("translates observed snake_case tools into normalized Claude-shaped names", () => {
    expect(translateAntigravityTool("run_command", { CommandLine: "pwd" })).toMatchObject({ toolName: "Bash", input: { command: "pwd" } })
    expect(translateAntigravityTool("write_file", { Path: "/tmp/a", Content: "x" })).toMatchObject({ toolName: "Write", input: { file_path: "/tmp/a", content: "x" } })
    expect(translateAntigravityTool("mystery_tool", { x: 1 }).toolName).toBe("mystery_tool")
  })
})

describe("AntigravityAgentManager ACP streaming", () => {
  it("streams one session, assistant deltas and normalized tool lifecycle from a fixture ACP process", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-test-")); roots.push(root)
    const script = `let id=0
process.stdin.setEncoding('utf8')
let b=''
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'fixture',version:'1.5.18'}}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/prompt'){
 const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:u}})
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hel'}})
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'lo'}})
 update({sessionUpdate:'tool_call',toolCallId:'tool-1',name:'run_command',status:'in_progress',rawInput:{CommandLine:'echo hi'}})
 update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{stdout:'hi\\n'}})
 send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn',usage:{totalTokens:42,inputTokens:30,outputTokens:12}}})
}}})`
    const executable = join(root, "agy")
    writeFileSync(executable, `#!${process.execPath}\n${script}\n`)
    chmodSync(executable, 0o755)
    const runtime: EngineRuntime = { engine: "antigravity", executable: { state: "ready", path: executable, version: "1.5.18" }, env: {}, args: ["acp"], model: "gemini-3.8-flash-medium", isolated: false }
    const manager = new AntigravityAgentManager()
    try {
      const turn = await manager.startTurn({ chatId: "chat", cwd: root, content: "Say hello", model: runtime.model, runtime, executionPolicy: { engine: "antigravity", permission: "ask" } })
      const events = []
      for await (const event of turn.stream) events.push(event)
      expect(events[0]).toMatchObject({ type: "session_token", sessionToken: "fixture-session" })
      expect(events.filter(e => e.type === "assistant_delta").map(e => e.delta).join("")).toBe("Hello")
      const entries = events.filter(e => e.type === "transcript").map(e => e.entry)
      expect(entries.find(e => e?.kind === "assistant_text")).toMatchObject({ text: "Hello" })
      expect(entries.find(e => e?.kind === "tool_call")).toMatchObject({ tool: { toolKind: "bash", input: { command: "echo hi" } } })
      expect(entries.find(e => e?.kind === "tool_result")).toMatchObject({ toolId: "tool-1" })
      expect(entries.at(-1)).toMatchObject({ kind: "result", subtype: "success" })
    } finally { await manager.dispose() }
  }, 10000)
})
