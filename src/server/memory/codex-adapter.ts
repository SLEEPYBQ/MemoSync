// Compile engine-neutral MemoryToolSpecs into Codex app-server "dynamic tools".
// These are declared in thread/start (thread inherits them across turns), and
// when the model calls one the app-server sends a server->client `item/tool/call`
// request that the harness answers via `dispatchMemoryTool`. (Kanna currently
// rejects all such calls with "Unsupported dynamic tool call" — P3 wiring
// replaces that with this dispatcher.)
import { z } from 'zod';
import type { MemoryToolSpec } from './tools';

/** A single Codex dynamic-tool declaration (subset of DynamicToolFunctionSpec). */
export interface CodexDynamicFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Declarations to pass as `dynamicTools` in thread/start. */
export function toCodexDynamicTools(specs: MemoryToolSpec[]): CodexDynamicFunctionSpec[] {
  return specs.map((s) => ({
    type: 'function',
    name: s.name,
    description: s.description,
    inputSchema: z.toJSONSchema(z.object(s.schema)) as Record<string, unknown>,
  }));
}

export { dispatchMemoryTool } from './tools';
export type { MemoryToolContext, MemoryToolResult, MemoryToolSpec } from './tools';
