// Compile engine-neutral MemoryToolSpecs into an in-process Claude Agent SDK
// MCP server. Tools surface to the model as `mcp__memory__<name>` — which
// Kanna's existing inbound classifier (shared/tools.ts mcp regex) already
// renders as `mcp_generic`, so no inbound changes are needed. `alwaysLoad`
// keeps them out of Claude's lazy tool-search so memory is always available.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { MemoryToolContext, MemoryToolSpec } from './tools';

export const MEMORY_MCP_SERVER_NAME = 'memory';

/**
 * Build the `mcpServers.memory` entry to pass into `query({ options })`.
 * `ctx` is captured per-turn (projectId/sessionId) so handlers scope correctly.
 */
export function toClaudeMemoryMcpServer(specs: MemoryToolSpec[], ctx: MemoryToolContext) {
  const tools = specs.map((s) =>
    tool(
      s.name,
      s.description,
      s.schema,
      async (args) => {
        const r = await s.handler(args as Record<string, unknown>, ctx);
        return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
      },
      { alwaysLoad: true },
    ),
  );
  return createSdkMcpServer({ name: MEMORY_MCP_SERVER_NAME, version: '1.0.0', tools });
}
