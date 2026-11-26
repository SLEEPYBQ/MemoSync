import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { parseAntigravityModels, probeAntigravityAccount } from "./model-access/antigravity-account"
import { AntigravityAgentManager, translateAntigravityTool } from "./antigravity-agent"
import { resolveEngineRuntime, type EngineRuntime } from "./model-access/runtime"
import { cleanConnectionEnv, executableEnvironment } from "./model-access/legacy"
import { knownInstallDirectories } from "./model-access/discovery-paths"
import { executableLauncher } from "./model-access/launcher"
import { ModelAccessService } from "./model-access/service"
import { fakeExecutableResolver, testKeyring } from "./model-access/test-fixtures"
import { isRuntimeCommandSelection } from "../shared/runtime-commands"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { deriveSidebarData } from "./read-models"
import { MemoryService } from "./memory"
import { createMemoryBranch } from "./memory/branch-runtime"
import { createCaptureService } from "./memory/capture"
import { createCheckupService } from "./memory/checkup"
import { createTransferService } from "./memory/transfer"
import { createTransferDetectService } from "./memory/transfer-detect"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function writeAcpFixture(root: string, body: string): EngineRuntime {
  const executable = join(root, `agy-${crypto.randomUUID().slice(0, 8)}`)
  writeFileSync(executable, `#!${process.execPath}\n${body}\n`)
  chmodSync(executable, 0o755)
  return {
    engine: "antigravity",
    executable: { state: "ready", path: executable, version: "1.5.18" },
    env: {},
    args: ["acp"],
    model: "gemini-3.8-flash-medium",
    isolated: false,
  }
}

describe("antigravity account model parsing and probing", () => {
  it("parses the CLI TSV catalog without inventing models", () => {
    expect(parseAntigravityModels("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6-medium\tClaude Sonnet 4.6 (Medium)\n")).toEqual([
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", supportsReasoning: true, supportsImages: true },
      { id: "claude-sonnet-4-6-medium", label: "Claude Sonnet 4.6 (Medium)", supportsReasoning: true, supportsImages: true },
    ])
  })

  it("translates observed snake_case tools and ask_question options into normalized Claude-shaped names", () => {
    expect(translateAntigravityTool("run_command", { CommandLine: "pwd" })).toMatchObject({ toolName: "Bash", input: { command: "pwd" } })
    expect(translateAntigravityTool("write_file", { Path: "/tmp/a", Content: "x" })).toMatchObject({ toolName: "Write", input: { file_path: "/tmp/a", content: "x" } })
    expect(translateAntigravityTool("read_file", { Path: "/tmp/a", StartLine: 1, EndLine: 10 })).toMatchObject({ toolName: "Read", input: { file_path: "/tmp/a", offset: 1, limit: 10 } })
    expect(translateAntigravityTool("edit_file", { Path: "/tmp/a", Target: "old", Replacement: "new" })).toMatchObject({ toolName: "Edit", input: { file_path: "/tmp/a", old_string: "old", new_string: "new" } })
    expect(translateAntigravityTool("ask_question", {
      questions: [{ question: "Pick one", options: ["Alpha", "Beta"], is_multi_select: true }],
    })).toEqual({
      toolName: "AskUserQuestion",
      input: {
        questions: [{
          question: "Pick one",
          multiSelect: true,
          options: [{ label: "Alpha" }, { label: "Beta" }],
        }],
      },
    })
    expect(translateAntigravityTool("mystery_tool", { x: 1 }).toolName).toBe("mystery_tool")
  })

  it("handles spawn error events in probeAntigravityAccount without unhandled exceptions", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-probe-")); roots.push(root)
    const missing = join(root, "does-not-exist-agy")
    const result = await probeAntigravityAccount(missing, {})
    expect(result.accountModels).toEqual([])
    expect(result.problem).toBe("account-config-invalid")
    expect(result.problemDetail).toBeTruthy()
  })
})

describe("AntigravityAgentManager ACP streaming and security invariants", () => {
  it("streams one session, assistant deltas and normalized tool lifecycle from a fixture ACP process", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-test-")); roots.push(root)
    const runtime = writeAcpFixture(root, `
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
}}})`)
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

  it("maps ACP plan updates to TodoWrite and gates successful plan turns on ExitPlanMode", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-plan-")); roots.push(root)
    const runtime = writeAcpFixture(root, `
process.stdin.setEncoding('utf8')
let b=''
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'plan-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/prompt'){
 send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'plan_update',plan:{type:'items',planId:'p',entries:[{content:'Inspect',status:'completed',priority:'high'},{content:'Implement',status:'in_progress',priority:'high'}]}}}})
 send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      let asked = false
      const turn = await manager.startTurn({ chatId: "plan-chat", cwd: root, content: "Plan", model: runtime.model, runtime, planMode: true, onToolRequest: async ({ tool }) => { asked = tool.toolKind === "exit_plan_mode"; return { confirmed: true } } })
      const entries = []
      for await (const event of turn.stream) if (event.type === "transcript" && event.entry) entries.push(event.entry)
      const kinds = entries.filter(e => e.kind === "tool_call").map(e => e.kind === "tool_call" ? e.tool.toolKind : "")
      expect(kinds).toEqual(["todo_write", "exit_plan_mode"])
      expect(asked).toBe(true)
      expect(entries.at(-1)).toMatchObject({ kind: "result", subtype: "success" })
    } finally { await manager.dispose() }
  }, 10000)

  it("never upgrades permission scope from allow_once to allow_always when no one-time option exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-perm-")); roots.push(root)
    const outcomesFile = join(root, "outcomes.json")
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b=''
const outcomes = []
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
let promptId = null
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line)
if(!m.method && m.id !== undefined){
  outcomes.push({ id: m.id, result: m.result })
  if(outcomes.length === 3){
    fs.writeFileSync(${JSON.stringify(outcomesFile)}, JSON.stringify(outcomes))
    send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})
  }
  continue
}
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'perm-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/prompt'){
  promptId = m.id
  send({jsonrpc:'2.0',id:'p1',method:'session/request_permission',params:{sessionId:'perm-session',toolCall:{toolCallId:'call-1',name:'write_file',rawInput:{Path:'a.txt',Content:'1'}},options:[{optionId:'always-1',name:'Always allow',kind:'allow_always'},{optionId:'deny-once-1',name:'Deny once',kind:'reject_once'}]}})
  send({jsonrpc:'2.0',id:'p2',method:'session/request_permission',params:{sessionId:'perm-session',toolCall:{toolCallId:'call-2',name:'write_file',rawInput:{Path:'b.txt',Content:'2'}},options:[{optionId:'always-2',name:'Always allow',kind:'allow_always'}]}})
  send({jsonrpc:'2.0',id:'p3',method:'session/request_permission',params:{sessionId:'perm-session',toolCall:{toolCallId:'call-3',name:'write_file',rawInput:{Path:'c.txt',Content:'3'}},options:[{optionId:'once-3',name:'Allow once',kind:'allow_once'},{optionId:'always-3',name:'Always allow',kind:'allow_always'}]}})
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      const turn = await manager.startTurn({
        chatId: "perm-chat",
        cwd: root,
        content: "Write files",
        model: runtime.model,
        runtime,
        executionPolicy: { engine: "antigravity", permission: "ask" },
        onPermissionRequest: async () => true,
      })
      for await (const _event of turn.stream) { /* drain */ }
      const outcomes = JSON.parse(readFileSync(outcomesFile, "utf8")) as Array<{ id: string; result: { outcome: { outcome: string; optionId?: string } } }>
      expect(outcomes.find(o => o.id === "p1")?.result.outcome).toEqual({ outcome: "selected", optionId: "deny-once-1" })
      expect(outcomes.find(o => o.id === "p2")?.result.outcome).toEqual({ outcome: "cancelled" })
      expect(outcomes.find(o => o.id === "p3")?.result.outcome).toEqual({ outcome: "selected", optionId: "once-3" })
    } finally { await manager.dispose() }
  }, 10000)

  it("propagates startup cancellation so session/prompt is never written after abort", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-abort-")); roots.push(root)
    const methods: string[] = []
    const controller = new AbortController()
    const spawnFake = (() => {
      const child = new EventEmitter() as any
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      child.stdin = stdin
      child.stdout = stdout
      child.stderr = stderr
      child.pid = undefined
      child.kill = () => { child.emit("close", 0); return true }
      let buf = ""
      stdin.setEncoding("utf8")
      stdin.on("data", (chunk: string) => {
        buf += chunk
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          const msg = JSON.parse(line)
          if (msg.method) methods.push(msg.method)
          if (msg.method === "initialize") stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } })}\n`)
          if (msg.method === "session/new") stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-abort" } })}\n`)
          if (msg.method === "session/set_config_option") {
            if (msg.params.configId === "mode") controller.abort(new Error("User hit stop during startup"))
            stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: msg.params.configId, currentValue: msg.params.value }] } })}\n`)
          }
        }
      })
      return child
    }) as any
    const executable = join(root, "agy")
    writeFileSync(executable, "#!/bin/sh\n")
    chmodSync(executable, 0o755)
    const runtime: EngineRuntime = { engine: "antigravity", executable: { state: "ready", path: executable, version: "1.5.18" }, env: {}, args: ["acp"], model: "gemini-3.8-flash-medium", isolated: false }
    const manager = new AntigravityAgentManager(spawnFake)
    try {
      await expect(manager.startTurn({ chatId: "abort-chat", cwd: root, content: "Should not send", model: runtime.model, runtime, signal: controller.signal })).rejects.toThrow("User hit stop")
      expect(methods).not.toContain("session/prompt")
    } finally { await manager.dispose() }
  })

  it("publishes AskUserQuestion for interaction_* requests and degrades cleanly when options are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-question-")); roots.push(root)
    const outcomesFile = join(root, "question-outcomes.json")
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b='', promptId=null
const outcomes=[]
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line)
if(!m.method && m.id !== undefined){
  outcomes.push({ id: m.id, result: m.result })
  if(outcomes.length === 2){
    fs.writeFileSync(${JSON.stringify(outcomesFile)}, JSON.stringify(outcomes))
    send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})
  }
  continue
}
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'q-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/prompt'){
  promptId = m.id
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'q-session',update:{sessionUpdate:'tool_call',toolCallId:'interaction_1',status:'pending',title:'Choose target'}}})
  send({jsonrpc:'2.0',id:'q1',method:'session/request_permission',params:{sessionId:'q-session',toolCall:{toolCallId:'interaction_1',title:'Choose target'},options:[{optionId:'opt_staging',name:'Staging'},{optionId:'opt_prod',name:'Production'}]}})
  send({jsonrpc:'2.0',id:'q2',method:'session/request_permission',params:{sessionId:'q-session',toolCall:{toolCallId:'interaction_2',title:'Empty options question'},options:[]}})
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      const seenTools: string[] = []
      const turn = await manager.startTurn({
        chatId: "q-chat",
        cwd: root,
        content: "Ask me",
        model: runtime.model,
        runtime,
        onToolRequest: async ({ tool }) => {
          seenTools.push(tool.toolKind)
          return { answers: { interaction_1: ["Production"] } }
        },
      })
      const entries = []
      for await (const event of turn.stream) if (event.type === "transcript" && event.entry) entries.push(event.entry)
      expect(seenTools).toEqual(["ask_user_question"])
      const toolCalls = entries.filter(e => e.kind === "tool_call")
      expect(toolCalls.some(e => e.kind === "tool_call" && e.tool.toolKind === "unknown_tool")).toBe(false)
      expect(toolCalls[0]).toMatchObject({
        kind: "tool_call",
        tool: {
          toolKind: "ask_user_question",
          toolId: "interaction_1",
          input: { questions: [{ id: "interaction_1", question: "Choose target", options: [{ label: "Staging" }, { label: "Production" }] }] },
        },
      })
      const degradedResult = entries.find(e => e.kind === "tool_result" && e.toolId === "interaction_2")
      expect(degradedResult).toMatchObject({ kind: "tool_result", toolId: "interaction_2", isError: true })
      const outcomes = JSON.parse(readFileSync(outcomesFile, "utf8"))
      expect(outcomes).toEqual([
        { id: "q1", result: { outcome: { outcome: "selected", optionId: "opt_prod" } } },
        { id: "q2", result: { outcome: { outcome: "cancelled" } } },
      ])
    } finally { await manager.dispose() }
  }, 10000)

  it("discovers ACP slash commands through getCommandRuntime and accepts antigravity runtime selections", async () => {
    expect(isRuntimeCommandSelection({ provider: "antigravity", model: "gemini-3.8-flash-medium", planMode: true, modelOptions: { antigravity: {} } })).toBe(true)
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-cmds-")); roots.push(root)
    const runtime = writeAcpFixture(root, `
process.stdin.setEncoding('utf8')
let b=''
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new'){
  send({jsonrpc:'2.0',id:m.id,result:{sessionId:'cmd-session'}})
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'cmd-session',update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'plan',description:'Plan task'},{name:'compact',description:'Compact'}]}}})
}
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
}})`)
    const manager = new AntigravityAgentManager()
    try {
      const sessionId = await manager.prepareSession({ chatId: "cmd-chat", cwd: root, model: runtime.model, runtime })
      expect(sessionId).toBe("cmd-session")
      const native = manager.getCommandRuntime("cmd-chat")!
      expect(native.alive()).toBe(true)
      const discovered = await native.discover()
      expect(discovered.commands.status).toBe("ready")
      expect(discovered.commands.items.map(c => c.name)).toContain("plan")
      expect(discovered.skills.status).toBe("unsupported")
      expect(discovered.connectors.status).toBe("unsupported")
    } finally { await manager.dispose() }
  }, 10000)

  it("rejects fork atomically, reports harnessNativeRuntime present, and completes default memory preparation with per-turn context", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-coord-")); roots.push(root)
    const promptsFile = join(root, "prompts.json")
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b='', n=0
const prompts=[]
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'agy-ses-'+(++n)}})
if(m.method==='session/resume') send({jsonrpc:'2.0',id:m.id,result:{sessionId:m.params.sessionId}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/prompt'){
  const text = m.params.prompt.map(p => p.text).join('\\n')
  prompts.push({ sessionId: m.params.sessionId, text })
  fs.writeFileSync(${JSON.stringify(promptsFile)}, JSON.stringify(prompts))
  let reply = 'Main turn reply [M-01]'
  if(text.includes('REVIEW DECISION:')) {
    reply = text.includes('upsert.suggestions')
      ? JSON.stringify({ upsert: { suggestions: [] }, remove: { suggestions: [] } })
      : JSON.stringify({ upsert: { conflicts: [], redundancy: [], staleness: [] }, remove: { conflicts: [], redundancy: [], staleness: [] } })
  } else if(text.includes('CANDIDATE EXTRACTION')) reply = JSON.stringify({ candidates: [] })
  else if(text.includes('TRANSFER SUGGESTIONS')) reply = JSON.stringify({ suggestions: [] })
  else if(text.includes('MEMORY CHANGES')) reply = JSON.stringify({ conflicts: [], redundancy: [], staleness: [] })
  else if(text.includes('POST-TURN AUDIT')) reply = JSON.stringify({ labels: [{ id: 'M-01', label: 'operational', note: 'Followed rule', quote: 'Main turn reply', toolId: null, cause: null, missing: null, impact: null }], summary: 'Followed [M-01].' })
  else if(text.includes('"selected"')) reply = JSON.stringify({ selected: [{ id: 'M-01', why: 'Project rule', expectedUse: 'Follow the integer cents rule.' }], reply: 'Selected project rule.' })
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:reply}}}})
  send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
}}})`)
    const store = new EventStore(join(root, "events"))
    await store.initialize()
    const project = await store.openProject(root, "Agy Project")
    const chat = await store.createChat(project.id)
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: join(root, "memory") })
    const saved = memory.store.create({
      content: "Use integer cents for currency",
      detail: "Never store currency values as IEEE-754 floats; represent USD amounts in integer cents.",
      type: "constraint",
      scope: "project",
      projectId: project.id,
    }, { actor: "user" })
    const antigravityManager = new AntigravityAgentManager()
    const failSidecar = async () => { throw new Error("Unexpected sidecar") }
    const coordinator = new AgentCoordinator({
      store,
      memory,
      antigravityManager,
      memoryBranches: true,
      memoryPreview: true,
      capture: createCaptureService({ memory, callJson: failSidecar }),
      memoryCheckup: createCheckupService({ memory, callJson: failSidecar, listRecentSessions: () => [] }),
      memoryTransferDetect: createTransferDetectService({ memory, callJson: failSidecar, transfer: createTransferService({ callJson: failSidecar }), listRecentSessions: () => [], listProjects: () => [] }),
      createMemoryBranch: input => createMemoryBranch({ ...input, runtime }, { antigravityManager }),
      generateTitle: async () => ({ title: "Agy Chat", usedFallback: true, failureMessage: null }),
      onStateChange: () => {},
    })
    ;(coordinator as any).sessionRuntimes.set(chat.id, runtime)
    ;(coordinator as any).runtimeSelections.set(chat.id, JSON.stringify(["antigravity", runtime.model, undefined, undefined]))
    try {
      await coordinator.send({ type: "chat.send", chatId: chat.id, provider: "antigravity", model: runtime.model, content: "Compute order total" })
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const preview = store.getMessages(chat.id).find(m => m.kind === "memory_preview")
        const relevance = store.getMessages(chat.id).find(m => m.kind === "memory_preview_relevance")
        if (preview && relevance) {
          await coordinator.respondMemoryPreview({ chatId: chat.id, previewId: preview.previewId, decision: "go_on", memoryIds: [saved.id] })
          break
        }
        await Bun.sleep(10)
      }
      while (Date.now() < deadline) {
        const result = store.getMessages(chat.id).find(m => m.kind === "result")
        if (result) break
        await Bun.sleep(10)
      }
      const messages = store.getMessages(chat.id)
      expect(messages.find(m => m.kind === "result")).toMatchObject({ kind: "result", subtype: "success", isError: false })
      expect(coordinator.getHarnessSnapshot(chat.id, "antigravity")).toMatchObject({
        nativeRuntime: "present",
        policy: { status: "applied", effectiveRevision: 1 },
      })
      const sidebar = deriveSidebarData(store.state, coordinator.getActiveStatuses(), { drainingChatIds: coordinator.getDrainingChatIds() })
      expect(sidebar.projectGroups[0]?.chats[0]?.canFork).toBeUndefined()
      await expect(coordinator.forkChat(chat.id)).rejects.toThrow("Antigravity chats cannot be forked")
      await expect(store.forkChat(chat.id)).rejects.toThrow("Chat cannot be forked")
      expect(store.listChats()).toHaveLength(1)
      const prompts = JSON.parse(readFileSync(promptsFile, "utf8")) as Array<{ sessionId: string; text: string }>
      const mainPrompt = prompts.find(p => p.text.includes("Compute order total"))
      expect(mainPrompt?.text).toContain("Use integer cents for currency")
      expect(mainPrompt?.text).toContain("Never store currency values as IEEE-754 floats")
      expect(mainPrompt?.text).not.toContain("load_memory_detail")
    } finally {
      await coordinator.shutdownRuntime()
      memory.close()
    }
  }, 15000)

  it("F-05: interleaves multi-step assistant_text across tool calls and preserves streamed prose on mid-turn failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-f05-")); roots.push(root)
    const runtime = writeAcpFixture(root, `
process.stdin.setEncoding('utf8')
let b='', turn=0
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'f05-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}})
if(m.method==='session/prompt'){
  turn++
  const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:u}})
  if(turn===1){
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Checking '}})
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'config.'}})
    update({sessionUpdate:'tool_call',toolCallId:'t-read',name:'read_file',status:'in_progress',rawInput:{Path:'/tmp/cfg.json'}})
    update({sessionUpdate:'tool_call_update',toolCallId:'t-read',status:'completed',rawOutput:'{"ok":true}'})
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Applying fix.'}})
    update({sessionUpdate:'tool_call',toolCallId:'t-edit',name:'edit_file',status:'in_progress',rawInput:{Path:'/tmp/cfg.json',Target:'true',Replacement:'false'}})
    update({sessionUpdate:'tool_call_update',toolCallId:'t-edit',status:'completed',rawOutput:'edited'})
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}})
    send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
  } else {
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Partial diagnosis before crash.'}})
    update({sessionUpdate:'tool_call',toolCallId:'t-hang',name:'run_command',status:'in_progress',rawInput:{CommandLine:'make test'}})
    send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Upstream stream died'}})
  }
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      const turn1 = await manager.startTurn({ chatId: "f05-chat", cwd: root, content: "Step turn", model: runtime.model, runtime })
      const events1 = []
      for await (const event of turn1.stream) events1.push(event)
      const deltaIds = [...new Set(events1.filter(e => e.type === "assistant_delta").map(e => e.itemId))]
      expect(deltaIds).toEqual(["agent-message-1", "agent-message-2", "agent-message-3"])
      const kinds1 = events1
        .filter(e => e.type === "transcript" && e.entry && e.entry.kind !== "system_init")
        .map(e => e.entry!.kind === "assistant_text" ? `text:${e.entry!.text}` : e.entry!.kind === "tool_call" ? `call:${e.entry!.tool.toolKind}` : e.entry!.kind === "tool_result" ? `result:${e.entry!.toolId}` : e.entry!.kind)
      expect(kinds1).toEqual([
        "text:Checking config.",
        "call:read_file",
        "result:t-read",
        "text:Applying fix.",
        "call:edit_file",
        "result:t-edit",
        "text:Done.",
        "result",
      ])

      const turn2 = await manager.startTurn({ chatId: "f05-chat", cwd: root, content: "Failing turn", model: runtime.model, runtime, sessionToken: "f05-session" })
      const entries2 = []
      for await (const event of turn2.stream) if (event.type === "transcript" && event.entry) entries2.push(event.entry)
      const kinds2 = entries2.filter(e => e.kind !== "system_init").map(e => e.kind)
      expect(kinds2).toEqual(["assistant_text", "tool_call", "tool_result", "result"])
      expect(entries2.find(e => e.kind === "assistant_text")).toMatchObject({ text: "Partial diagnosis before crash." })
      expect(entries2.find(e => e.kind === "tool_result")).toMatchObject({ toolId: "t-hang", isError: true })
      expect(entries2.at(-1)).toMatchObject({ kind: "result", subtype: "error", isError: true, result: "Upstream stream died" })
    } finally { await manager.dispose() }
  }, 10000)

  it("F-07: defers empty pending tool inputs, preserves current.name and string/ACP outputs, maps ACP kind/diff, and resolves cancelled tools", async () => {
    expect(translateAntigravityTool("unknown", {}, { kind: "read", locations: [{ path: "/repo/a.ts", line: 12 }] })).toEqual({
      toolName: "Read",
      input: { file_path: "/repo/a.ts", offset: 12, limit: undefined },
    })
    expect(translateAntigravityTool("unknown", {}, { kind: "edit", content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }] })).toEqual({
      toolName: "Edit",
      input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
    })
    expect(translateAntigravityTool("list_dir", { Path: "C:\\repo\\src\\" })).toEqual({
      toolName: "Glob",
      input: { pattern: "C:\\repo\\src/*" },
    })

    const root = mkdtempSync(join(tmpdir(), "memosync-agy-f07-")); roots.push(root)
    const runtime = writeAcpFixture(root, `
process.stdin.setEncoding('utf8')
let b='', promptId=null
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line)
if(!m.method && m.id === 'perm-deny'){
  send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})
  continue
}
if(!m.method) continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'f07-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}})
if(m.method==='session/prompt'){
  promptId = m.id
  const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'f07-session',update:u}})
  update({sessionUpdate:'tool_call',toolCallId:'t-pending',name:'grep_search',status:'pending',rawInput:{}})
  update({sessionUpdate:'tool_call_update',toolCallId:'t-pending',status:'in_progress',rawInput:{Pattern:'TODO'}})
  update({sessionUpdate:'tool_call_update',toolCallId:'t-pending',status:'completed',rawOutput:'src/a.ts:1:TODO'})
  update({sessionUpdate:'tool_call',toolCallId:'t-acp-read',kind:'read',status:'in_progress',locations:[{path:'/tmp/readme.md',line:1}]})
  update({sessionUpdate:'tool_call_update',toolCallId:'t-acp-read',status:'completed',content:[{type:'content',content:{type:'text',text:'# Hello'}}]})
  update({sessionUpdate:'tool_call',toolCallId:'t-cancel',name:'run_command',status:'in_progress',rawInput:{CommandLine:'sleep 5'}})
  update({sessionUpdate:'tool_call_update',toolCallId:'t-cancel',status:'cancelled'})
  update({sessionUpdate:'tool_call',toolCallId:'t-denied',name:'write_file',status:'pending',rawInput:{}})
  send({jsonrpc:'2.0',id:'perm-deny',method:'session/request_permission',params:{sessionId:'f07-session',toolCall:{toolCallId:'t-denied',name:'write_file',rawInput:{Path:'secret.txt',Content:'no'}},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'reject-once',name:'Deny',kind:'reject_once'}]}})
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      const seenPermissionIds: Array<unknown> = []
      const turn = await manager.startTurn({
        chatId: "f07-chat",
        cwd: root,
        content: "Run tools",
        model: runtime.model,
        runtime,
        onPermissionRequest: async request => {
          seenPermissionIds.push(request.id)
          return false
        },
      })
      const entries = []
      for await (const event of turn.stream) if (event.type === "transcript" && event.entry) entries.push(event.entry)
      expect(seenPermissionIds).toEqual(["perm-deny"])

      const grepCall = entries.find(e => e.kind === "tool_call" && e.tool.toolId === "t-pending")
      expect(grepCall).toMatchObject({ kind: "tool_call", tool: { toolKind: "grep", input: { pattern: "TODO" } } })
      const grepResult = entries.find(e => e.kind === "tool_result" && e.toolId === "t-pending")
      expect(grepResult).toMatchObject({ kind: "tool_result", content: "src/a.ts:1:TODO", isError: false })

      const readCall = entries.find(e => e.kind === "tool_call" && e.tool.toolId === "t-acp-read")
      expect(readCall).toMatchObject({ kind: "tool_call", tool: { toolKind: "read_file", input: { filePath: "/tmp/readme.md" } } })
      const readResult = entries.find(e => e.kind === "tool_result" && e.toolId === "t-acp-read")
      expect(readResult).toMatchObject({ kind: "tool_result", content: [{ type: "text", text: "# Hello" }], isError: false })

      const cancelResult = entries.find(e => e.kind === "tool_result" && e.toolId === "t-cancel")
      expect(cancelResult).toMatchObject({ kind: "tool_result", toolId: "t-cancel", isError: true })

      const deniedCall = entries.find(e => e.kind === "tool_call" && e.tool.toolId === "t-denied")
      expect(deniedCall).toMatchObject({ kind: "tool_call", tool: { toolKind: "write_file", input: { filePath: "secret.txt", content: "no" } } })
      const deniedResult = entries.find(e => e.kind === "tool_result" && e.toolId === "t-denied")
      expect(deniedResult).toMatchObject({ kind: "tool_result", toolId: "t-denied", isError: true, content: "Antigravity permission rejected" })
    } finally { await manager.dispose() }
  }, 10000)

  it("F-09: drains pipes on exit and enforces graceful session/cancel + session/close before process kill", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-f09-")); roots.push(root)
    const crashRuntime = writeAcpFixture(root, `
process.stderr.write('Fatal auth bootstrap error\\n')
process.exit(2)
`)
    const manager = new AntigravityAgentManager()
    try {
      await expect(manager.startTurn({ chatId: "crash-chat", cwd: root, content: "Hi", model: crashRuntime.model, runtime: crashRuntime }))
        .rejects.toThrow("Fatal auth bootstrap error")

      const logFile = join(root, "graceful-order.json")
      const gracefulRuntime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b='', promptId=null
const received=[]
const recordMethod=m=>{ received.push(m); fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(received)) }
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
recordMethod(m.method)
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'grace-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/prompt'){
  promptId = m.id
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'grace-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working...'}}}})
}
if(m.method==='session/cancel' && promptId !== null){
  send({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}})
}
if(m.method==='session/close'){
  send({jsonrpc:'2.0',id:m.id,result:{}})
}}})`)
      const turn = await manager.startTurn({ chatId: "grace-chat", cwd: root, content: "Long work", model: gracefulRuntime.model, runtime: gracefulRuntime })
      for await (const event of turn.stream) {
        if (event.type === "assistant_delta") {
          await turn.interrupt()
          break
        }
      }
      const received = JSON.parse(readFileSync(logFile, "utf8")) as string[]
      const cancelIdx = received.indexOf("session/cancel")
      const closeIdx = received.indexOf("session/close")
      expect(cancelIdx).toBeGreaterThanOrEqual(0)
      expect(closeIdx).toBeGreaterThan(cancelIdx)
    } finally { await manager.dispose() }
  }, 10000)

  it("F-10: replies -32601 to unhandled server requests, rejects id:null error frames, and splits >4 MiB multi-line bursts before checking residual buffer", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-f10-")); roots.push(root)
    const serverErrorsFile = join(root, "server-errors.json")
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b='', turn=0, promptId=null
const errors=[]
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line)
if(!m.method && m.error){
  errors.push({ id: m.id, code: m.error.code })
  fs.writeFileSync(${JSON.stringify(serverErrorsFile)}, JSON.stringify(errors))
  if(m.id === 'srv-in-turn' && promptId !== null){
    const pad = 'x'.repeat(600 * 1024)
    let burst = ''
    for(let k=0;k<8;k++){
      burst += JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'f10-session',update:{sessionUpdate:'usage_update',used:k+1,_pad:pad}}}) + '\\n'
    }
    burst += JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'f10-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Survived 4.8MB burst'}}}}) + '\\n'
    burst += JSON.stringify({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}}) + '\\n'
    process.stdout.write(burst)
  }
  continue
}
if(!m.method) continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new'){
  send({jsonrpc:'2.0',id:'srv-out-of-turn',method:'fs/read_text_file',params:{path:'/etc/hosts'}})
  send({jsonrpc:'2.0',id:m.id,result:{sessionId:'f10-session'}})
}
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}})
if(m.method==='session/prompt'){
  turn++
  promptId = m.id
  if(turn===1){
    send({jsonrpc:'2.0',id:'srv-in-turn',method:'elicitation/create',params:{message:'Unsupported RPC'}})
  } else {
    send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Malformed upstream JSON-RPC frame'}})
  }
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      const turn1 = await manager.startTurn({ chatId: "f10-chat", cwd: root, content: "Burst test", model: runtime.model, runtime })
      const entries1 = []
      for await (const event of turn1.stream) if (event.type === "transcript" && event.entry) entries1.push(event.entry)
      expect(entries1.find(e => e.kind === "assistant_text")).toMatchObject({ text: "Survived 4.8MB burst" })
      expect(entries1.at(-1)).toMatchObject({ kind: "result", subtype: "success", isError: false })
      const recordedErrors = JSON.parse(readFileSync(serverErrorsFile, "utf8"))
      expect(recordedErrors).toEqual([
        { id: "srv-out-of-turn", code: -32601 },
        { id: "srv-in-turn", code: -32601 },
      ])

      const turn2 = await manager.startTurn({ chatId: "f10-chat", cwd: root, content: "Null error test", model: runtime.model, runtime, sessionToken: "f10-session" })
      const entries2 = []
      for await (const event of turn2.stream) if (event.type === "transcript" && event.entry) entries2.push(event.entry)
      expect(entries2.at(-1)).toMatchObject({ kind: "result", subtype: "error", isError: true, result: "Malformed upstream JSON-RPC frame" })
    } finally { await manager.dispose() }
  }, 10000)

  it("F-15: skips redundant session/resume, preserves systemPrompt on cold resume, creates fresh session on context-clear, and blocks cross-cwd resumption", async () => {
    const projectA = mkdtempSync(join(tmpdir(), "memosync-agy-cwd-a-")); roots.push(projectA)
    const projectB = mkdtempSync(join(tmpdir(), "memosync-agy-cwd-b-")); roots.push(projectB)
    const callsFile = join(projectA, "rpc-calls.json")
    const runtime = writeAcpFixture(projectA, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b='', seq=0
const calls=[]
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
calls.push({ method: m.method, params: m.params })
fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls))
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{}}}}})
if(m.method==='session/list'){
  const all = [{ sessionId: 'foreign-disk-session', cwd: ${JSON.stringify(projectB)} }]
  const filtered = m.params.cwd ? all.filter(s => s.cwd === m.params.cwd) : all
  send({jsonrpc:'2.0',id:m.id,result:{sessions:filtered}})
}
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'ses-'+(++seq)}})
if(m.method==='session/resume'){
  if(m.params.sessionId === 'unpersisted-draft') send({jsonrpc:'2.0',id:m.id,error:{code:-32004,message:'Session not found: unpersisted-draft'}})
  else send({jsonrpc:'2.0',id:m.id,result:{sessionId:m.params.sessionId,cwd:m.params.cwd}})
}
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}})
if(m.method==='session/prompt') send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
}})`)
    const manager = new AntigravityAgentManager()
    try {
      // Turn 1 creates ses-1
      const t1 = await manager.startTurn({ chatId: "c-a", cwd: projectA, content: "One", model: runtime.model, runtime, sessionToken: null })
      let token1 = ""
      for await (const e of t1.stream) if (e.type === "session_token" && e.sessionToken) token1 = e.sessionToken
      expect(token1).toBe("ses-1")

      // Turn 2 on same live chat with same sessionToken skips redundant session/resume
      const t2 = await manager.startTurn({ chatId: "c-a", cwd: projectA, content: "Two", model: runtime.model, runtime, sessionToken: token1 })
      for await (const _e of t2.stream) { /* drain */ }
      let calls = JSON.parse(readFileSync(callsFile, "utf8")) as Array<{ method: string; params: Record<string, any> }>
      expect(calls.filter(c => c.method === "session/resume")).toHaveLength(0)

      // Context-clear (sessionToken: null) retires ses-1 and creates ses-2 instead of resurrecting ses-1
      const t3 = await manager.startTurn({ chatId: "c-a", cwd: projectA, content: "Three", model: runtime.model, runtime, sessionToken: null })
      let token3 = ""
      for await (const e of t3.stream) if (e.type === "session_token" && e.sessionToken) token3 = e.sessionToken
      expect(token3).toBe("ses-2")

      // Cold resume on another chat in same cwd sends _meta.antigravity.systemPrompt; missing draft falls back to session/new
      const t4 = await manager.startTurn({ chatId: "c-a-cold", cwd: projectA, content: "Four", model: runtime.model, runtime, sessionToken: token3, systemPrompt: "Custom prompt" })
      for await (const _e of t4.stream) { /* drain */ }
      calls = JSON.parse(readFileSync(callsFile, "utf8"))
      const resumeCall = calls.find(c => c.method === "session/resume" && c.params.sessionId === token3)
      expect(resumeCall?.params._meta).toEqual({ antigravity: { systemPrompt: { append: "Custom prompt" } } })

      const tDraft = await manager.startTurn({ chatId: "c-a-draft", cwd: projectA, content: "Draft", model: runtime.model, runtime, sessionToken: "unpersisted-draft" })
      let draftToken = ""
      for await (const e of tDraft.stream) if (e.type === "session_token" && e.sessionToken) draftToken = e.sessionToken
      expect(draftToken).toMatch(/^ses-\d+$/)

      // Foreign session IDs (both manager-tracked from projectA and disk-listed from projectB) are blocked across cwd boundaries
      await expect(manager.startTurn({ chatId: "c-b", cwd: projectB, content: "Cross", model: runtime.model, runtime, sessionToken: token3 }))
        .rejects.toThrow("different project directory")
      await expect(manager.startTurn({ chatId: "c-foreign", cwd: projectA, content: "Foreign", model: runtime.model, runtime, sessionToken: "foreign-disk-session" }))
        .rejects.toThrow("different project directory")
    } finally { await manager.dispose() }
  }, 15000)

  it("F-16 / F-17 / F-12: scrubs non-*API_KEY secrets and endpoint overrides, discovers Antigravity install paths and .exe .cmd shims, and rejects connectionId", async () => {
    const dirtyEnv = {
      HOME: "/Users/dev",
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DATABASE_PASSWORD: "db-password",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "gho_secret",
      NPM_TOKEN: "npm_secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp-creds.json",
      CLOUD_CODE_URL: "https://evil.example.test",
      AGY_SESSION_ID: "parent-agy-session",
      AGY_PATH: "/custom/bin/agy",
      ANTIGRAVITY_CSRF_TOKEN: "csrf-secret",
      GIT_AUTHOR_NAME: "Dev",
      XAUTHORITY: "/tmp/.Xauthority",
    }
    const cleaned = cleanConnectionEnv(dirtyEnv)
    for (const secretKey of [
      "AWS_SECRET_ACCESS_KEY", "DATABASE_PASSWORD", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_CODE_URL", "AGY_SESSION_ID", "AGY_PATH", "ANTIGRAVITY_CSRF_TOKEN",
    ]) {
      expect(cleaned[secretKey]).toBeUndefined()
    }
    expect(cleaned.GIT_AUTHOR_NAME).toBe("Dev")
    expect(cleaned.XAUTHORITY).toBe("/tmp/.Xauthority")

    const probeEnv = executableEnvironment(dirtyEnv)
    expect(probeEnv.AGY_PATH).toBe("/custom/bin/agy")
    expect(probeEnv.GITHUB_TOKEN).toBeUndefined()
    expect(probeEnv.CLOUD_CODE_URL).toBeUndefined()
    expect(probeEnv.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
    expect(probeEnv.ANTIGRAVITY_CSRF_TOKEN).toBeUndefined()

    const root = mkdtempSync(join(tmpdir(), "memosync-agy-disc-")); roots.push(root)
    const dirs = await knownInstallDirectories({ HOME: root }, [], join(root, "runtime/bun"))
    expect(dirs).toContain(join(root, ".antigravity", "bin"))
    expect(dirs).toContain(join(root, ".gemini", "antigravity-cli", "bin"))

    const nativeExe = join(root, "Programs", "Antigravity", "agy.exe")
    const binDir = join(root, "Programs", "Antigravity", "bin")
    mkdirSyncCompat(binDir)
    writeFileSync(nativeExe, "#!/bin/sh\necho 1.5.18\n")
    chmodSync(nativeExe, 0o755)
    const cmdShim = join(binDir, "agy.cmd")
    writeFileSync(cmdShim, '@ECHO off\r\n"%~dp0\\..\\agy.exe" %*\r\n')
    const launched = await executableLauncher(cmdShim, { HOME: root, PATH: "" })
    expect(launched.args).toEqual([])
    expect(launched.command.endsWith("agy.exe")).toBe(true)

    const serviceDir = mkdtempSync(join(tmpdir(), "memosync-agy-svc-")); roots.push(serviceDir)
    const service = await new ModelAccessService({
      keyring: testKeyring,
      dataDir: serviceDir,
      env: { HOME: serviceDir, PATH: "" },
      readLegacyPi: async () => null,
      resolveExecutable: fakeExecutableResolver,
    }).initialize()
    expect(service.getSnapshot().hostPlatform).toBe(process.platform)
    await expect(resolveEngineRuntime({ engine: "antigravity", connectionId: "any-conn", service })).rejects.toThrow("engine-setup-invalid")
  })

  it("preserves memory exclusions and without_memory across Antigravity plan approval continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-plan-mem-")); roots.push(root)
    const promptsFile = join(root, "plan-prompts.jsonl")
    const readPrompts = () => readFileSync(promptsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { sessionId: string; mode: string; text: string })
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b='', n=0
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
let currentMode='default'
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'plan-mem-'+(++n)}})
if(m.method==='session/resume') send({jsonrpc:'2.0',id:m.id,result:{sessionId:m.params.sessionId}})
if(m.method==='session/set_config_option'){
  if(m.params.configId==='mode') currentMode=m.params.value
  send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
}
if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}})
if(m.method==='session/prompt'){
  const text = m.params.prompt.map(p => p.text).join('\\n')
  fs.appendFileSync(${JSON.stringify(promptsFile)}, JSON.stringify({ sessionId: m.params.sessionId, mode: currentMode, text }) + '\\n')
  if(currentMode==='plan'){
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'plan_update',plan:{type:'items',planId:'p1',entries:[{content:'Step 1',status:'pending',priority:'high'}]}}}})
  } else {
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Executed plan.'}}}})
  }
  send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
}}})`)
    const store = new EventStore(join(root, "events"))
    await store.initialize()
    const project = await store.openProject(root, "Plan Exclusion Project")
    const chat = await store.createChat(project.id)
    const chatWithout = await store.createChat(project.id)
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: join(root, "memory") })
    const kept = memory.store.create({
      content: "KEPT_MEMORY_RULE_ALPHA",
      type: "constraint",
      scope: "project",
      projectId: project.id,
    }, { actor: "user" })
    const excluded = memory.store.create({
      content: "EXCLUDED_MEMORY_RULE_BETA",
      type: "constraint",
      scope: "project",
      projectId: project.id,
    }, { actor: "user" })
    const antigravityManager = new AntigravityAgentManager()
    const coordinator = new AgentCoordinator({
      store,
      memory,
      antigravityManager,
      memoryBranches: false,
      memoryPreview: true,
      generateTitle: async () => ({ title: "Plan Chat", usedFallback: true, failureMessage: null }),
      onStateChange: () => {},
    })
    const bindRuntime = (chatId: string) => {
      ;(coordinator as any).sessionRuntimes.set(chatId, runtime)
      ;(coordinator as any).runtimeSelections.set(chatId, JSON.stringify(["antigravity", runtime.model, undefined, undefined]))
    }
    bindRuntime(chat.id)
    bindRuntime(chatWithout.id)
    try {
      // 1. User excludes `excluded` at preview, then approves the generated plan.
      await coordinator.send({ type: "chat.send", chatId: chat.id, provider: "antigravity", model: runtime.model, content: "Plan the refactor", planMode: true })
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const preview = store.getMessages(chat.id).find(m => m.kind === "memory_preview")
        if (preview) {
          expect(preview.memories.map(m => m.id)).toContain(excluded.id)
          await coordinator.respondMemoryPreview({ chatId: chat.id, previewId: preview.previewId, decision: "go_on", memoryIds: [kept.id] })
          break
        }
        await Bun.sleep(10)
      }
      while (Date.now() < deadline && coordinator.getPendingTool(chat.id)?.toolKind !== "exit_plan_mode") await Bun.sleep(10)
      const pendingPlan = coordinator.getPendingTool(chat.id)
      expect(pendingPlan?.toolKind).toBe("exit_plan_mode")
      await coordinator.respondTool({
        type: "chat.respondTool",
        chatId: chat.id,
        toolUseId: pendingPlan!.toolUseId,
        result: { confirmed: true },
      })
      while (Date.now() < deadline) {
        const results = store.getMessages(chat.id).filter(m => m.kind === "result")
        if (results.length >= 2) break
        await Bun.sleep(10)
      }
      let prompts = readPrompts()
      expect(prompts).toHaveLength(2)
      expect(prompts[0]!.mode).toBe("plan")
      expect(prompts[0]!.text).toContain("KEPT_MEMORY_RULE_ALPHA")
      expect(prompts[0]!.text).not.toContain("EXCLUDED_MEMORY_RULE_BETA")
      expect(prompts[1]!.mode).toBe("default")
      expect(prompts[1]!.text).toContain("Proceed with the approved plan.")
      expect(prompts[1]!.text).toContain("KEPT_MEMORY_RULE_ALPHA")
      expect(prompts[1]!.text).not.toContain("EXCLUDED_MEMORY_RULE_BETA")

      // 2. User selects without_memory at preview, then approves the plan.
      await coordinator.send({ type: "chat.send", chatId: chatWithout.id, provider: "antigravity", model: runtime.model, content: "Plan without memory", planMode: true })
      while (Date.now() < deadline) {
        const preview = store.getMessages(chatWithout.id).find(m => m.kind === "memory_preview")
        if (preview) {
          await coordinator.respondMemoryPreview({ chatId: chatWithout.id, previewId: preview.previewId, decision: "without_memory" })
          break
        }
        await Bun.sleep(10)
      }
      while (Date.now() < deadline && coordinator.getPendingTool(chatWithout.id)?.toolKind !== "exit_plan_mode") await Bun.sleep(10)
      const pendingWithout = coordinator.getPendingTool(chatWithout.id)
      expect(pendingWithout?.toolKind).toBe("exit_plan_mode")
      await coordinator.respondTool({
        type: "chat.respondTool",
        chatId: chatWithout.id,
        toolUseId: pendingWithout!.toolUseId,
        result: { confirmed: true },
      })
      while (Date.now() < deadline) {
        const results = store.getMessages(chatWithout.id).filter(m => m.kind === "result")
        if (results.length >= 2) break
        await Bun.sleep(10)
      }
      prompts = readPrompts()
      expect(prompts).toHaveLength(4)
      for (const prompt of prompts.slice(2)) {
        expect(prompt.text).not.toContain("KEPT_MEMORY_RULE_ALPHA")
        expect(prompt.text).not.toContain("EXCLUDED_MEMORY_RULE_BETA")
      }
    } finally {
      await coordinator.shutdownRuntime()
      memory.close()
    }
  }, 15000)

  it("keeps native slash commands leading in session/prompt when working memory is injected", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-slash-mem-")); roots.push(root)
    const promptsFile = join(root, "slash-prompts.json")
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
process.stdin.setEncoding('utf8')
let b=''
const prompts=[]
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new'){
  send({jsonrpc:'2.0',id:m.id,result:{sessionId:'slash-mem-session'}})
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'slash-mem-session',update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'plan',description:'Native plan'},{name:'review',description:'Review code'}]}}})
}
if(m.method==='session/resume') send({jsonrpc:'2.0',id:m.id,result:{sessionId:m.params.sessionId}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}})
if(m.method==='session/prompt'){
  prompts.push(m.params.prompt)
  fs.writeFileSync(${JSON.stringify(promptsFile)}, JSON.stringify(prompts))
  send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
}}})`)
    const manager = new AntigravityAgentManager()
    try {
      const t1 = await manager.startTurn({
        chatId: "cmd-mem",
        cwd: root,
        content: "/review src/index.ts",
        nativeCommand: true,
        memoryContext: "## Working Memory\n- [M-01] Keep strict types",
        model: runtime.model,
        runtime,
      })
      for await (const _e of t1.stream) { /* drain */ }

      const t2 = await manager.startTurn({
        chatId: "cmd-mem",
        cwd: root,
        content: "/Users/dev/project/file.ts explain this file",
        memoryContext: "## Working Memory\n- [M-01] Keep strict types",
        model: runtime.model,
        runtime,
        sessionToken: "slash-mem-session",
      })
      for await (const _e of t2.stream) { /* drain */ }

      const recorded = JSON.parse(readFileSync(promptsFile, "utf8")) as Array<Array<{ type: string; text: string }>>
      expect(recorded).toHaveLength(2)
      expect(recorded[0]).toEqual([
        { type: "text", text: "/review src/index.ts" },
        { type: "text", text: "## Working Memory\n- [M-01] Keep strict types" },
      ])
      expect(recorded[1]).toEqual([
        { type: "text", text: "## Working Memory\n- [M-01] Keep strict types\n\n/Users/dev/project/file.ts explain this file" },
      ])
    } finally { await manager.dispose() }

    // Also verify end-to-end command dispatcher routing with /native:plan and working memory.
    const store = new EventStore(join(root, "events"))
    await store.initialize()
    const project = await store.openProject(root, "Slash Dispatch Project")
    const chat = await store.createChat(project.id)
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: join(root, "memory") })
    memory.store.create({ content: "MEMORY_FOR_COMMAND_TURN", type: "constraint", scope: "project", projectId: project.id }, { actor: "user" })
    const coordManager = new AntigravityAgentManager()
    const coordinator = new AgentCoordinator({
      store,
      memory,
      antigravityManager: coordManager,
      memoryBranches: false,
      memoryPreview: false,
      generateTitle: async () => ({ title: "Slash Chat", usedFallback: true, failureMessage: null }),
      onStateChange: () => {},
    })
    ;(coordinator as any).sessionRuntimes.set(chat.id, runtime)
    ;(coordinator as any).runtimeSelections.set(chat.id, JSON.stringify(["antigravity", runtime.model, undefined, undefined]))
    try {
      await coordManager.prepareSession({ chatId: chat.id, cwd: root, model: runtime.model, runtime })
      await store.setChatProvider(chat.id, "antigravity")
      const catalog = await coordinator.readCommandCatalog(chat.id, true)
      const planCmd = catalog.commands.items.find(c => c.id === "native:plan")
      expect(planCmd).toBeDefined()
      await coordinator.executeCommand({
        type: "chat.executeCommand",
        chatId: chat.id,
        runtimeKey: catalog.runtimeKey!,
        expectedRevision: catalog.revision,
        commandId: planCmd!.id,
        arguments: "auth flow",
      })
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !store.getMessages(chat.id).some(m => m.kind === "result")) await Bun.sleep(10)
      const recorded = JSON.parse(readFileSync(promptsFile, "utf8")) as Array<Array<{ type: string; text: string }>>
      const last = recorded.at(-1)!
      expect(last[0]).toEqual({ type: "text", text: "/plan auth flow" })
      expect(last[1]?.text).toContain("MEMORY_FOR_COMMAND_TURN")
    } finally {
      await coordinator.shutdownRuntime()
      memory.close()
    }
  }, 15000)

  it.skipIf(process.platform === "win32")("cleans up detached descendant processes even when the CLI exits gracefully on session/close", async () => {
    const root = mkdtempSync(join(tmpdir(), "memosync-agy-tree-")); roots.push(root)
    const childPidFile = join(root, "descendant.pid")
    const runtime = writeAcpFixture(root, `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
process.stdin.setEncoding('utf8')
let b=''
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n')
const survivor = spawn('sh', ['-c', "trap '' TERM; sleep 60"], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(survivor.pid))
process.stdin.on('data',c=>{b+=c; for(let i=b.indexOf('\\n');i>=0;i=b.indexOf('\\n')){const line=b.slice(0,i); b=b.slice(i+1); if(!line.trim())continue; const m=JSON.parse(line); if(!m.method)continue
if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'tree-session'}})
if(m.method==='session/set_config_option') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}})
if(m.method==='session/close'){
  send({jsonrpc:'2.0',id:m.id,result:{}})
  process.exit(0)
}}})`)
    const manager = new AntigravityAgentManager()
    let descendantPid = 0
    try {
      await manager.prepareSession({ chatId: "tree-chat", cwd: root, model: runtime.model, runtime })
      descendantPid = Number(readFileSync(childPidFile, "utf8").trim())
      expect(Number.isInteger(descendantPid) && descendantPid > 1).toBe(true)
      // Confirm descendant is alive before closeChat.
      expect(() => process.kill(descendantPid, 0)).not.toThrow()
      await manager.closeChat("tree-chat")
      // Descendant in the detached process group must be terminated even though root exited on session/close.
      let alive = true
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        try { process.kill(descendantPid, 0) } catch { alive = false; break }
        await Bun.sleep(25)
      }
      expect(alive).toBe(false)
    } finally {
      if (descendantPid > 1) {
        try { process.kill(descendantPid, "SIGKILL") } catch {}
      }
      await manager.dispose()
    }
  }, 10000)
})

function mkdirSyncCompat(dir: string) {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs")
  mkdirSync(dir, { recursive: true })
}
